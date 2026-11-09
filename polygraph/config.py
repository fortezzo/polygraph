"""Settings for Polygraph.

Each setting comes from the first of these that has a value:
1. a real environment variable
2. the .env file in the project folder
3. the default below

Blank values count as "not set", so the empty lines in .env are harmless.
Reading settings never changes the environment of the running program.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Llama 3.2 3B by Meta: a small, free model that runs on your own PC in Ollama.
DEFAULT_MODEL = "llama3.2"
# 127.0.0.1 rather than "localhost": on Windows, "localhost" tries IPv6 first,
# which Ollama doesn't listen on, and that adds a delay to every connection.
DEFAULT_OLLAMA_HOST = "http://127.0.0.1:11434"


@dataclass(frozen=True)
class Settings:
    model: str
    ollama_host: str


def load_settings(env_file: Path | None = None) -> Settings:
    """Read the settings. `env_file` overrides which .env file to use."""
    path = env_file if env_file is not None else find_env_file()
    file_values = dotenv_values(path) if path is not None else {}

    def get(name: str) -> str | None:
        value = os.environ.get(name) or file_values.get(name) or ""
        return value.strip() or None

    return Settings(
        model=get("POLYGRAPH_MODEL") or DEFAULT_MODEL,
        ollama_host=normalize_host(get("OLLAMA_HOST") or DEFAULT_OLLAMA_HOST),
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
