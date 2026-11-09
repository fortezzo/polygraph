"""Settings for Polygraph.

Each setting comes from the first of these that has a value:
1. a real environment variable
2. the .env file in the project folder
3. the default below

Blank values count as "not set", so the empty lines in .env are harmless.
Reading settings never changes the environment of the running program.

API keys are wrapped in Secret, which prints as ******** so a key can't end up
in a message, a log or a crash report by accident.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Llama 3.2 3B by Meta: a small, free model that runs on your own PC in Ollama.
DEFAULT_MODEL = "llama3.2"
# 127.0.0.1 rather than "localhost": on Windows, "localhost" tries IPv6 first,
# which Ollama doesn't listen on, and that adds a delay to every connection.
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"
# Where saved answers (the cache) and finished runs go.
DEFAULT_CACHE_DIR = PROJECT_ROOT / ".cache"
DEFAULT_RUNS_DIR = PROJECT_ROOT / "runs"


class Secret:
    """An API key. It prints as ******** and only reveal() gives the real value."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "Secret('********')"

    __str__ = __repr__

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Secret) and other._value == self._value

    def __hash__(self) -> int:
        return hash(self._value)


@dataclass(frozen=True)
class Settings:
    model: str
    ollama_host: str
    openai_api_key: Secret | None = field(default=None, repr=False)
    anthropic_api_key: Secret | None = field(default=None, repr=False)
    gemini_api_key: Secret | None = field(default=None, repr=False)
    # Any service that speaks OpenAI's chat format (Groq, OpenRouter, LM Studio...).
    compatible_base_url: str | None = None
    compatible_api_key: Secret | None = field(default=None, repr=False)
    cache_dir: Path = DEFAULT_CACHE_DIR
    runs_dir: Path = DEFAULT_RUNS_DIR

    def secrets(self) -> list[str]:
        """Every API key that's set, so error messages can be scrubbed of them."""
        keys = (self.openai_api_key, self.anthropic_api_key, self.gemini_api_key, self.compatible_api_key)
        return [key.reveal() for key in keys if key is not None]


def load_settings(env_file: Path | None = None) -> Settings:
    """Read the settings. `env_file` overrides which .env file to use."""
    path = env_file if env_file is not None else find_env_file()
    file_values = dotenv_values(path) if path is not None else {}

    def get(name: str) -> str | None:
        value = os.environ.get(name) or file_values.get(name) or ""
        return value.strip() or None

    def secret(*names: str) -> Secret | None:
        for name in names:
            value = get(name)
            if value:
                return Secret(value)
        return None

    def folder(name: str, default: Path) -> Path:
        value = get(name)
        return Path(value).expanduser() if value else default

    compatible_url = get("OPENAI_COMPATIBLE_BASE_URL")
    return Settings(
        model=get("POLYGRAPH_MODEL") or DEFAULT_MODEL,
        ollama_host=normalize_host(get("OLLAMA_HOST") or DEFAULT_OLLAMA_HOST),
        openai_api_key=secret("OPENAI_API_KEY"),
        anthropic_api_key=secret("ANTHROPIC_API_KEY"),
        # Google's own tools read GEMINI_API_KEY first and GOOGLE_API_KEY second.
        gemini_api_key=secret("GEMINI_API_KEY", "GOOGLE_API_KEY"),
        compatible_base_url=normalize_host(compatible_url) if compatible_url else None,
        compatible_api_key=secret("OPENAI_COMPATIBLE_API_KEY"),
        cache_dir=folder("POLYGRAPH_CACHE_DIR", DEFAULT_CACHE_DIR),
        runs_dir=folder("POLYGRAPH_RUNS_DIR", DEFAULT_RUNS_DIR),
    )


def find_env_file() -> Path | None:
    """Use the .env in the current folder, or else the one in the project folder."""
    for candidate in (Path.cwd() / ".env", PROJECT_ROOT / ".env"):
        if candidate.is_file():
            return candidate
    return None


def normalize_host(host: str) -> str:
    """Turn values like 'localhost:11434' into a full URL like 'http://localhost:11434'."""
    host = host.strip().rstrip("/")
    if "://" not in host:
        host = f"http://{host}"
    # 0.0.0.0 tells the Ollama *server* to listen everywhere, but nothing can
    # connect to that address, so talk to this PC instead.
    return host.replace("://0.0.0.0", "://127.0.0.1")
