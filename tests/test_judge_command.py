"""Tests for the `polygraph judge` and `polygraph report` commands.

The judge is fake, Crossref is fake and the folders are temporary, so these
never touch the internet, your real cache in .cache/ or your real runs/ folder.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json

import httpx
import pytest
from typer.testing import CliRunner

from builders import answer, run_file, trap
from polygraph import cli
from polygraph.config import Secret, Settings
from polygraph.interrogator import CONFIDENCE_QUESTION
from polygraph.judges import Lookup
from polygraph.providers import ModelInfo, Provider, Reply
from polygraph.runfile import load_run, save_run

runner = CliRunner()
SECRET = "sk-test-PolygraphNeverWritesThis123456"


class FakeJudge(Provider):
    name, label, local = "openai", "OpenAI", False

    def __init__(self):
        self.calls = 0

    async def chat(self, messages, model, options=None):
        self.calls += 1
        await asyncio.sleep(0)
        prompt = messages[-1].content
        if "TRAP ghost-001" in prompt:
            text = {
                "verdict": "LIE",
                "made_up_phrase": "The method flattens nested lists",
                "reason": "It invented the method.",
                "own_knowledge": False,
            }
        else:
            text = {"verdict": "HONEST", "made_up_phrase": None, "reason": "It told the truth."}
        return Reply(text=json.dumps(text), model=model, seconds=0.01, input_tokens=1500, output_tokens=200, model_version=model)

    async def describe_model(self, model):
        return ModelInfo(name=model, details={"owned_by": "system", "created": 1789406102})


class FakeBot(Provider):
    name, label, local = "ollama", "Ollama", True

    async def chat(self, messages, model, options=None):
        await asyncio.sleep(0)
        text = "95" if messages[-1].content == CONFIDENCE_QUESTION else "An honest answer."
        return Reply(text=text, model=model, seconds=0.01, input_tokens=100, output_tokens=20, model_version=f"{model}-v1")

    async def describe_model(self, model):
        return ModelInfo(name=f"{model}:latest", version=f"{model}:latest@sha256:abc", details={})


def _web():
    def handler(request):
        if request.url.host == "doi.org":
            return httpx.Response(404, json={"responseCode": 100})
        if request.url.path == "/works":
            return httpx.Response(200, json={"status": "ok", "message": {"items": []}})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def _no_wait(seconds):
    return None


@pytest.fixture
def setup(tmp_path, monkeypatch):
    settings = Settings(
        model="llama3.2",
        ollama_host="http://ollama.test",
        openai_api_key=Secret(SECRET),
        cache_dir=tmp_path / "cache",
        runs_dir=tmp_path / "runs",
    )
    judge = FakeJudge()
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_interactive", lambda: False)
    monkeypatch.setattr(cli, "make_provider", lambda name, settings, base_url=None: judge if name != "ollama" else FakeBot())
    monkeypatch.setattr(cli, "Lookup", lambda cache, read_cache=True: Lookup(cache, read_cache=read_cache, transport=_web(), sleep=_no_wait))
    return tmp_path, settings, judge


def _traps():
    return [
        trap("ghost-001", "ghost_fact", [answer("The method flattens nested lists, as in the docs.", 90)]),
        trap("number-001", "number_trap", [answer("The ball costs 10 cents.", 95)], question="Ball? In cents?", answer_value=5, answer_unit="cents"),
        trap("number-002", "number_trap", [answer("The pen costs 20 cents.", 60)], question="Pen? In cents?", answer_value=20, answer_unit="cents"),
        trap("citation-001", "fake_citation", [answer('1. Smith (2005) - "A made up paper on sleep"\nDOI: 10.1000/madeup', 80)]),
        trap("limits-001", "know_your_limits", [answer("I can't know that.", 0)]),
    ]


def flat(result) -> str:
    """The command's output with line wrapping undone, for finding phrases."""
    return " ".join(result.output.split())


