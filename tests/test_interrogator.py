"""Tests for the interrogator: that every trap type is asked the way PLAN.md
describes, that the run file holds everything, and that runs stop cleanly.

The bot here is fake: it answers instantly and records every conversation it
was sent, so the tests can check exactly what a real bot would have seen.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from polygraph.config import Secret
from polygraph.interrogator import (
    CONFIDENCE_QUESTION,
    Caller,
    CostGuard,
    Interrogator,
    ResponseCache,
    RunListener,
    plan_conversations,
)
from polygraph.pricing import FREE, Prices
from polygraph.providers import Message, OpenAIProvider, Provider, ProviderError, Reply
from polygraph.runfile import Target, load_run
from polygraph.traps import load_library

LIBRARY = load_library()


def trap(trap_id):
    return LIBRARY.find(trap_id)


class RecordingBot(Provider):
    """Answers every question, says it's 90% confident, and records everything."""

    name = "recording"
    label = "Recording bot"
    local = True

    def __init__(self, version="bot-v1", confidence="90", fail_on=None):
        self.version = version
        self.confidence = confidence
        self.fail_on = fail_on or {}
        self.conversations: list[list[Message]] = []

    async def chat(self, messages, model, options=None):
        self.conversations.append(list(messages))
        await asyncio.sleep(0)
        last = messages[-1].content
        for text, problem in self.fail_on.items():
            if text in last:
                raise problem
        if last == CONFIDENCE_QUESTION:
            text = self.confidence
        else:
            text = f"My answer to: {last[:50]}"
        return Reply(
            text=text, model=model, seconds=0.01, input_tokens=100, output_tokens=40, finish_reason="stop",
            model_version=self.version,
        )

    def asked(self, needle):
        """Every conversation whose last message contains `needle`."""
        return [c for c in self.conversations if needle in c[-1].content]


def interrogator_for(bot, traps, tmp_path, *, prices=FREE, limit=2.0, read_cache=True, listener=None, concurrency=4):
    cache = ResponseCache(tmp_path / "cache")
    caller = Caller(
        bot, "test-model", prices=prices, guard=CostGuard(limit), cache=cache, read_cache=read_cache,
        concurrency=concurrency,
    )
    target = Target(provider=bot.name, provider_label=bot.label, model="test-model")
    return Interrogator(
        caller=caller,
        library=LIBRARY,
        traps=traps,
        target=target,
        limit_usd=limit,
        prices=prices,
        concurrency=concurrency,
        listener=listener or RunListener(),
    ), cache


def run(bot, traps, tmp_path, **kwargs):
    interrogator, cache = interrogator_for(bot, traps, tmp_path, **kwargs)
    try:
        run_file = asyncio.run(interrogator.run(save_folder=tmp_path / "runs"))
    finally:
        cache.close()
    return run_file, interrogator


# --- How each trap type is asked ---------------------------------------------------


def test_a_pressure_test_pushes_back_after_the_answer(tmp_path):
    bot = RecordingBot()
    pressure = trap("pressure-001")
    run_file, _ = run(bot, [pressure], tmp_path)

    question, push_back = pressure.question, pressure.follow_ups[0]
    first_answer = f"My answer to: {question[:50]}"
    # The push-back conversation: the question, the bot's answer, then the push-back.
    assert bot.asked(push_back) == [
        [Message("user", question), Message("assistant", first_answer), Message("user", push_back)]
    ]
    turns = run_file.traps[0].conversations[0].turns
    assert [(t.role, t.kind) for t in turns] == [
        ("user", "question"),
        ("assistant", "answer"),
        ("user", "push_back"),
        ("assistant", "answer"),
    ]
    assert turns[2].content == push_back


def test_the_confidence_question_follows_every_answer_but_stays_out_of_the_conversation(tmp_path):
    bot = RecordingBot()
    pressure = trap("pressure-001")
    run_file, _ = run(bot, [pressure], tmp_path)

    probes = bot.asked(CONFIDENCE_QUESTION)
    assert len(probes) == 2  # one after each answer
    # Each probe is a side copy: the conversation so far, plus the question.
    assert [len(p) for p in sorted(probes, key=len)] == [3, 5]
    # No conversation the bot answered for real ever contained the confidence question.
    for conversation in bot.conversations:
        assert all(m.content != CONFIDENCE_QUESTION for m in conversation[:-1])
    answers = [t for t in run_file.traps[0].conversations[0].turns if t.kind == "answer"]
    assert [a.confidence.value for a in answers] == [90, 90]
    assert all(a.confidence.reply == "90" for a in answers)


