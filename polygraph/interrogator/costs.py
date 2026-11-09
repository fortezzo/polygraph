"""Cost tracking and the cost guard.

Before a run, Polygraph estimates what it will cost. During the run, the guard
keeps a running total. Before every single question it sets aside the most that
question could possibly cost (as if the answer used every token it's allowed),
and only sends it if the total still can't go over the limit. If other
questions are still on their way, it waits for them to come back first. If even
one more question could break the limit, the run stops. So a run stops before
it could spend more than the limit, never after.
"""

from __future__ import annotations

import asyncio
import math
from dataclasses import dataclass

from polygraph.pricing import FREE, Prices, format_usd
from polygraph.providers.base import Message

__all__ = ["FREE", "CostGuard", "CostLimitReached", "Estimate", "Prices", "format_usd"]

DEFAULT_LIMIT_USD = 2.00

# Rough sizes, used only for estimates. English text averages about 4
# characters per token. The worst case assumes 2, which English text never needs.
CHARS_PER_TOKEN = 4
WORST_CHARS_PER_TOKEN = 2
TOKENS_PER_MESSAGE = 8  # each message adds a few tokens of formatting
# How long answers usually are, for the "about $X" estimate.
TYPICAL_ANSWER_TOKENS = 500
TYPICAL_CONFIDENCE_TOKENS = 20
# Models that think before answering spend extra (hidden, but billed) tokens.
TYPICAL_THINKING_TOKENS = 1500
TYPICAL_CONFIDENCE_THINKING_TOKENS = 300


class CostLimitReached(Exception):
    """Sending another question could take the run over its cost limit."""

    def __init__(self, limit: float, spent: float) -> None:
        super().__init__(f"Stopped before going over the ${limit:.2f} cost limit (spent {format_usd(spent)}).")
        self.limit = limit
        self.spent = spent


class CostGuard:
    """Keeps the running total and never lets a question break the limit."""

    def __init__(self, limit_usd: float = DEFAULT_LIMIT_USD) -> None:
        self.limit = limit_usd
        self.spent = 0.0
        self.reserved = 0.0  # set aside for questions that are on their way
        self._changed = asyncio.Condition()

    def _fits(self, amount: float, *, counting_reserved: bool) -> bool:
        total = self.spent + amount + (self.reserved if counting_reserved else 0.0)
        return total <= self.limit + 1e-12

    async def reserve(self, most_it_could_cost: float) -> float:
        """Set aside the most a question could cost. Waits while other questions
        are on their way if they leave too little room, and raises
        CostLimitReached if there would be too little room even without them."""
        async with self._changed:
            while True:
                if not self._fits(most_it_could_cost, counting_reserved=False):
                    raise CostLimitReached(self.limit, self.spent)
                if self._fits(most_it_could_cost, counting_reserved=True):
                    self.reserved += most_it_could_cost
                    return most_it_could_cost
                await self._changed.wait()

    async def settle(self, reservation: float, actual: float) -> None:
        """The question came back: swap what was set aside for what it really cost."""
        async with self._changed:
            self.reserved = max(0.0, self.reserved - reservation)
            self.spent += actual
            self._changed.notify_all()

    async def release(self, reservation: float) -> None:
        """The question failed and cost nothing: give back what was set aside."""
        async with self._changed:
            self.reserved = max(0.0, self.reserved - reservation)
            self._changed.notify_all()


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def conversation_chars(messages: list[Message]) -> int:
    return sum(len(m.content) for m in messages)


def worst_case_input_tokens(messages: list[Message]) -> int:
    """More tokens than this conversation could possibly be."""
    return math.ceil(conversation_chars(messages) / WORST_CHARS_PER_TOKEN) + TOKENS_PER_MESSAGE * len(messages) + 32


def typical_input_tokens(messages: list[Message]) -> int:
    return math.ceil(conversation_chars(messages) / CHARS_PER_TOKEN) + TOKENS_PER_MESSAGE * len(messages)


@dataclass
class Estimate:
    """What a run is expected to cost, before it starts."""

    calls: int = 0  # questions the run will send (answers + confidence checks)
    cached_calls: int = 0  # of those, how many are already saved from earlier runs
    typical_input_tokens: int = 0
    typical_output_tokens: int = 0
    worst_input_tokens: int = 0
    worst_output_tokens: int = 0
    worst_single_call_usd: float = 0.0  # the most any one question could cost
    prices: Prices | None = None  # None: the price isn't known

    @property
    def calls_to_send(self) -> int:
        return self.calls - self.cached_calls

    @property
    def typical_usd(self) -> float | None:
        if self.prices is None:
            return None
        return self.prices.cost(self.typical_input_tokens, self.typical_output_tokens)

    @property
    def worst_usd(self) -> float | None:
        if self.prices is None:
            return None
        return self.prices.cost(self.worst_input_tokens, self.worst_output_tokens)

    def suggested_limit(self) -> float:
        """A limit that lets a typical run finish: the estimate plus a quarter,
        plus room for one more worst-case question (the guard needs that room
        free before it sends anything), rounded up to the next 50 cents."""
        typical = self.typical_usd or 0.0
        needed = typical * 1.25 + self.worst_single_call_usd
        return max(DEFAULT_LIMIT_USD, math.ceil(needed * 2) / 2)
