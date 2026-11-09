"""Tests for `polygraph ask`.

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
from polygraph.config import Settings, load_settings, normalize_host
from polygraph.providers import Message, OllamaProvider, ProviderError, Reply


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
                "prompt_eval_count": 31,
                "eval_count": 4,
            },
        )

    reply = ask(fake_ollama(handler), "What is the capital of Australia?")

    assert reply.text == "Canberra."
    assert reply.model == "llama3.2"
    assert (reply.input_tokens, reply.output_tokens) == (31, 4)
    assert seen["url"] == "http://ollama.test/api/chat"
    assert seen["body"] == {
        "model": "llama3.2",
        "messages": [{"role": "user", "content": "What is the capital of Australia?"}],
        "stream": False,
    }


def test_missing_model_says_how_to_download_it():
    def handler(request):
        return httpx.Response(404, json={"error": 'model "nope" not found, try pulling it first'})

    with pytest.raises(ProviderError) as caught:
        ask(fake_ollama(handler), model="nope")

    assert "isn't downloaded" in caught.value.message
    assert caught.value.hint == "Download it with: ollama pull nope"


def test_ollama_not_running_gives_a_friendly_error():
    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(ProviderError) as caught:
        ask(fake_ollama(handler))

    assert "Can't reach Ollama" in caught.value.message
    assert "Start menu" in caught.value.hint


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

    def __init__(self, host: str) -> None:
        self.host = host

    async def chat(self, messages, model):
        return Reply(text="  Canberra is the capital of Australia.\n", model=model, seconds=0.42)


@pytest.fixture
def offline(monkeypatch):
    settings = Settings(model="llama3.2", ollama_host="http://ollama.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "OllamaProvider", FakeOllama)


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
        async def chat(self, messages, model):
            return Reply(text="See [bold]this[/bold] and [1].", model=model, seconds=0.1)

    monkeypatch.setattr(cli, "OllamaProvider", BracketOllama)
    result = runner.invoke(cli.app, ["ask", "Hi"])

    assert "See [bold]this[/bold] and [1]." in result.output


def test_ask_explains_problems_instead_of_crashing(offline, monkeypatch):
    class BrokenOllama(FakeOllama):
        async def chat(self, messages, model):
            raise ProviderError("Can't reach Ollama.", hint="Open Ollama from the Start menu.")

    monkeypatch.setattr(cli, "OllamaProvider", BrokenOllama)
    result = runner.invoke(cli.app, ["ask", "Hi"])

    assert result.exit_code == 1
    assert "Can't reach Ollama." in result.output
    assert "Open Ollama from the Start menu." in result.output


def test_ask_needs_a_question(offline):
    result = runner.invoke(cli.app, ["ask", "   "])

    assert result.exit_code == 2


# --- Settings ----------------------------------------------------------------


def test_blank_settings_fall_back_to_defaults(tmp_path, monkeypatch):
    monkeypatch.delenv("POLYGRAPH_MODEL", raising=False)
    monkeypatch.delenv("OLLAMA_HOST", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text("# all blank\nPOLYGRAPH_MODEL=\nOLLAMA_HOST=\n", encoding="utf-8")

    settings = load_settings(env_file)

    assert settings.model == "llama3.2"
    assert settings.ollama_host == "http://127.0.0.1:11434"


def test_env_file_can_change_the_model(tmp_path, monkeypatch):
    monkeypatch.delenv("POLYGRAPH_MODEL", raising=False)
    env_file = tmp_path / ".env"
    env_file.write_text("POLYGRAPH_MODEL=gemma3\n", encoding="utf-8")

    assert load_settings(env_file).model == "gemma3"


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