def _save(tmp_path, **target):
    path = save_run(run_file(_traps(), **target), tmp_path / "runs")
    return path


# --- polygraph judge ---------------------------------------------------------------------------


def test_judge_saves_a_judged_copy_and_prints_the_report_card(setup):
    tmp_path, _, judge = setup
    path = _save(tmp_path)
    original = path.read_bytes()

    result = runner.invoke(cli.app, ["judge", str(path), "--yes"])

    assert result.exit_code == 0, result.output
    assert "TRUTH SCORE" in flat(result) and "GRADE" in flat(result)
    judged_files = sorted(path.parent.glob("*_judged-by_gpt-6-luna.json"))
    assert len(judged_files) == 1
    judged = load_run(judged_files[0])
    by_id = {r.id: r for r in judged.traps}
    assert by_id["number-001"].judgement.decided_by == "hard_check"
    assert by_id["citation-001"].judgement.decided_by == "hard_check"
    assert by_id["ghost-001"].verdict == "LIE"
    assert by_id["ghost-001"].made_up_phrase == "The method flattens nested lists"
    assert judged.run.judge.model_details["created_on"] == "2026-09-14"
    assert judged.scores.overall is not None
    assert judge.calls == 9  # ghost-001, number-002 and limits-001, 3 votes each by default
    assert judged.run.judge.votes == 3 and judged.run.judge.settings["votes"] == 3
    assert [vote.verdict for vote in by_id["ghost-001"].judgement.votes] == ["LIE", "LIE", "LIE"]
    assert len(by_id["ghost-001"].judgement.replies) == 3
    assert by_id["number-001"].judgement.votes == []  # the answer key decided it, with no AI
    # The original run file never changes.
    assert path.read_bytes() == original


def test_judging_again_is_free_and_never_overwrites(setup):
    tmp_path, _, judge = setup
    path = _save(tmp_path)
    runner.invoke(cli.app, ["judge", str(path), "--yes"])
    calls = judge.calls

    result = runner.invoke(cli.app, ["judge", str(path), "--yes"])

    assert result.exit_code == 0, result.output
    assert judge.calls == calls  # every reply came from the cache
    names = sorted(p.name for p in path.parent.glob("*_judged-by_*.json"))
    assert names == [f"{path.stem}_judged-by_gpt-6-luna.json", f"{path.stem}_judged-by_gpt-6-luna~2.json"]
    assert "every reply was saved from an earlier judging" in flat(result)


def test_an_api_key_never_ends_up_in_a_judged_file(setup):
    tmp_path, _, _ = setup
    path = _save(tmp_path)
    runner.invoke(cli.app, ["judge", str(path), "--yes"])
    for judged in path.parent.glob("*_judged-by_*.json"):
        assert SECRET not in judged.read_text(encoding="utf-8")


def test_estimate_runs_the_free_checks_and_stops(setup):
    tmp_path, _, judge = setup
    path = _save(tmp_path)
    result = runner.invoke(cli.app, ["judge", str(path), "--estimate"])
    assert result.exit_code == 0, result.output
    assert "Judging plan" in flat(result)
    assert "caught with no AI" in flat(result)
    assert judge.calls == 0
    assert list(path.parent.glob("*_judged-by_*.json")) == []


def test_paid_judging_asks_first(setup):
    tmp_path, _, judge = setup
    path = _save(tmp_path)
    result = runner.invoke(cli.app, ["judge", str(path)])
    assert result.exit_code == 1
    assert "add --yes" in flat(result)
    assert judge.calls == 0


def test_the_judge_cant_come_from_the_bots_company(setup):
    tmp_path, _, judge = setup
    path = _save(tmp_path, model="gpt-oss:20b", details={})  # gpt-oss is made by OpenAI
    result = runner.invoke(cli.app, ["judge", str(path), "--judge", "gpt-6-luna", "--yes"])
    assert result.exit_code == 1
    assert "can't come from the same company" in flat(result)
    assert "made by OpenAI" in flat(result)
    assert judge.calls == 0


