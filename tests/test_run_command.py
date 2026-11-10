"""Tests for the `polygraph run` and `polygraph models` commands.

The bot is fake and the folders are temporary, so these never touch the
internet, your real cache in .cache/ or your real runs/ folder.
"""

from __future__ import annotations

import asyncio

import pytest
from typer.testing import CliRunner

from polygraph import cli
from polygraph.config import Settings
from polygraph.interrogator import CONFIDENCE_QUESTION
from polygraph.providers import ModelInfo, Provider, ProviderError, Reply, SetupError
from polygraph.providers.catalog import PRICES_CHECKED_ON
from polygraph.runfile import load_run
from polygraph.traps import load_library

runner = CliRunner()


# How many answers the real trap library asks for: one per question and per
# push-back, four for a consistency trap. Every answer is followed by a
# confidence question, so a run sends twice as many messages. Worked out from
# the library itself, so the tests keep up as it grows (80 traps in Session 2,
# 200 since Session 9).
_LIBRARY = load_library()


def answers_for(*kinds: str) -> int:
    traps = [t for t in _LIBRARY.traps if not kinds or t.type in kinds]
    return sum(len(t.wordings()) if t.type == "consistency" else 1 + len(t.follow_ups) for t in traps)


def traps_of(*kinds: str) -> int:
    return sum(1 for t in _LIBRARY.traps if t.type in kinds)


class FakeBot(Provider):
    def __init__(self, name="ollama", label="Ollama", local=True, fail=None, missing=False, models=()):
        self.name, self.label, self.local = name, label, local
        self.fail = fail
        self.missing = missing
        self.models = models
        self.calls = 0

    async def chat(self, messages, model, options=None):
        self.calls += 1
        await asyncio.sleep(0)
        if self.fail is not None:
            raise self.fail
        text = "95" if messages[-1].content == CONFIDENCE_QUESTION else "An honest answer."
        return Reply(text=text, model=model, seconds=0.01, input_tokens=200, output_tokens=50, model_version=f"{model}-v1")

    async def describe_model(self, model):
        if self.missing:
            raise ProviderError(f"The model '{model}' isn't downloaded yet.", hint=f"Download it with: ollama pull {model}", kind="not_found")
        if self.local:
            return ModelInfo(name=f"{model}:latest", version=f"{model}:latest@sha256:abc123", details={"parameter_size": "3.2B"})
        return ModelInfo(name=model)

    async def list_models(self):
        return [ModelInfo(name=name) for name in self.models]


@pytest.fixture
def folders(tmp_path, monkeypatch):
    settings = Settings(
        model="llama3.2",
        ollama_host="http://ollama.test",
        cache_dir=tmp_path / "cache",
        runs_dir=tmp_path / "runs",
    )
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_interactive", lambda: False)
    return tmp_path


def use_bot(monkeypatch, bot):
    monkeypatch.setattr(cli, "make_provider", lambda name, settings, base_url=None: bot)
    return bot


def run_files(folder):
    return sorted((folder / "runs").glob("*.json"))


# --- Free local runs ---------------------------------------------------------------


def test_a_full_free_run_saves_a_run_file(folders, monkeypatch):
    bot = use_bot(monkeypatch, FakeBot())

    result = runner.invoke(cli.app, ["run"])

    assert result.exit_code == 0, result.output
    assert "Interrogation plan" in result.output
    assert f"{2 * answers_for()} to the bot: {answers_for()} answers" in result.output
    assert "free: this model runs on your PC" in result.output
    assert "✓ ghost-001" in result.output
    assert "Interrogation finished." in result.output
    assert f"{answers_for()} collected" in result.output
    assert bot.calls == 2 * answers_for()
    [saved] = run_files(folders)
    run_file = load_run(saved)
    assert run_file.run.status == "finished"
    assert run_file.run.target.model_version == "llama3.2:latest@sha256:abc123"
    assert run_file.run.counts.answers == answers_for()


def test_running_it_again_uses_saved_answers(folders, monkeypatch):
    use_bot(monkeypatch, FakeBot())
    runner.invoke(cli.app, ["run", "--type", "pressure"])
    bot = use_bot(monkeypatch, FakeBot())

    result = runner.invoke(cli.app, ["run", "--type", "pressure"])

    assert result.exit_code == 0, result.output
    pressure = 2 * answers_for("pressure_test")
    assert f"{pressure} of {pressure} already saved from earlier runs" in result.output
    assert f"0 newly asked, {pressure} from saved answers" in result.output
    assert bot.calls == 0
    assert len(run_files(folders)) == 2


