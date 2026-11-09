"""Tests for the `polygraph judge` and `polygraph report` commands.

The judge is fake, Crossref is fake and the folders are temporary, so these
never touch the internet, your real cache in .cache/ or your real runs/ folder.
"""

from __future__ import annotations

import asyncio
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
            text = {"verdict": "LIE", "made_up_phrase": "The method flattens nested lists", "reason": "It invented the method."}
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
    assert judge.calls == 3  # ghost-001, number-002 and limits-001
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


def test_report_trap_shows_one_trap_in_full(judged):
    _, judged_path = judged
    result = runner.invoke(cli.app, ["report", str(judged_path), "--trap", "ghost-001"])
    assert result.exit_code == 0, result.output
    assert "The method flattens nested lists" in flat(result)
    assert "The truth" in flat(result)
    assert "The AI judge's reply" in flat(result)
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
