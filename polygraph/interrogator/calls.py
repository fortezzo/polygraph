"""Sending questions to the bot: the cache, the cost guard, the concurrency
limit and retries, in that order.

1. Cache: if the exact same conversation was asked before with the same
   settings, the saved reply comes back instantly and costs nothing.
2. Concurrency limit: only a few questions are on their way at once.
3. Cost guard: the most a question could cost is set aside before it's sent.
4. Retries: if the service is busy or the connection drops, wait and try
   again, waiting longer each time (exponential backoff, with a little
   randomness so many waiting questions don't all retry at the same moment).
"""

from __future__ import annotations

import asyncio
import datetime as dt
import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from polygraph.interrogator.cache import ResponseCache, cache_key
from polygraph.interrogator.costs import (
    CostGuard,
    CostLimitReached,
    estimate_tokens,
    typical_input_tokens,
    worst_case_input_tokens,
)
from polygraph.pricing import Prices
from polygraph.providers.base import ChatOptions, Message, Provider, ProviderError, Reply

# After this many questions fail in a row (each after its retries), something
# is badly wrong, so the run stops instead of hammering a broken service.
FAILURES_IN_A_ROW_LIMIT = 5


def now_iso() -> str:
    """The time right now, with this PC's time zone, like 2026-11-08T21:14:03-06:00."""
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


@dataclass(frozen=True)
class RetryPolicy:
    attempts: int = 5  # tries in total, the first one included
    first_wait: float = 1.0  # seconds before the first retry; doubles each time
    longest_wait: float = 30.0
    longest_requested_wait: float = 90.0  # cap on how long a provider can ask us to wait

    def wait(self, retry_number: int, requested: float | None = None, rng: random.Random | None = None) -> float:
        """Seconds to wait before retry number `retry_number` (1, 2, 3...)."""
        rng = rng or random
        backoff = min(self.longest_wait, self.first_wait * 2 ** (retry_number - 1))
        backoff = backoff / 2 + rng.uniform(0, backoff / 2)  # between half and all of it
        if requested is not None:
            backoff = max(backoff, min(requested, self.longest_requested_wait))
        return backoff


class RunAborted(Exception):
    """A problem that would fail every remaining question, so the run stops."""

    def __init__(self, problem: ProviderError, why: str | None = None) -> None:
        super().__init__(problem.message)
        self.problem = problem
        self.why = why


@dataclass(frozen=True)
class CallResult:
    reply: Reply
    from_cache: bool
    first_collected_at: str
    cost_usd: float  # spent in this run (0 when from the cache)
    attempts: int  # tries in this run (0 when from the cache)
    input_tokens: int | None
    output_tokens: int | None
    tokens_estimated: bool  # the provider didn't report token counts


@dataclass
class CallStats:
    replies: int = 0
    from_cache: int = 0
    fresh: int = 0
    retries: int = 0
    failures: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    spent_usd: float = 0.0
    model_versions: set[str] = field(default_factory=set)