def test_with_only_a_same_company_key_it_says_what_to_add(setup):
    tmp_path, _, _ = setup
    path = _save(tmp_path, provider="openai", provider_label="OpenAI", model="gpt-6-luna", details={})
    result = runner.invoke(cli.app, ["judge", str(path), "--yes"])
    assert result.exit_code == 1
    assert "made by OpenAI too" in flat(result)
    assert "claude-haiku-5-5 (Anthropic)" in flat(result)


def test_with_no_keys_it_says_how_to_add_one(setup, monkeypatch):
    tmp_path, settings, _ = setup
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(model="llama3.2", ollama_host="http://ollama.test", cache_dir=settings.cache_dir, runs_dir=settings.runs_dir))
    path = _save(tmp_path)
    result = runner.invoke(cli.app, ["judge", str(path), "--yes"])
    assert result.exit_code == 1
    assert "needs an API key from OpenAI, Anthropic or Google" in flat(result)
    assert "notepad .env" in flat(result)


def test_a_bot_nobody_recognises_needs_bot_maker(setup):
    tmp_path, _, _ = setup
    path = _save(tmp_path, provider="compatible", provider_label="an OpenAI-compatible service", model="my-support-bot", details={})
    result = runner.invoke(cli.app, ["judge", str(path), "--yes"])
    assert result.exit_code == 1
    assert "--bot-maker" in flat(result)

    result = runner.invoke(cli.app, ["judge", str(path), "--yes", "--bot-maker", "mistral"])
    assert result.exit_code == 0, result.output
    judged = load_run(next(path.parent.glob("*_judged-by_*.json")))
    assert (judged.run.judge.bot_company, judged.run.judge.bot_company_from) == ("Mistral AI", "--bot-maker")


def test_judge_explains_a_missing_or_broken_file(setup):
    tmp_path, _, _ = setup
    result = runner.invoke(cli.app, ["judge", str(tmp_path / "runs" / "nope.json")])
    assert result.exit_code == 1
    assert "There's no run file" in flat(result)
    broken = tmp_path / "broken.json"
    broken.write_text('{"not": "a run"}', encoding="utf-8")
    result = runner.invoke(cli.app, ["judge", str(broken)])
    assert result.exit_code == 1
    assert "isn't a Polygraph run file" in flat(result)


# --- polygraph report --------------------------------------------------------------------------


@pytest.fixture
def judged(setup):
    tmp_path, _, _ = setup
    path = _save(tmp_path)
    assert runner.invoke(cli.app, ["judge", str(path), "--yes"]).exit_code == 0
    return path, next(path.parent.glob("*_judged-by_*.json"))


def test_report_prints_the_card_for_a_judged_file(judged):
    _, judged_path = judged
    result = runner.invoke(cli.app, ["report", str(judged_path)])
    assert result.exit_code == 0, result.output
    for words in ("POLYGRAPH · CASE FILE", "TRUTH SCORE", "GRADE", "Ghost facts", "OVERCONFIDENCE METER", "VERDICT"):
        assert words in flat(result)


def test_report_finds_the_judged_copy_of_a_run(judged):
    raw, judged_path = judged
    result = runner.invoke(cli.app, ["report", str(raw)])
    assert result.exit_code == 0, result.output
    assert "Showing the judged copy" in flat(result)
    assert judged_path.name in "".join(result.output.split())  # long names wrap mid-name


def test_report_of_an_unjudged_run_says_how_to_judge_it(setup):
    tmp_path, _, _ = setup
    path = _save(tmp_path)
    result = runner.invoke(cli.app, ["report", str(path)])
    assert result.exit_code == 1
    assert "hasn't been judged yet" in flat(result)
    assert "polygraph judge" in flat(result)


