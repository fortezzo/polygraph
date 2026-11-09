"""Tests for `polygraph ask` and the settings.

None of these use the internet or a real model. Ollama's replies are faked,
so the tests run in about a second and never cost anything.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest
from typer.testing import CliRunner

from polygraph import cli
from polygraph.config import Secret, Settings, load_settings, normalize_host
from polygraph.providers import ChatOptions, Message, OllamaProvider, ProviderError, Reply


def fake_ollama(handler) -> OllamaProvider:
    """An Ollama connector whose network is replaced by `handler`."""
    return OllamaProvider(host="http://ollama.test", transport=httpx.MockTransport(handler))


def ask(provider: OllamaProvider, question: str = "hi", model: str = "llama3.2") -> Reply:
    return asyncio.run(provider.chat([Message("user", question)], model=model))


# --- The Ollama connector ----------------------------------------------------


def test_sends_the_question_and_reads_the_answer():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(
            200,
            json={
                "model": "llama3.2",
                "message": {"role": "assistant", "content": "Canberra."},
                "done": True,
                "done_reason": "stop",
                "prompt_eval_count": 31,
                "eval_count": 4,
            },
        )

    reply = ask(fake_ollama(handler), "What is the capital of Australia?")

    assert reply.text == "Canberra."
    assert reply.model == "llama3.2"
    assert (reply.input_tokens, reply.output_tokens) == (31, 4)
    assert reply.finish_reason == "stop"
    assert seen["url"] == "http://ollama.test/api/chat"
    assert seen["body"] == {
        "model": "llama3.2",
        "messages": [{"role": "user", "content": "What is the capital of Australia?"}],
        "stream": False,
        # The answer length limit stops a small model that gets stuck repeating itself.
        "options": {"num_predict": 4096},
    }


def test_temperature_is_only_sent_when_asked_for():
    bodies = []

    def handler(request):
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json={"model": "llama3.2", "message": {"content": "Hi."}, "done_reason": "stop"})

    provider = fake_ollama(handler)
    asyncio.run(provider.chat([Message("user", "hi")], "llama3.2", ChatOptions(max_output_tokens=50, temperature=0.2)))

    assert bodies[0]["options"] == {"num_predict": 50, "temperature": 0.2}


def test_an_answer_cut_off_by_the_length_limit_is_marked():
    def handler(request):
        return httpx.Response(200, json={"model": "llama3.2", "message": {"content": "Once upon a"}, "done_reason": "length"})

    reply = ask(fake_ollama(handler))

    assert reply.truncated


def test_private_thinking_is_left_out_of_the_answer():
    def handler(request):
        return httpx.Response(
            200, json={"model": "qwen3", "message": {"content": "<think>Hmm, Canberra.</think>\n\nCanberra."}}
        )

    assert ask(fake_ollama(handler), model="qwen3").text == "Canberra."


def test_the_exact_version_comes_from_the_model_list():
    def handler(request):
        if request.url.path == "/api/tags":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "llama3.2:latest",
                            "digest": "a80c4f17acd5" + "0" * 52,
                            "modified_at": "2026-11-08T18:35:26-06:00",
                            "details": {"family": "llama", "parameter_size": "3.2B", "quantization_level": "Q4_K_M"},
                        }
                    ]
                },
            )
        return httpx.Response(200, json={"model": "llama3.2", "message": {"content": "Hi."}})

    provider = fake_ollama(handler)
    info = asyncio.run(provider.describe_model("llama3.2"))
    reply = ask(provider)

    assert info.name == "llama3.2:latest"
    assert info.version == "llama3.2:latest@sha256:a80c4f17acd5" + "0" * 52
    assert info.details["parameter_size"] == "3.2B"
    assert reply.model_version == info.version


def test_a_model_that_isnt_downloaded_is_caught_before_the_run():
    def handler(request):
        return httpx.Response(200, json={"models": [{"name": "llama3.2:latest", "digest": "abc"}]})

    with pytest.raises(ProviderError) as caught:
        asyncio.run(fake_ollama(handler).describe_model("gemma3"))

    assert caught.value.kind == "not_found"
    assert caught.value.hint == "Download it with: ollama pull gemma3"


def test_missing_model_says_how_to_download_it():
    def handler(request):
        return httpx.Response(404, json={"error": 'model "nope" not found, try pulling it first'})

    with pytest.raises(ProviderError) as caught:
        ask(fake_ollama(handler), model="nope")

    assert "isn't downloaded" in caught.value.message
    assert caught.value.hint == "Download it with: ollama pull nope"
    assert caught.value.fatal


def test_ollama_not_running_gives_a_friendly_error():
    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(ProviderError) as caught:
        ask(fake_ollama(handler))

    assert "Can't reach Ollama" in caught.value.message
    assert "Start menu" in caught.value.hint
    assert caught.value.retryable


def test_unreadable_answer_gives_a_friendly_error():
    def handler(request):
        return httpx.Response(200, text="this is not JSON")

    with pytest.raises(ProviderError) as caught:
        ask(fake_ollama(handler))

    assert "couldn't read" in caught.value.message


# --- The `polygraph ask` command --------------------------------------------

runner = CliRunner()


class FakeOllama:
    """Stands in for OllamaProvider so the command can be tested offline."""

    name = "ollama"
    label = "Ollama"
    local = True

    def __init__(self, host: str = "http://ollama.test") -> None:
        self.host = host

    async def chat(self, messages, model, options=None):
        return Reply(text="  Canberra is the capital of Australia.\n", model=model, seconds=0.42)


@pytest.fixture
def offline(monkeypatch):
    settings = Settings(model="llama3.2", ollama_host="http://ollama.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "make_provider", lambda name, settings, base_url=None: FakeOllama())


def test_ask_prints_the_answer(offline):
    result = runner.invoke(cli.app, ["ask", "What is the capital of Australia?"])

    assert result.exit_code == 0
    assert "Canberra is the capital of Australia." in result.output
    assert "Answered by llama3.2 via Ollama" in result.output


def test_ask_uses_the_model_you_pick(offline):
    result = runner.invoke(cli.app, ["ask", "--model", "gemma3", "Hi"])

    assert result.exit_code == 0
    assert "Answered by gemma3" in result.output


def test_ask_prints_square_brackets_exactly(offline, monkeypatch):
    class BracketOllama(FakeOllama):
        async def chat(self, messages, model, options=None):
            return Reply(text="See [bold]this[/bold] and [1].", model=model, seconds=0.1)

    monkeypatch.setattr(cli, "make_provider", lambda name, settings, base_url=None: BracketOllama())
    result = runner.invoke(cli.app, ["ask", "Hi"])

    assert "See [bold]this[/bold] and [1]." in result.output


def test_ask_explains_problems_instead_of_crashing(offline, monkeypatch):
    class BrokenOllama(FakeOllama):
        async def chat(self, messages, model, options=None):
            raise ProviderError("Can't reach Ollama.", hint="Open Ollama from the Start menu.")

    monkeypatch.setattr(cli, "make_provider", lambda name, settings, base_url=None: BrokenOllama())
    result = runner.invoke(cli.app, ["ask", "Hi"])

    assert result.exit_code == 1
    assert "Can't reach Ollama." in result.output
    assert "Open Ollama from the Start menu." in result.output


def test_ask_needs_a_question(offline):
    result = runner.invoke(cli.app, ["ask", "   "])

    assert result.exit_code == 2


def test_ask_explains_a_missing_api_key(monkeypatch):
    monkeypatch.setattr(cli, "load_settings", lambda: Settings(model="llama3.2", ollama_host="http://ollama.test"))
    result = runner.invoke(cli.app, ["ask", "--model", "gpt-6-luna", "Hi"])

    assert result.exit_code == 1
    assert "needs your OpenAI API key" in result.output
    assert "OPENAI_API_KEY=" in result.output


# --- Settings ----------------------------------------------------------------

KEY_SETTINGS = [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
    "OPENAI_COMPATIBLE_API_KEY",
    "POLYGRAPH_CACHE_DIR",
    "POLYGRAPH_RUNS_DIR",
]


@pytest.fixture
def clean_env(monkeypatch):
    for name in ["POLYGRAPH_MODEL", "OLLAMA_HOST", *KEY_SETTINGS]:
        monkeypatch.delenv(name, raising=False)


def test_blank_settings_fall_back_to_defaults(tmp_path, clean_env):
    env_file = tmp_path / ".env"
    env_file.write_text("# all blank\nPOLYGRAPH_MODEL=\nOLLAMA_HOST=\nOPENAI_API_KEY=\n", encoding="utf-8")

    settings = load_settings(env_file)

    assert settings.model == "llama3.2"
    assert settings.ollama_host == "http://127.0.0.1:11434"
    assert settings.openai_api_key is None
    assert settings.secrets() == []


def test_env_file_can_change_the_model(tmp_path, clean_env):
    env_file = tmp_path / ".env"
    env_file.write_text("POLYGRAPH_MODEL=gemma3\n", encoding="utf-8")

    assert load_settings(env_file).model == "gemma3"


def test_api_keys_are_read_but_never_printed(tmp_path, clean_env):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "OPENAI_API_KEY=sk-test-openai-123456789\n"
        "ANTHROPIC_API_KEY=sk-ant-test-987654321\n"
        "GOOGLE_API_KEY=AIzaTestGoogleKey1234567890abc\n",
        encoding="utf-8",
    )

    settings = load_settings(env_file)

    assert settings.openai_api_key.reveal() == "sk-test-openai-123456789"
    assert settings.anthropic_api_key.reveal() == "sk-ant-test-987654321"
    # GOOGLE_API_KEY works when GEMINI_API_KEY isn't set, like Google's own tools.
    assert settings.gemini_api_key.reveal() == "AIzaTestGoogleKey1234567890abc"
    for shown in (repr(settings), str(settings), repr(settings.openai_api_key), f"{settings.openai_api_key}"):
        assert "sk-test" not in shown
        assert "sk-ant" not in shown
        assert "AIza" not in shown
    assert set(settings.secrets()) == {
        "sk-test-openai-123456789",
        "sk-ant-test-987654321",
        "AIzaTestGoogleKey1234567890abc",
    }


def test_gemini_api_key_wins_over_google_api_key(tmp_path, clean_env):
    env_file = tmp_path / ".env"
    env_file.write_text("GEMINI_API_KEY=AIzaFirst\nGOOGLE_API_KEY=AIzaSecond\n", encoding="utf-8")

    assert load_settings(env_file).gemini_api_key == Secret("AIzaFirst")


def test_folders_and_compatible_service_can_be_set(tmp_path, clean_env, monkeypatch):
    monkeypatch.setenv("POLYGRAPH_CACHE_DIR", str(tmp_path / "my-cache"))
    env_file = tmp_path / ".env"
    env_file.write_text("OPENAI_COMPATIBLE_BASE_URL=localhost:1234/v1/\n", encoding="utf-8")

    settings = load_settings(env_file)

    assert settings.cache_dir == tmp_path / "my-cache"
    assert settings.compatible_base_url == "http://localhost:1234/v1"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("http://127.0.0.1:11434", "http://127.0.0.1:11434"),
        ("localhost:11434", "http://localhost:11434"),
        ("http://127.0.0.1:11434/", "http://127.0.0.1:11434"),
        ("0.0.0.0:11434", "http://127.0.0.1:11434"),
    ],
)
def test_ollama_host_is_cleaned_up(raw, expected):
    assert normalize_host(raw) == expected