def test_fresh_asks_everything_again(folders, monkeypatch):
    use_bot(monkeypatch, FakeBot())
    runner.invoke(cli.app, ["run", "--type", "ghost"])
    bot = use_bot(monkeypatch, FakeBot())

    result = runner.invoke(cli.app, ["run", "--type", "ghost", "--fresh"])

    assert result.exit_code == 0, result.output
    assert bot.calls == 2 * answers_for("ghost_fact")


def test_estimate_only_shows_the_plan_and_asks_nothing(folders, monkeypatch):
    bot = use_bot(monkeypatch, FakeBot())

    result = runner.invoke(cli.app, ["run", "--estimate"])

    assert result.exit_code == 0, result.output
    assert "Interrogation plan" in result.output
    assert bot.calls == 0
    assert run_files(folders) == []


@pytest.mark.parametrize(
    ("args", "traps"),
    [
        (["--type", "pressure"], traps_of("pressure_test")),
        (["--type", "ghost,premise"], traps_of("ghost_fact", "false_premise")),
        (["-t", "ghost", "-t", "number"], traps_of("ghost_fact", "number_trap")),
        (["--trap", "ghost-001", "--trap", "number-002"], 2),
        (["--type", "ghost", "--trap", "ghost-003"], 1),
    ],
)
def test_traps_can_be_chosen(folders, monkeypatch, args, traps):
    use_bot(monkeypatch, FakeBot())

    result = runner.invoke(cli.app, ["run", *args])

    assert result.exit_code == 0, result.output
    assert load_run(run_files(folders)[0]).run.trap_set.traps_in_run == traps


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--type", "gossip"], "isn't a trap type"),
        (["--trap", "ghost-999"], "There's no trap called ghost-999"),
        (["--type", "pressure", "--trap", "ghost-001"], "No traps match"),
    ],
)
def test_a_bad_choice_of_traps_is_explained(folders, monkeypatch, args, message):
    bot = use_bot(monkeypatch, FakeBot())

    result = runner.invoke(cli.app, ["run", *args])

    assert result.exit_code == 2
    assert message in result.output
    assert bot.calls == 0


def test_a_model_that_isnt_there_is_caught_before_anything_is_asked(folders, monkeypatch):
    bot = use_bot(monkeypatch, FakeBot(missing=True))

    result = runner.invoke(cli.app, ["run", "--model", "gemma3"])

    assert result.exit_code == 1
    assert "isn't downloaded yet" in result.output
    assert "ollama pull gemma3" in result.output
    assert bot.calls == 0


def test_a_failed_run_says_why_and_still_saves(folders, monkeypatch):
    use_bot(monkeypatch, FakeBot(fail=ProviderError("Can't reach Ollama.", hint="Open Ollama from the Start menu.", kind="auth")))

    result = runner.invoke(cli.app, ["run", "--type", "ghost"])

    assert result.exit_code == 1
    assert "Interrogation failed." in result.output
    assert "Open Ollama from the Start menu." in result.output
    assert load_run(run_files(folders)[0]).run.status == "failed"


# --- Paid runs and the cost guard -------------------------------------------------


def paid_bot(monkeypatch):
    return use_bot(monkeypatch, FakeBot(name="openai", label="OpenAI", local=False))


def test_a_paid_run_shows_its_estimate_and_needs_a_yes(folders, monkeypatch):
    bot = paid_bot(monkeypatch)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--type", "ghost"])

    assert result.exit_code == 1
    assert "Cost           about $" in result.output
    assert "add --yes" in result.output
    assert bot.calls == 0
    assert run_files(folders) == []


def test_yes_starts_a_paid_run_and_the_cost_is_tracked(folders, monkeypatch):
    bot = paid_bot(monkeypatch)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--type", "ghost", "--yes"])

    assert result.exit_code == 0, result.output
    assert bot.calls == 2 * answers_for("ghost_fact")
    run_file = load_run(run_files(folders)[0])
    # 20 replies x (200 tokens in at $0.10 + 50 out at $0.50 per million).
    assert run_file.run.cost.spent_usd == pytest.approx(2 * answers_for("ghost_fact") * (200 * 0.10 + 50 * 0.50) / 1_000_000)
    assert run_file.run.cost.prices.checked_on == PRICES_CHECKED_ON
    assert run_file.run.cost.estimated_usd > 0


def test_a_paid_run_asks_before_starting(folders, monkeypatch):
    bot = paid_bot(monkeypatch)
    monkeypatch.setattr(cli, "_interactive", lambda: True)

    declined = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--type", "ghost"], input="n\n")
    assert declined.exit_code == 0
    assert "Nothing was spent." in declined.output
    assert bot.calls == 0

    accepted = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--type", "ghost"], input="y\n")
    assert accepted.exit_code == 0, accepted.output
    assert bot.calls == 2 * answers_for("ghost_fact")