class Caller:
    """Asks one model questions, safely. One Caller per run."""

    def __init__(
        self,
        provider: Provider,
        model: str,
        *,
        prices: Prices,
        guard: CostGuard,
        options: ChatOptions | None = None,
        cache: ResponseCache | None = None,
        read_cache: bool = True,
        concurrency: int = 4,
        system_prompt: str | None = None,
        version_pin: str | None = None,
        retry: RetryPolicy | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        clock: Callable[[], str] = now_iso,
        on_retry: Callable[[ProviderError, int, float], None] | None = None,
    ) -> None:
        self.provider = provider
        self.model = model
        self.prices = prices
        self.guard = guard
        self.options = options or ChatOptions()
        self.cache = cache
        self.read_cache = read_cache
        self.system_prompt = system_prompt
        self.version_pin = version_pin
        self.retry = retry or RetryPolicy()
        self._sleep = sleep
        self._clock = clock
        self._on_retry = on_retry
        self.concurrency = max(1, concurrency)
        self._slots = asyncio.Semaphore(self.concurrency)
        self._failures_in_a_row = 0
        self._stopped: CostLimitReached | RunAborted | None = None  # once set, no more questions go out
        self.stats = CallStats()

    def conversation(self, messages: list[Message]) -> list[Message]:
        """The full conversation as the model sees it, with the system prompt first."""
        if self.system_prompt:
            return [Message("system", self.system_prompt), *messages]
        return list(messages)

    def key(self, messages: list[Message], options: ChatOptions | None = None) -> str:
        return cache_key(
            self.provider.identity, self.model, self.conversation(messages), options or self.options, self.version_pin
        )

    def peek(self, messages: list[Message], options: ChatOptions | None = None) -> Reply | None:
        """The saved reply for this conversation, if there is one (for estimates)."""
        if self.cache is None or not self.read_cache:
            return None
        hit = self.cache.get(self.key(messages, options))
        return hit.reply if hit else None

    def stop(self, reason: CostLimitReached | RunAborted) -> None:
        """Send no more questions: every later ask() raises a copy of `reason`."""
        if self._stopped is None:
            self._stopped = reason

    def _raise_if_stopped(self) -> None:
        reason = self._stopped
        if isinstance(reason, CostLimitReached):
            raise CostLimitReached(reason.limit, reason.spent)
        if isinstance(reason, RunAborted):
            raise RunAborted(reason.problem, reason.why)

    async def ask(self, messages: list[Message], options: ChatOptions | None = None) -> CallResult:
        """Ask once. `options` overrides the Caller's settings for this question
        only (the judge uses a different reply shape for each trap type)."""
        self._raise_if_stopped()
        options = options or self.options
        conversation = self.conversation(messages)
        key = self.key(messages, options)
        if self.cache is not None and self.read_cache:
            hit = self.cache.get(key)
            if hit is not None:
                self._count(hit.reply, from_cache=True)
                return CallResult(
                    reply=hit.reply,
                    from_cache=True,
                    first_collected_at=hit.first_collected_at,
                    cost_usd=0.0,
                    attempts=0,
                    input_tokens=hit.reply.input_tokens,
                    output_tokens=hit.reply.output_tokens,
                    tokens_estimated=False,
                )

        async with self._slots:
            self._raise_if_stopped()
            most = self.prices.cost(worst_case_input_tokens(conversation), options.max_output_tokens)
            try:
                reservation = await self.guard.reserve(most)
            except CostLimitReached as limit:
                self.stop(limit)
                raise
            try:
                reply, attempts = await self._send(conversation, options)
            except BaseException:
                await self.guard.release(reservation)
                raise
            input_tokens, output_tokens, estimated = _tokens(reply, conversation)
            cost = self.prices.cost(input_tokens, output_tokens, reply.cache_write_tokens or 0)
            await self.guard.settle(reservation, cost)

        collected_at = self._clock()
        if self.cache is not None:
            self.cache.put(
                key, provider=self.provider.identity, model=self.model, reply=reply, first_collected_at=collected_at
            )
        self._count(reply, from_cache=False)
        self.stats.input_tokens += input_tokens
        self.stats.output_tokens += output_tokens
        self.stats.spent_usd += cost
        return CallResult(
            reply=reply,
            from_cache=False,
            first_collected_at=collected_at,
            cost_usd=cost,
            attempts=attempts,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            tokens_estimated=estimated,
        )

    async def _send(self, conversation: list[Message], options: ChatOptions) -> tuple[Reply, int]:
        attempt = 0
        while True:
            attempt += 1
            try:
                reply = await self.provider.chat(conversation, self.model, options)
            except ProviderError as problem:
                if problem.fatal:
                    aborted = RunAborted(problem)
                    self.stop(aborted)
                    raise aborted from problem
                if problem.retryable and attempt < self.retry.attempts:
                    wait = self.retry.wait(attempt, problem.retry_after)
                    self.stats.retries += 1
                    if self._on_retry is not None:
                        self._on_retry(problem, attempt, wait)
                    await self._sleep(wait)
                    continue
                self.stats.failures += 1
                self._failures_in_a_row += 1
                if self._failures_in_a_row >= FAILURES_IN_A_ROW_LIMIT:
                    aborted = RunAborted(problem, why=f"{FAILURES_IN_A_ROW_LIMIT} questions in a row failed")
                    self.stop(aborted)
                    raise aborted from problem
                raise
            self._failures_in_a_row = 0
            return reply, attempt

    def _count(self, reply: Reply, *, from_cache: bool) -> None:
        self.stats.replies += 1
        if from_cache:
            self.stats.from_cache += 1
        else:
            self.stats.fresh += 1
        if reply.model_version:
            self.stats.model_versions.add(reply.model_version)


def _tokens(reply: Reply, conversation: list[Message]) -> tuple[int, int, bool]:
    """Token counts for billing. If the provider didn't report them, estimate."""
    estimated = reply.input_tokens is None or reply.output_tokens is None
    input_tokens = reply.input_tokens if reply.input_tokens is not None else typical_input_tokens(conversation)
    output_tokens = reply.output_tokens if reply.output_tokens is not None else estimate_tokens(reply.text)
    return input_tokens, output_tokens, estimated