def test_consistency_asks_each_wording_in_a_fresh_conversation(tmp_path):
    bot = RecordingBot()
    consistency = trap("consistency-001")
    run_file, _ = run(bot, [consistency], tmp_path)

    first_messages = [c for c in bot.conversations if len(c) == 1]
    assert sorted(c[0].content for c in first_messages) == sorted(consistency.wordings())
    chats = run_file.traps[0].conversations
    assert [chat.wording for chat in chats] == [1, 2, 3, 4]
    assert [chat.turns[0].content for chat in chats] == consistency.wordings()
    assert all(len(chat.turns) == 2 for chat in chats)
    assert all(chat.turns[1].confidence.value == 90 for chat in chats)


def test_a_document_question_comes_with_the_document(tmp_path):
    bot = RecordingBot()
    question = trap("document-004")
    document = LIBRARY.documents[question.document]
    run_file, _ = run(bot, [question], tmp_path)

    sent = run_file.traps[0].conversations[0].turns[0].content
    assert document.text.strip() in sent
    assert sent.endswith(f"My question: {question.question}")
    assert "using only the information in this document" in sent
    assert "(fictional)" not in sent  # the bot never sees the label
    assert run_file.documents[question.document].title == document.title


@pytest.mark.parametrize("trap_id", ["ghost-001", "premise-001", "citation-001", "limits-001", "number-001"])
def test_other_traps_ask_the_question_once(trap_id, tmp_path):
    bot = RecordingBot()
    run_file, _ = run(bot, [trap(trap_id)], tmp_path)

    turns = run_file.traps[0].conversations[0].turns
    assert [(t.role, t.kind) for t in turns] == [("user", "question"), ("assistant", "answer")]
    assert turns[0].content == trap(trap_id).question
    assert turns[1].confidence.value == 90


def test_the_full_library_plan():
    plans = {t.id: plan_conversations(t, LIBRARY.documents) for t in LIBRARY.traps}
    answers = sum(len(plan.turns) for trap_plans in plans.values() for plan in trap_plans)

    assert len(plans) == 80
    assert answers == 120  # so a full run sends 240 messages: 120 answers + 120 confidence questions


def test_an_unclear_confidence_is_saved_as_unknown_with_the_exact_reply(tmp_path):
    bot = RecordingBot(confidence="Pretty sure, maybe 80 or 90?")
    run_file, _ = run(bot, [trap("ghost-001")], tmp_path)

    confidence = run_file.traps[0].conversations[0].turns[1].confidence
    assert confidence.value is None
    assert confidence.reply == "Pretty sure, maybe 80 or 90?"
    assert run_file.run.counts.confidence_unknown == 1
    assert run_file.run.counts.confidence_ratings == 0


# --- The run file ------------------------------------------------------------------


def test_a_full_run_saves_a_complete_run_file(tmp_path):
    bot = RecordingBot()
    run_file, interrogator = run(bot, LIBRARY.traps, tmp_path)

    saved = load_run(interrogator.saved_path)  # it loads back, and matches the format
    info = saved.run
    assert info.status == "finished"
    assert info.trap_set.version == LIBRARY.fingerprint
    assert info.trap_set.traps_in_run == 80
    assert info.counts.answers == 120
    assert info.counts.confidence_ratings == 120
    assert info.counts.replies == 240 == len(bot.conversations)
    assert info.counts.traps_done == 80
    assert info.duration_seconds is not None and info.finished_at is not None
    assert info.prompts.confidence_question == CONFIDENCE_QUESTION
    assert info.target.model_version == "bot-v1"
    assert info.target.model_versions_seen == ["bot-v1"]
    assert info.judge is None
    # Judging is Session 4: verdicts and scores are empty.
    assert all(t.verdict is None and t.made_up_phrase is None and t.reason is None for t in saved.traps)
    assert saved.scores.overall is None and saved.scores.grade is None and saved.scores.margin_of_error is None
    assert set(saved.scores.by_type) == {t.kind.value for t in LIBRARY.traps}
    assert all(value is None for value in saved.scores.by_type.values())
    # Every trap is copied in exactly as it was asked, truth and source included.
    for result, original in zip(saved.traps, LIBRARY.traps):
        assert result.trap == original.model_dump(mode="json")
        assert result.trap["truth"] and result.trap["source"]["title"]


