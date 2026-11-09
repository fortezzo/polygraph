"""Picking and building the right connector for a model."""

from __future__ import annotations

import re

from polygraph.config import Settings, normalize_host
from polygraph.providers.anthropic import ANTHROPIC_URL, AnthropicProvider
from polygraph.providers.base import Provider
from polygraph.providers.catalog import CHEAPEST
from polygraph.providers.compatible import CompatibleProvider
from polygraph.providers.google import GOOGLE_URL, GoogleProvider
from polygraph.providers.ollama import OllamaProvider
from polygraph.providers.openai import OPENAI_URL, OpenAIProvider

PROVIDER_NAMES = ("ollama", "openai", "anthropic", "google", "compatible")
LABELS = {
    "ollama": "Ollama",
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "compatible": "an OpenAI-compatible service",
}
_ALIASES = {
    "gemini": "google",
    "claude": "anthropic",
    "openai-compatible": "compatible",
    "openai_compatible": "compatible",
    "local": "ollama",
}
_KEY_SETTING = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "google": "GEMINI_API_KEY"}


class SetupError(Exception):
    """Something has to be set up before Polygraph can talk to a model."""

    def __init__(self, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


def provider_name(name: str) -> str | None:
    """'OpenAI', 'gemini', 'claude' and so on, as one of PROVIDER_NAMES."""
    wanted = name.strip().lower()
    wanted = _ALIASES.get(wanted, wanted)
    return wanted if wanted in PROVIDER_NAMES else None


def guess_provider(model: str) -> str:
    """Which company a model name belongs to. Names with a colon (llama3.2:latest)
    and gpt-oss are open models that run in Ollama."""
    name = model.strip().lower()
    if ":" in name or name.startswith("gpt-oss"):
        return "ollama"
    if name.startswith("claude-"):
        return "anthropic"
    if name.startswith(("gemini-", "models/gemini-")):
        return "google"
    if re.match(r"(gpt-|chatgpt-|o\d)", name):
        return "openai"
    return "ollama"


def choose(model: str | None, provider: str | None, settings: Settings) -> tuple[str, str]:
    """Work out (provider, model) from what was typed, filling in defaults."""
    model = (model or "").strip() or None
    if provider:
        name = provider_name(provider)
        if name is None:
            raise SetupError(
                f"'{provider}' isn't a provider Polygraph knows.",
                hint=f"Use one of: {', '.join(PROVIDER_NAMES)}",
            )
        if model is None:
            if name == "ollama":
                model = settings.model
            elif name in CHEAPEST:
                model = CHEAPEST[name]
            else:
                raise SetupError("Say which model to test with --model.")
        return name, model
    model = model or settings.model
    return guess_provider(model), model


def make_provider(name: str, settings: Settings, base_url: str | None = None) -> Provider:
    """Build the connector, or explain what's missing."""
    if name == "ollama":
        return OllamaProvider(host=normalize_host(base_url) if base_url else settings.ollama_host)
    if name == "compatible":
        url = base_url or settings.compatible_base_url
        if not url:
            raise SetupError(
                "To use an OpenAI-compatible service, Polygraph needs its address.",
                hint=(
                    "Add --base-url with the service's address (it usually ends in /v1), or paste it "
                    "after OPENAI_COMPATIBLE_BASE_URL= in .env."
                ),
            )
        return CompatibleProvider(normalize_host(url), api_key=settings.compatible_api_key)

    keys = {
        "openai": settings.openai_api_key,
        "anthropic": settings.anthropic_api_key,
        "google": settings.gemini_api_key,
    }
    key = keys.get(name)
    if key is None:
        if name not in keys:
            raise SetupError(f"'{name}' isn't a provider Polygraph knows.")
        raise SetupError(
            f"To use {LABELS[name]}, Polygraph needs your {LABELS[name]} API key.",
            hint=(
                f"Make a key on {LABELS[name]}'s website and set a spending limit there. Then, in the run tab, "
                f"run notepad .env, paste the key right after {_KEY_SETTING[name]}= and save the file."
            ),
        )
    if name == "openai":
        return OpenAIProvider(key, base_url=base_url or OPENAI_URL)
    if name == "anthropic":
        return AnthropicProvider(key, base_url=base_url or ANTHROPIC_URL)
    return GoogleProvider(key, base_url=base_url or GOOGLE_URL)
