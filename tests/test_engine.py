"""Tests for the parts of the interrogator that every question goes through:
reading the confidence number, the answer cache, cost tracking and the cost
guard, retries, and the concurrency limit. All offline and instant."""

from __future__ import annotations

import asyncio
import sqlite3

import pytest

from polygraph.interrogator import (
    Caller,
    CostGuard,
    CostLimitReached,
    Estimate,
    ResponseCache,
    RetryPolicy,
    RunAborted,
    cache_key,
    parse_confidence,
)
from polygraph.pricing import FREE, Prices, format_usd
from polygraph.providers import ChatOptions, Message, Provider, ProviderError, Reply

# --- Reading the confidence number ---------------------------------------------

CLEAR = [
    ("85", 85),
    ("85.", 85),
    ("  90\n", 90),
    ("85%", 85),
    ("85 %", 85),
    ("**85**", 85),
    ('"90"', 90),
    ("(90)", 90),
    ("85/100", 85),
    ("85 / 100", 85),
    ("85 out of 100", 85),
    ("100", 100),
    ("0", 0),
    ("100%!", 100),
    ("Confidence: 85", 85),
    ("Confidence level: 95%.", 95),
    ("My confidence level is 95.", 95),
    ("Rating: 70", 70),
    ("I'm 95% confident.", 95),
    ("I'm 100% confident the ball costs 5 cents.", 100),
    ("95 percent sure", 95),
    ("I am 90% certain that my answer is correct.", 90),
    ("My confidence is 85", 85),
    ("My confidence would be around 90.", 90),
    ("I'd say 90.", 90),
    ("I would rate it at 85%", 85),
    ("I'd put it at 95%.", 95),
    ("I'd give it a 90.", 90),
    ("On a scale from 0 to 100, I would rate my confidence as 90.", 90),
    ("On a scale of 0 to 100, I'd say 85.", 85),
    ("85 (on a scale from 0 to 100)", 85),
    ("85 (0-100)", 85),
    ("I rate this 90/100 because it is well documented.", 90),
    # Replies that repeat the scale from the question back.
    ("I would say 85, where 100 means I am sure my answer is right.", 85),
    ("On a scale from 0 to 100, 95.", 95),
]

UNCLEAR = [
    "",
    "I'm very confident.",
    "As an AI, I cannot give a confidence number.",
    "ninety",
    "Between 80 and 90",
    "80-90",
    "80 to 90",
    "I'm not 100% sure, but I'd say 90",
    "I'd say 90%, maybe 95%",
    "Switching gives 2/3, about 67%. I am 95% confident.",
    "I am 100% confident that it is Canberra and 0% that it is Sydney.",
    "9/10",
    "Confidence: 9/10",
    "8 out of 10",
    "0.9",
    "0.95",
    "Confidence: 0.95",
    "85.5",
    "1,000",
    "150",
    "-5",
    "5 cents.",
    "46 chromosomes",
    "I'd say 5 cents",
    "The chance is 50%.",
    "My answer is 100% correct.",
    "I'd say 90 because Canberra has been the capital since 1913",
    "95. Canberra has been the capital since 1913.",
    "I am confident at 90%",
    "100 means I am sure my answer is right",
    "0 means wrong, 100 means right: 90",
]


@pytest.mark.parametrize(("reply", "value"), CLEAR)
def test_a_clear_confidence_is_read(reply, value):
    assert parse_confidence(reply) == value


@pytest.mark.parametrize("reply", UNCLEAR)
def test_an_unclear_confidence_is_unknown_never_guessed(reply):
    assert parse_confidence(reply) is None


def test_no_reply_is_unknown():
    assert parse_confidence(None) is None


# --- The answer cache --------------------------------------------------------------

REPLY = Reply(
    text="Canberra.",
    model="m",
    seconds=1.5,
    input_tokens=10,
    output_tokens=3,
    finish_reason="stop",
    model_version="m-2026-01-01",
)
HELLO = [Message("user", "hello")]


def test_a_saved_reply_comes_back_with_when_it_was_collected(tmp_path):
    cache = ResponseCache(tmp_path)
    key = cache_key("openai", "m", HELLO, ChatOptions())
    cache.put(key, provider="openai", model="m", reply=REPLY, first_collected_at="2026-11-08T20:00:00-06:00")
    cache.close()

    hit = ResponseCache(tmp_path).get(key)  # a fresh connection: it was really saved

    assert hit.reply == REPLY
    assert hit.first_collected_at == "2026-11-08T20:00:00-06:00"