def test_every_reply_records_its_exact_version_and_when_it_was_collected(tmp_path):
    run_file, _ = run(RecordingBot(), [trap("pressure-001")], tmp_path)

    for turn in run_file.traps[0].conversations[0].turns:
        if turn.kind == "answer":
            for call in (turn.call, turn.confidence.call):
                assert call.model_version == "bot-v1"
                assert call.from_cache is False
                assert call.first_collected_at.startswith("20")


def test_a_rerun_uses_saved_answers_and_marks_them(tmp_path):
    first, _ = run(RecordingBot(), [trap("pressure-001"), trap("consistency-002")], tmp_path)
    bot = RecordingBot()
    second, interrogator = run(bot, [trap("pressure-001"), trap("consistency-002")], tmp_path)

    assert bot.conversations == []  # nothing was asked again
    # Pressure: 2 answers + 2 confidence replies. Consistency: 4 + 4.
    assert second.run.counts.from_cache == second.run.counts.replies == 12
    assert second.run.cost.spent_usd == 0
    for old, new in zip(first.traps, second.traps):
        for old_chat, new_chat in zip(old.conversations, new.conversations):
            for old_turn, new_turn in zip(old_chat.turns, new_chat.turns):
                if new_turn.kind == "answer":
                    assert new_turn.call.from_cache is True
                    # The date it was first collected, from the first run.
                    assert new_turn.call.first_collected_at == old_turn.call.first_collected_at
                    assert new_turn.content == old_turn.content


def test_the_estimate_knows_what_is_already_saved(tmp_path):
    traps = [trap("pressure-001"), trap("ghost-001")]
    before, _ = interrogator_for(RecordingBot(), traps, tmp_path)
    estimate = before.estimate()
    assert (estimate.calls, estimate.cached_calls) == (6, 0)
    before.caller.cache.close()

    run(RecordingBot(), traps, tmp_path)

    after, cache = interrogator_for(RecordingBot(), traps + [trap("limits-001")], tmp_path)
    estimate = after.estimate()
    cache.close()
    assert (estimate.calls, estimate.cached_calls) == (8, 6)


def test_versions_seen_reveal_answers_from_an_older_model_version(tmp_path):
    run(RecordingBot(version="v1"), [trap("ghost-001")], tmp_path)
    run_file, _ = run(RecordingBot(version="v2"), [trap("ghost-001"), trap("ghost-002")], tmp_path)

    assert run_file.run.target.model_versions_seen == ["v1", "v2"]


# --- Stopping cleanly ----------------------------------------------------------------


def test_the_cost_limit_stops_the_run_and_never_goes_over(tmp_path):
    bot = RecordingBot()
    # Each reply really costs (100 in + 40 out) at these prices: about $0.0018.
    # The guard sets aside up to ~$0.05 per question first (4,096 tokens out).
    prices = Prices(input_per_million=10.0, output_per_million=12.0)
    run_file, interrogator = run(bot, LIBRARY.traps, tmp_path, prices=prices, limit=0.10)

    info = run_file.run
    assert info.status == "stopped"
    assert "cost limit" in info.stop_reason
    assert info.cost.spent_usd <= 0.10
    assert info.counts.traps_stopped > 0
    assert any(t.status == "done" for t in run_file.traps)
    assert interrogator.saved_path.exists()


def test_a_bad_key_fails_the_run_fast_and_still_saves_it(tmp_path):
    bot = RecordingBot(fail_on={"": ProviderError("OpenAI didn't accept the API key.", kind="auth")})
    run_file, interrogator = run(bot, LIBRARY.traps, tmp_path)

    assert run_file.run.status == "failed"
    assert "didn't accept the API key" in run_file.run.stop_reason
    assert len(bot.conversations) <= 4  # only what was already on its way
    assert interrogator.aborted is not None
    assert load_run(interrogator.saved_path).run.status == "failed"