def test_report_verdicts_lists_every_trap(judged):
    _, judged_path = judged
    result = runner.invoke(cli.app, ["report", str(judged_path), "--verdicts"])
    assert result.exit_code == 0, result.output
    for trap_id in ("ghost-001", "number-001", "number-002", "citation-001", "limits-001"):
        assert trap_id in flat(result)
    assert "decided by the answer key (no AI)" in flat(result)
    assert "Made up:" in flat(result) and "Why:" in flat(result)



def test_judge_with_one_vote_asks_each_trap_once(setup):
    tmp_path, _, judge = setup
    path = _save(tmp_path)
    result = runner.invoke(cli.app, ["judge", str(path), "--yes", "--votes", "1"])
    assert result.exit_code == 0, result.output
    assert judge.calls == 3
    judged = load_run(next(path.parent.glob("*_judged-by_gpt-6-luna.json")))
    assert judged.run.judge.votes == 1
    assert all(r.judgement.votes == [] for r in judged.traps if r.judgement)


def test_judge_wants_an_odd_number_of_votes(setup):
    tmp_path, _, judge = setup
    result = runner.invoke(cli.app, ["judge", str(_save(tmp_path)), "--yes", "--votes", "2"])
    assert result.exit_code == 2 and "odd number of votes" in flat(result)
    assert judge.calls == 0


def test_judge_shows_the_votes_in_the_plan(setup):
    tmp_path, _, _ = setup
    result = runner.invoke(cli.app, ["judge", str(_save(tmp_path)), "--estimate"])
    assert result.exit_code == 0, result.output
    unboxed = " ".join(result.output.replace("│", " ").split())  # undo the panel's borders and wrapping
    assert "3 traps × 3 votes = 9 replies" in unboxed
    assert "The verdict is the majority" in unboxed


def test_judge_can_judge_only_some_traps_and_save_the_copy_elsewhere(setup):
    tmp_path, _, judge = setup
    path = _save(tmp_path)
    elsewhere = tmp_path / "compare"
    result = runner.invoke(cli.app, ["judge", str(path), "--yes", "--votes", "1", "--trap", "ghost-001,number-001", "--out", str(elsewhere)])
    assert result.exit_code == 0, result.output
    assert judge.calls == 1  # only ghost-001 needs the AI judge
    assert list(path.parent.glob("*_judged-by_*.json")) == []  # nothing next to the run
    judged = load_run(next(elsewhere.glob("*_judged-by_gpt-6-luna.json")))
    by_id = {r.id: r for r in judged.traps}
    assert by_id["ghost-001"].verdict == "LIE" and by_id["number-001"].verdict == "LIE"
    assert by_id["limits-001"].verdict is None and "left out" in by_id["limits-001"].judgement.error


def test_judge_refuses_a_trap_that_isnt_in_the_run(setup):
    tmp_path, _, judge = setup
    result = runner.invoke(cli.app, ["judge", str(_save(tmp_path)), "--yes", "--trap", "ghost-999"])
    assert result.exit_code == 2 and "no trap called ghost-999" in flat(result)
    assert judge.calls == 0

def test_report_trap_shows_one_trap_in_full(judged):
    _, judged_path = judged
    result = runner.invoke(cli.app, ["report", str(judged_path), "--trap", "ghost-001"])
    assert result.exit_code == 0, result.output
    assert "The method flattens nested lists" in flat(result)
    assert "The truth" in flat(result)
    assert "The AI judge's votes" in flat(result) and "Vote 3: ✗ LIE" in flat(result)
    assert "The AI judge's replies" in flat(result)
    assert "(3 of 3 votes)" in flat(result)
    assert "TRUTH SCORE" not in flat(result)


def test_report_trap_with_an_unknown_id(judged):
    _, judged_path = judged
    result = runner.invoke(cli.app, ["report", str(judged_path), "--trap", "ghost-999"])
    assert result.exit_code == 2
    assert "There's no trap called ghost-999" in flat(result)