def test_anything_that_shapes_the_answer_changes_the_cache_key():
    base = cache_key("openai", "m", HELLO, ChatOptions())

    assert cache_key("openai", "m", HELLO, ChatOptions()) == base
    assert cache_key("anthropic", "m", HELLO, ChatOptions()) != base
    assert cache_key("openai", "m2", HELLO, ChatOptions()) != base
    assert cache_key("openai", "m", [Message("user", "hello!")], ChatOptions()) != base
    assert cache_key("openai", "m", HELLO, ChatOptions(max_output_tokens=10)) != base
    assert cache_key("openai", "m", HELLO, ChatOptions(temperature=0.0)) != base
    assert cache_key("openai", "m", HELLO, ChatOptions(), version_pin="digest-2") != base


def test_a_damaged_cache_is_set_aside_not_fatal(tmp_path):
    (tmp_path / "responses.sqlite3").write_bytes(b"this is not a database at all" * 100)

    cache = ResponseCache(tmp_path)

    assert cache.get("anything") is None
    assert cache.notice and "damaged" in cache.notice
    assert any(p.name.startswith("responses.sqlite3.damaged-") for p in tmp_path.iterdir())


def test_the_cache_is_a_plain_sqlite_file(tmp_path):
    cache = ResponseCache(tmp_path)
    cache.put("k", provider="ollama", model="llama3.2", reply=REPLY, first_collected_at="2026-11-08T20:00:00-06:00")
    cache.close()

    rows = sqlite3.connect(tmp_path / "responses.sqlite3").execute("SELECT provider, model FROM replies").fetchall()

    assert rows == [("ollama", "llama3.2")]


# --- Costs and the cost guard ----------------------------------------------------


def test_cost_math():
    prices = Prices(input_per_million=2.0, output_per_million=10.0)

    assert prices.cost(1_000_000, 0) == pytest.approx(2.0)
    assert prices.cost(500, 1_000) == pytest.approx(0.011)
    assert FREE.cost(10**9, 10**9) == 0
    assert FREE.free and not prices.free


@pytest.mark.parametrize(
    ("amount", "shown"), [(None, "unknown"), (0, "$0.00"), (0.0004, "$0.0004"), (0.123, "$0.12"), (2, "$2.00")]
)
def test_money_is_shown_without_hiding_tiny_amounts(amount, shown):
    assert format_usd(amount) == shown


def test_the_guard_lets_questions_through_while_they_fit():
    async def scenario():
        guard = CostGuard(1.00)
        first = await guard.reserve(0.40)
        await guard.settle(first, 0.10)
        second = await guard.reserve(0.80)
        await guard.release(second)
        return guard

    guard = asyncio.run(scenario())

    assert guard.spent == pytest.approx(0.10)
    assert guard.reserved == pytest.approx(0.0)


def test_the_guard_refuses_a_question_that_could_break_the_limit():
    async def scenario():
        guard = CostGuard(1.00)
        await guard.settle(await guard.reserve(0.70), 0.70)
        await guard.reserve(0.31)

    with pytest.raises(CostLimitReached):
        asyncio.run(scenario())


def test_the_guard_waits_for_questions_on_their_way_instead_of_stopping():
    async def scenario():
        guard = CostGuard(1.00)
        first = await guard.reserve(0.60)  # on its way, could cost up to 0.60
        waiting = asyncio.create_task(guard.reserve(0.60))  # doesn't fit yet
        await asyncio.sleep(0)
        assert not waiting.done()
        await guard.settle(first, 0.05)  # it came back cheap
        await asyncio.wait_for(waiting, timeout=1)
        return guard

    guard = asyncio.run(scenario())

    assert guard.spent == pytest.approx(0.05)
    assert guard.reserved == pytest.approx(0.60)


def test_the_suggested_limit_leaves_room_to_finish():
    estimate = Estimate(
        typical_input_tokens=1_000_000,
        typical_output_tokens=200_000,
        worst_single_call_usd=0.33,
        prices=Prices(2.0, 10.0),
    )

    assert estimate.typical_usd == pytest.approx(4.0)
    # 4.00 x 1.25 + 0.33 = 5.33, rounded up to the next 50 cents.
    assert estimate.suggested_limit() == 5.5


