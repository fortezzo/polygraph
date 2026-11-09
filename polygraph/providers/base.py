"""The shared shape of every model connector.

Every connector (Ollama today, cloud providers later) takes a conversation
and returns a Reply, so the rest of Polygraph never cares which one it's using.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Literal

Role = Literal["system", "user", "assistant"]


@dataclass(frozen=True)
class Message:
    """One turn in a conversation."""

    role: Role
    content: str


@dataclass(frozen=True)
class Reply:
    """What the model said back, plus details about the call."""

    text: str
    model: str
    seconds: float
    input_tokens: int | None = None
    output_tokens: int | None = None


class ProviderError(Exception):
    """A problem talking to a model, worded so it's safe and useful to show the user.

    `message` says what went wrong and `hint` says what to do about it.
    Neither may ever contain an API key.
    """

    def __init__(self, message: str, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint


class Provider(ABC):
    """Something that can send a conversation to a model and return its reply."""

    name: str

    @abstractmethod
    async def chat(self, messages: list[Message], model: str) -> Reply:
        """Send the conversation to `model` and return its reply."""