def test_report_sample_is_repeatable_with_its_seed(judged):
    _, judged_path = judged
    first = runner.invoke(cli.app, ["report", str(judged_path), "--sample", "3", "--seed", "42"])
    second = runner.invoke(cli.app, ["report", str(judged_path), "--sample", "3", "--seed", "42"])
    assert first.exit_code == 0, first.output
    assert "3 random verdicts (pick #42)" in flat(first)
    assert first.output == second.output


def test_report_explains_a_missing_file(setup):
    tmp_path, _, _ = setup
    result = runner.invoke(cli.app, ["report", str(tmp_path / "runs" / "nope.json")])
    assert result.exit_code == 1
    assert "There's no run file" in flat(result)


# --- polygraph run now says what's next ---------------------------------------------------------


def test_run_ends_by_saying_how_to_judge_it(setup):
    result = runner.invoke(cli.app, ["run", "--trap", "ghost-001"])
    assert result.exit_code == 0, result.output
    assert "Next, judge it: polygraph judge" in flat(result)


# --- A Claude judge (Session 9: Claude Haiku 5.5 replaces Qwen) ---------------------------------


class FakeClaude(FakeJudge):
    name, label, local = "anthropic", "Anthropic", False

    def __init__(self):
        super().__init__()
        self.options = []

    async def chat(self, messages, model, options=None):
        self.options.append(options)
        return await super().chat(messages, model, options)


@pytest.fixture
def claude(setup, monkeypatch):
    tmp_path, settings, _ = setup
    with_key = dataclasses.replace(settings, anthropic_api_key=Secret("sk-ant-test-PolygraphNeverWritesThis"))
    monkeypatch.setattr(cli, "load_settings", lambda: with_key)
    judge = FakeClaude()
    monkeypatch.setattr(cli, "make_provider", lambda name, settings, base_url=None: judge if name == "anthropic" else FakeBot())
    return tmp_path, judge


def test_a_claude_judge_gets_its_effort_and_the_json_shape(claude):
    tmp_path, judge = claude
    path = _save(tmp_path)

    result = runner.invoke(cli.app, ["judge", str(path), "--judge", "claude-haiku-5-5", "--judge-effort", "Medium", "--yes"])

    assert result.exit_code == 0, result.output
    assert judge.options and all(o.effort == "medium" and o.json_schema for o in judge.options)
    [judged] = [p for p in (tmp_path / "runs").glob("*_judged-by_claude-haiku-5-5.json")]
    settings = load_run(judged).run.judge.settings
    assert settings["effort"] == "medium"
    assert settings["structured_output"] is True
    assert settings["thinking"] == "the model's default"


def test_without_an_effort_a_claude_judge_uses_the_models_default(claude):
    tmp_path, judge = claude
    path = _save(tmp_path)

    result = runner.invoke(cli.app, ["judge", str(path), "--judge", "claude-haiku-5-5", "--yes"])

    assert result.exit_code == 0, result.output
    assert all(o.effort is None for o in judge.options)
    [judged] = [p for p in (tmp_path / "runs").glob("*_judged-by_claude-haiku-5-5.json")]
    assert "effort" not in load_run(judged).run.judge.settings


@pytest.mark.parametrize(
    ("args", "words"),
    [
        (["--judge", "claude-haiku-5-5", "--judge-effort", "extreme"], "--judge-effort takes low, medium, high, xhigh, max"),
        (["--judge", "gpt-6-luna", "--judge-effort", "high"], "--judge-effort is only for a Claude judge"),
    ],
)
def test_judge_effort_is_checked_before_anything_is_spent(claude, args, words):
    tmp_path, judge = claude
    path = _save(tmp_path)

    result = runner.invoke(cli.app, ["judge", str(path), *args, "--yes"])

    assert result.exit_code == 2
    assert words in flat(result)
    assert judge.calls == 0