# --- Retries --------------------------------------------------------------------


def test_waits_grow_but_stay_capped():
    policy = RetryPolicy(first_wait=1.0, longest_wait=30.0)

    for retry, top in [(1, 1.0), (2, 2.0), (3, 4.0), (6, 30.0), (12, 30.0)]:
        wait = policy.wait(retry)
        assert top / 2 <= wait <= top


def test_a_requested_wait_is_respected_but_capped():
    policy = RetryPolicy(first_wait=1.0, longest_requested_wait=90.0)

    assert policy.wait(1, requested=20.0) >= 20.0
    assert policy.wait(1, requested=10_000.0) == 90.0


# --- The caller: cache, guard, slots and retries together ---------------------------


class ScriptedBot(Provider):
    """A fake bot that answers (or fails) from a script, and counts calls."""

    name = "scripted"
    label = "Scripted"

    def __init__(self, script=None, delay=0.0):
        self.script = list(script or [])
        self.delay = delay
        self.calls = 0
        self.in_flight = 0
        self.most_in_flight = 0

    async def chat(self, messages, model, options=None):
        self.calls += 1
        self.in_flight += 1
        self.most_in_flight = max(self.most_in_flight, self.in_flight)
        try:
            await asyncio.sleep(self.delay)
            step = self.script.pop(0) if self.script else None
            if isinstance(step, Exception):
                raise step
            return step or Reply(text=f"reply {self.calls}", model=model, seconds=0.01, input_tokens=100, output_tokens=50)
        finally:
            self.in_flight -= 1


def make_caller(bot, tmp_path=None, *, prices=FREE, limit=2.0, **kwargs):
    waits = []

    async def no_sleep(seconds):
        waits.append(seconds)

    cache = ResponseCache(tmp_path) if tmp_path is not None else None
    caller = Caller(bot, "model-x", prices=prices, guard=CostGuard(limit), cache=cache, sleep=no_sleep, **kwargs)
    return caller, waits


def busy():
    return ProviderError("Busy.", kind="overloaded")


def test_a_cached_reply_costs_nothing_and_skips_the_bot(tmp_path):
    bot = ScriptedBot()
    clock = iter(["2026-11-08T10:00:00-06:00", "2026-11-08T11:00:00-06:00"])

    async def scenario():
        caller, _ = make_caller(bot, tmp_path, prices=Prices(1.0, 1.0), clock=lambda: next(clock))
        first = await caller.ask(HELLO)
        second = await caller.ask(HELLO)
        return first, second

    first, second = asyncio.run(scenario())

    assert bot.calls == 1
    assert not first.from_cache and first.cost_usd > 0
    assert second.from_cache and second.cost_usd == 0 and second.attempts == 0
    assert second.reply.text == first.reply.text
    # The saved reply remembers when it was really collected.
    assert second.first_collected_at == first.first_collected_at == "2026-11-08T10:00:00-06:00"


def test_fresh_mode_asks_again_but_still_saves(tmp_path):
    bot = ScriptedBot()

    async def scenario():
        caller, _ = make_caller(bot, tmp_path)
        await caller.ask(HELLO)
        fresh, _ = make_caller(bot, tmp_path, read_cache=False)
        again = await fresh.ask(HELLO)
        later, _ = make_caller(bot, tmp_path)
        return again, await later.ask(HELLO)

    again, later = asyncio.run(scenario())

    assert bot.calls == 2
    assert not again.from_cache
    assert later.from_cache and later.reply.text == "reply 2"  # the newest answer is the one kept


def test_a_busy_service_is_retried_with_growing_waits():
    bot = ScriptedBot([busy(), busy(), None])
    seen = []

    async def scenario():
        caller, waits = make_caller(bot, on_retry=lambda problem, attempt, wait: seen.append(attempt))
        return await caller.ask(HELLO), waits, caller

    result, waits, caller = asyncio.run(scenario())

    assert result.reply.text == "reply 3"
    assert result.attempts == 3
    assert len(waits) == 2 and waits[1] > waits[0] * 0.5
    assert seen == [1, 2]
    assert caller.stats.retries == 2


def test_a_wait_the_service_asks_for_is_honored():
    bot = ScriptedBot([ProviderError("Slow down.", kind="rate_limit", retry_after=20.0), None])

    async def scenario():
        caller, waits = make_caller(bot)
        await caller.ask(HELLO)
        return waits

    assert asyncio.run(scenario())[0] >= 20.0


