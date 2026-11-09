"""Live tests: one real question to each model you can reach.

These are skipped by a plain `python -m pytest`. Run them with:

    python -m pytest -m live

- Ollama, and Ollama through the OpenAI-compatible connector: free, and only
  if Ollama is running with llama3.2 downloaded.
- OpenAI, Anthropic and Google: only if that key is in .env. Each one asks
  its cheapest model one short question, which costs a fraction of a cent.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from polygraph.config import load_settings
from polygraph.providers import CHEAPEST, ChatOptions, CompatibleProvider, Message, OllamaProvider, make_provider

pytestmark = pytest.mark.live

QUESTION = [Message("user", "What is the capital of Australia? Answer in one short sentence.")]
SETTINGS = load_settings()


def ollama_has_llama() -> bool:
    try:
        tags = httpx.get(f"{SETTINGS.ollama_host}/api/tags", timeout=3).json()
    except (httpx.HTTPError, ValueError):
        return False
    return any(model.get("name") == "llama3.2:latest" for model in tags.get("models", []))


needs_ollama = pytest.mark.skipif(not ollama_has_llama(), reason="Ollama isn't running with llama3.2")


@needs_ollama
def test_ollama_answers_and_says_exactly_which_version_it_is():
    provider = OllamaProvider(SETTINGS.ollama_host)

    async def scenario():
        info = await provider.describe_model("llama3.2")
        reply = await provider.chat(QUESTION, "llama3.2", ChatOptions(max_output_tokens=100))
        return info, reply

    info, reply = asyncio.run(scenario())

    assert "canberra" in reply.text.lower()
    assert info.version.startswith("llama3.2:latest@sha256:")
    assert reply.model_version == info.version
    assert reply.input_tokens and reply.output_tokens


@needs_ollama
def test_the_openai_compatible_connector_works_with_ollamas_compatible_door():
    provider = CompatibleProvider(f"{SETTINGS.ollama_host}/v1")

    async def scenario():
        names = [info.name for info in await provider.list_models()]
        reply = await provider.chat(QUESTION, "llama3.2", ChatOptions(max_output_tokens=100))
        return names, reply

    names, reply = asyncio.run(scenario())

    assert provider.local
    assert "llama3.2:latest" in names
    assert "canberra" in reply.text.lower()
    assert reply.input_tokens and reply.output_tokens


KEYS = {
    "openai": SETTINGS.openai_api_key,
    "anthropic": SETTINGS.anthropic_api_key,
    "google": SETTINGS.gemini_api_key,
}


@pytest.mark.parametrize("name", ["openai", "anthropic", "google"])
def test_a_cloud_model_answers(name):
    if KEYS[name] is None:
        pytest.skip(f"No {name} API key in .env")
    provider = make_provider(name, SETTINGS)
    model = CHEAPEST[name]

    async def scenario():
        await provider.describe_model(model)
        # Room to think first: these models spend part of the limit thinking.
        return await provider.chat(QUESTION, model, ChatOptions(max_output_tokens=2048))

    reply = asyncio.run(scenario())

    assert "canberra" in reply.text.lower()
    assert reply.model_version
    assert reply.input_tokens and reply.output_tokens