def test_over_the_limit_it_asks_first_and_spends_nothing_if_you_say_no(folders, monkeypatch):
    bot = paid_bot(monkeypatch)
    monkeypatch.setattr(cli, "_interactive", lambda: True)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--max-cost", "0.01"], input="n\n")

    assert result.exit_code == 1
    assert "more than the $0.01 limit" in result.output
    assert "Nothing was spent." in result.output
    assert bot.calls == 0
    assert run_files(folders) == []


def test_approving_a_higher_limit_lets_the_run_go(folders, monkeypatch):
    bot = paid_bot(monkeypatch)
    monkeypatch.setattr(cli, "_interactive", lambda: True)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--max-cost", "0.01"], input="y\ny\n")

    assert result.exit_code == 0, result.output
    assert "The limit for this run is now $2.00." in result.output
    assert bot.calls == 2 * answers_for()
    assert load_run(run_files(folders)[0]).run.cost.limit_usd == 2.00


def test_yes_never_raises_the_limit(folders, monkeypatch):
    bot = paid_bot(monkeypatch)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--max-cost", "0.01", "--yes"])

    assert result.exit_code == 1
    assert "--max-cost" in result.output
    assert bot.calls == 0


def test_an_unknown_price_is_refused_rather_than_guessed(folders, monkeypatch):
    bot = paid_bot(monkeypatch)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-9", "--yes"])

    assert result.exit_code == 1
    assert "doesn't know what gpt-9 costs" in result.output
    assert "--price-in" in result.output
    assert bot.calls == 0


def test_prices_you_give_make_an_unknown_model_usable(folders, monkeypatch):
    bot = paid_bot(monkeypatch)

    result = runner.invoke(
        cli.app, ["run", "--model", "gpt-9", "--price-in", "1", "--price-out", "2", "--type", "ghost", "--yes"]
    )

    assert result.exit_code == 0, result.output
    assert bot.calls == 2 * answers_for("ghost_fact")
    assert load_run(run_files(folders)[0]).run.cost.prices.input_per_million == 1


def test_half_a_price_is_refused(folders, monkeypatch):
    paid_bot(monkeypatch)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-9", "--price-in", "1"])

    assert result.exit_code == 2
    assert "both --price-in and --price-out" in result.output


def test_a_missing_key_is_explained(folders):
    result = runner.invoke(cli.app, ["run", "--model", "claude-haiku-5-5"])

    assert result.exit_code == 1
    assert "needs your Anthropic API key" in result.output
    assert "ANTHROPIC_API_KEY=" in result.output


def flat(output: str) -> str:
    """The output as one line, without the box borders, so wrapping doesn't matter."""
    return " ".join(output.replace("│", " ").split())


def test_thinking_models_get_room_to_think(folders, monkeypatch):
    paid_bot(monkeypatch)

    result = runner.invoke(cli.app, ["run", "--model", "gpt-6-luna", "--estimate"])

    assert "32,768 tokens per answer" in flat(result.output)
    assert "thinks before answering" in flat(result.output)


# --- polygraph models ----------------------------------------------------------------


def fake_factory(bots):
    def make(name, settings, base_url=None):
        if name in bots:
            return bots[name]
        raise SetupError(f"No key for {name}.", hint=f"Paste your {name} key into .env.")

    return make


def test_models_lists_known_models_and_prices(folders, monkeypatch):
    local = FakeBot(models=("llama3.2:latest", "gemma3:latest"))
    monkeypatch.setattr(cli, "make_provider", fake_factory({"ollama": local}))

    result = runner.invoke(cli.app, ["models"])

    assert result.exit_code == 0, result.output
    for expected in ("gpt-6-luna", "claude-haiku-5-5", "gemini-2.5-flash-lite", "llama3.2:latest", "gemma3:latest"):
        assert expected in result.output
    assert f"checked {PRICES_CHECKED_ON}" in result.output
    assert "gpt-5-nano" not in result.output  # shutting down: only shown with --all


def test_models_with_a_key_shows_the_live_list(folders, monkeypatch):
    live = FakeBot(name="openai", label="OpenAI", local=False, models=("gpt-6-luna", "gpt-7-preview"))
    monkeypatch.setattr(cli, "make_provider", fake_factory({"openai": live}))

    result = runner.invoke(cli.app, ["models", "openai", "--all"])

    assert result.exit_code == 0, result.output
    assert "Live list from OpenAI (2 models)" in result.output
    assert "gpt-7-preview  (price not known" in result.output
    assert "gpt-5-nano" in result.output


def test_models_explains_an_unknown_provider(folders):
    result = runner.invoke(cli.app, ["models", "acme"])

    assert result.exit_code == 2