def test_it_gives_up_after_the_last_try():
    bot = ScriptedBot([busy()] * 5)

    async def scenario():
        caller, _ = make_caller(bot)
        await caller.ask(HELLO)

    with pytest.raises(ProviderError):
        asyncio.run(scenario())
    assert bot.calls == 5


def test_a_bad_key_stops_everything_at_once():
    bot = ScriptedBot([ProviderError("Bad key.", kind="auth")])

    async def scenario():
        caller, _ = make_caller(bot)
        with pytest.raises(RunAborted):
            await caller.ask(HELLO)
        with pytest.raises(RunAborted):
            await caller.ask([Message("user", "something else")])

    asyncio.run(scenario())
    assert bot.calls == 1  # never retried, and nothing else was sent


def test_five_failures_in_a_row_stop_the_run():
    bot = ScriptedBot([ProviderError("Bad request.", kind="bad_request")] * 10)

    async def scenario():
        caller, _ = make_caller(bot)
        for number in range(4):
            with pytest.raises(ProviderError):
                await caller.ask([Message("user", f"question {number}")])
        with pytest.raises(RunAborted) as caught:
            await caller.ask([Message("user", "question 5")])
        return caught.value

    aborted = asyncio.run(scenario())

    assert "5 questions in a row failed" in aborted.why
    assert bot.calls == 5


def test_the_cost_limit_stops_questions_before_they_are_sent():
    bot = ScriptedBot()
    # Each question could cost up to (input + 1,000 output tokens) at $1,000 per million: about $1.
    pricey = Prices(1_000.0, 1_000.0)

    async def scenario():
        caller, _ = make_caller(bot, prices=pricey, limit=0.50, options=ChatOptions(max_output_tokens=1_000))
        with pytest.raises(CostLimitReached):
            await caller.ask(HELLO)
        with pytest.raises(CostLimitReached):
            await caller.ask([Message("user", "another")])
        return caller

    caller = asyncio.run(scenario())

    assert bot.calls == 0
    assert caller.guard.spent == 0


def test_spending_is_tracked_from_the_reported_tokens():
    bot = ScriptedBot([Reply(text="ok", model="m", seconds=0.1, input_tokens=1_000, output_tokens=2_000)])

    async def scenario():
        caller, _ = make_caller(bot, prices=Prices(1.0, 2.0))
        result = await caller.ask(HELLO)
        return caller, result

    caller, result = asyncio.run(scenario())

    assert result.cost_usd == pytest.approx((1_000 * 1.0 + 2_000 * 2.0) / 1_000_000)
    assert caller.guard.spent == pytest.approx(result.cost_usd)
    assert caller.stats.input_tokens == 1_000 and caller.stats.output_tokens == 2_000


def test_missing_token_counts_are_estimated_not_skipped():
    bot = ScriptedBot([Reply(text="x" * 400, model="m", seconds=0.1)])

    async def scenario():
        caller, _ = make_caller(bot, prices=Prices(1.0, 1.0))
        return await caller.ask(HELLO)

    result = asyncio.run(scenario())

    assert result.tokens_estimated
    assert result.output_tokens == 100 and result.cost_usd > 0


def test_only_a_few_questions_are_on_their_way_at_once():
    bot = ScriptedBot(delay=0.01)

    async def scenario():
        caller, _ = make_caller(bot, concurrency=3)
        await asyncio.gather(*(caller.ask([Message("user", f"q{n}")]) for n in range(12)))

    asyncio.run(scenario())

    assert bot.calls == 12
    assert bot.most_in_flight == 3


def test_the_system_prompt_goes_first_and_is_part_of_the_cache_key(tmp_path):
    seen = []

    class Watcher(ScriptedBot):
        async def chat(self, messages, model, options=None):
            seen.append(messages)
            return await super().chat(messages, model, options)

    bot = Watcher()

    async def scenario():
        plain, _ = make_caller(bot, tmp_path)
        await plain.ask(HELLO)
        bot_prompt, _ = make_caller(bot, tmp_path, system_prompt="You are Bob's Pizza's support bot.")
        return await bot_prompt.ask(HELLO)

    result = asyncio.run(scenario())

    assert not result.from_cache
    assert seen[1][0] == Message("system", "You are Bob's Pizza's support bot.")