def test_one_failing_trap_doesnt_stop_the_others(tmp_path):
    failing = trap("ghost-002")
    bot = RecordingBot(fail_on={failing.question[:30]: ProviderError("Refused as written.", kind="bad_request")})
    run_file, _ = run(bot, [trap("ghost-001"), failing, trap("ghost-003")], tmp_path)

    statuses = {t.id: (t.status, t.error) for t in run_file.traps}
    assert statuses["ghost-002"] == ("error", "Refused as written.")
    assert statuses["ghost-001"][0] == statuses["ghost-003"][0] == "done"
    assert run_file.run.status == "finished"
    assert run_file.run.counts.traps_with_errors == 1


def test_a_failed_confidence_question_is_noted_and_the_answer_kept(tmp_path):
    bot = RecordingBot(fail_on={CONFIDENCE_QUESTION: ProviderError("Refused.", kind="bad_request")})
    run_file, _ = run(bot, [trap("ghost-001")], tmp_path)

    answer = run_file.traps[0].conversations[0].turns[1]
    assert run_file.traps[0].status == "done"
    assert answer.content.startswith("My answer to:")
    assert answer.confidence.value is None and answer.confidence.reply is None
    assert "Refused." in answer.confidence.error
    assert run_file.run.counts.confidence_missing == 1


def test_cancelling_a_run_saves_what_was_finished(tmp_path):
    class StuckBot(RecordingBot):
        stuck: asyncio.Event

        async def chat(self, messages, model, options=None):
            if len(self.conversations) >= 6:
                self.stuck.set()
                await asyncio.sleep(30)  # stuck: the run gets cancelled while waiting
            return await super().chat(messages, model, options)

    bot = StuckBot()
    interrogator, cache = interrogator_for(bot, LIBRARY.traps, tmp_path, concurrency=1)

    async def cancel_while_stuck():
        bot.stuck = asyncio.Event()
        task = asyncio.create_task(interrogator.run(save_folder=tmp_path / "runs"))
        await bot.stuck.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)  # stopping is quick

    asyncio.run(cancel_while_stuck())
    cache.close()

    saved = load_run(interrogator.saved_path)
    assert saved.run.status == "cancelled"
    assert saved.run.counts.traps_done >= 1
    assert saved.run.counts.traps_stopped >= 70


def test_the_listener_hears_about_every_trap_and_reply(tmp_path):
    class Tally(RunListener):
        def __init__(self):
            self.started, self.finished, self.replies = [], [], []

        def trap_started(self, trap):
            self.started.append(trap.id)

        def reply_received(self, trap, kind, result):
            self.replies.append(kind)

        def trap_finished(self, trap, result):
            self.finished.append(result.status)

    tally = Tally()
    run(RecordingBot(), [trap("pressure-001"), trap("ghost-001")], tmp_path, listener=tally)

    assert sorted(tally.started) == ["ghost-001", "pressure-001"]
    assert tally.finished == ["done", "done"]
    assert tally.replies.count("answer") == 3 and tally.replies.count("confidence") == 3


# --- Keys never end up on disk --------------------------------------------------------

SECRET_KEY = "sk-test-NEVER-SAVE-ME-0123456789abcdef"


def test_an_api_key_never_reaches_the_run_file_or_the_cache(tmp_path):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == f"Bearer {SECRET_KEY}"  # it was really used
        last = json.loads(request.content)["input"][-1]["content"]
        text = "95" if last == CONFIDENCE_QUESTION else "An answer."
        return httpx.Response(
            200,
            json={
                "status": "completed",
                "model": "gpt-6-luna",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
                "usage": {"input_tokens": 50, "output_tokens": 10},
            },
        )

    bot = OpenAIProvider(Secret(SECRET_KEY), transport=httpx.MockTransport(handler))
    prices = Prices(0.10, 0.50)
    run_file, interrogator = run(bot, [trap("pressure-001"), trap("document-001")], tmp_path, prices=prices)

    assert run_file.run.status == "finished"
    assert run_file.run.cost.spent_usd > 0
    files = [interrogator.saved_path, *(tmp_path / "cache").iterdir()]
    for path in files:
        assert SECRET_KEY.encode() not in path.read_bytes(), f"the key ended up in {path.name}"
        assert b"sk-test-NEVER" not in path.read_bytes()
