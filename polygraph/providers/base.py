"""The shared shape of every model connector.

Every connector (Ollama, OpenAI, Anthropic, Google and OpenAI-compatible
services) takes a conversation and returns a Reply, so the rest of Polygraph
never cares which one it's using.

Problems become a ProviderError with a `kind` that says what happened. The
kind decides what Polygraph does next: wait and try again (a busy service), or
stop the whole run (a bad API key would fail every question the same way).
"""

from __future__ import annotations

import email.utils
import re
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any, Literal

import httpx

Role = Literal["system", "user", "assistant"]
# Something that takes an answer's text as it arrives, a few words at a time.
TextSink = Callable[[str], None]

# How every connector reports why an answer ended.
STOP = "stop"  # the model finished its answer
LENGTH = "length"  # the answer hit the length limit and was cut off
REFUSAL = "refusal"  # the model (or its company's filter) refused to answer
BLOCKED = "blocked"  # a safety filter blocked the question or the answer


@dataclass(frozen=True)
class Message:
    """One turn in a conversation."""

    role: Role
    content: str


@dataclass(frozen=True)
class ChatOptions:
    """Settings for one model call. None means "use the model's own default"."""

    max_output_tokens: int = 4096
    temperature: float | None = None
    # A JSON schema (as JSON text) the reply must follow. Connectors that can
    # enforce one do (OpenAI's structured outputs, Ollama's format); the others
    # ignore it, and the prompt itself asks for the JSON. The judge uses this;
    # bots never do.
    json_schema: str | None = None
    # Ollama only: how many tokens the model can hold at once (its num_ctx),
    # the prompt and the reply together. None means Ollama's own default, which
    # is 4,096 on this PC: plenty for the bots (their longest saved prompt is
    # about 1,500 tokens), but too little for the judge's rubric, which Ollama
    # would quietly cut from the start. The local judge sets it; bots never do.
    context_window: int | None = None
    # Ollama only: turn a thinking model's thinking on (True) or off (False).
    # None means the model's own default. The local judge sets it; bots never do.
    think: bool | None = None
    # Anthropic only: how hard a Claude 5.x model thinks (output_config.effort):
    # low, medium, high, xhigh or max. None means the model's own default. A
    # Claude judge can set it (Session 9); bots never do.
    effort: str | None = None

    def as_dict(self) -> dict[str, Any]:
        settings: dict[str, Any] = {"max_output_tokens": self.max_output_tokens, "temperature": self.temperature}
        # Only included when set, so every answer saved before these existed
        # keeps the same cache key.
        if self.json_schema is not None:
            settings["json_schema"] = self.json_schema
        if self.context_window is not None:
            settings["context_window"] = self.context_window
        if self.think is not None:
            settings["think"] = self.think
        if self.effort is not None:
            settings["effort"] = self.effort
        return settings


@dataclass(frozen=True)
class Reply:
    """What the model said back, plus details about the call."""

    text: str
    model: str  # the model name the provider reported back
    seconds: float
    input_tokens: int | None = None
    # Billed output tokens, including any hidden "thinking" the model did first.
    output_tokens: int | None = None
    reasoning_tokens: int | None = None  # the part of output_tokens spent thinking
    finish_reason: str | None = None  # STOP, LENGTH, REFUSAL, BLOCKED or the provider's own word
    # The exact version that answered: a dated snapshot name for cloud models,
    # or the download's fingerprint (digest) for Ollama.
    model_version: str | None = None
    # Input tokens the provider stored in its own prompt cache, which some
    # providers charge a little extra for. Already included in input_tokens.
    cache_write_tokens: int | None = None
    # How hard the model thought, as the provider reports it for this reply
    # (OpenAI says "low", "medium", "high" and so on). None when it doesn't say.
    thinking_level: str | None = None

    @property
    def truncated(self) -> bool:
        return self.finish_reason == LENGTH


@dataclass(frozen=True)
class ModelInfo:
    """A model a provider offers, as listed by the provider itself."""

    name: str
    version: str | None = None  # exact version, when the provider says
    details: dict[str, Any] = field(default_factory=dict)


ErrorKind = Literal[
    "auth",  # the API key is missing, wrong or not allowed to do this
    "quota",  # out of credit or over a spending limit
    "not_found",  # no model by that name
    "bad_request",  # the provider refused the question as written
    "rate_limit",  # too many questions too fast: wait and retry
    "overloaded",  # the service is busy or having problems: wait and retry
    "timeout",  # no answer in time: retry
    "network",  # couldn't connect: retry
    "unreadable",  # an answer Polygraph couldn't read: retry
    "error",  # anything else
]

# Problems that would hit every question the same way, so the run stops.
FATAL_KINDS = frozenset({"auth", "quota", "not_found"})
# Problems that are usually temporary, so the question is tried again.
RETRYABLE_KINDS = frozenset({"rate_limit", "overloaded", "timeout", "network", "unreadable"})


class ProviderError(Exception):
    """A problem talking to a model, worded so it's safe and useful to show the user.

    `message` says what went wrong and `hint` says what to do about it.
    Neither may ever contain an API key.
    """

    def __init__(
        self,
        message: str,
        hint: str | None = None,
        *,
        kind: ErrorKind = "error",
        status: int | None = None,
        retry_after: float | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.kind = kind
        self.status = status
        self.retry_after = retry_after  # seconds the provider asked us to wait, if it said

    @property
    def retryable(self) -> bool:
        return self.kind in RETRYABLE_KINDS

    @property
    def fatal(self) -> bool:
        return self.kind in FATAL_KINDS

    def __str__(self) -> str:
        return self.message


class Provider(ABC):
    """Something that can send a conversation to a model and return its reply."""

    name: str  # short ID used on the command line, like "openai"
    label: str  # the name people see, like "OpenAI"
    local: bool = False  # runs on this PC, so it's free

    @property
    def identity(self) -> str:
        """Which service this is, for the answer cache. Two connectors with the
        same identity and model give the same kind of answers."""
        return self.name

    @property
    def endpoint(self) -> str | None:
        """The web address it talks to, when that's worth recording (never secret)."""
        return None

    @abstractmethod
    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        """Send the conversation to `model` and return its reply."""

    async def chat_stream(
        self, messages: list[Message], model: str, options: ChatOptions | None = None, on_text: TextSink | None = None
    ) -> Reply:
        """Like chat(), but hands the answer's text to `on_text` as the model
        writes it (for the live dashboard). The Reply at the end is the same
        as chat() would give. A connector that can't stream hands over the
        whole answer at once."""
        reply = await self.chat(messages, model, options)
        if on_text is not None and reply.text:
            on_text(reply.text)
        return reply

    async def list_models(self) -> list[ModelInfo]:
        """The models this provider offers right now, straight from the provider."""
        raise ProviderError(f"{self.label} can't list its models.")

    async def describe_model(self, model: str) -> ModelInfo:
        """Check that `model` exists before a run starts, and say exactly which
        version it is if the provider tells us. Raises ProviderError if not."""
        return ModelInfo(name=model)

    async def thinks_by_default(self, model: str) -> bool:
        """Whether a model thinks before answering when it isn't told either
        way, as the provider itself reports it. Only Ollama says (its models'
        details do); for cloud models Polygraph's price list says instead."""
        return False

    async def __aenter__(self) -> Provider:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        return None


# --- Connectors that talk to a web service -----------------------------------

# Patterns that look like API keys, scrubbed from any text a provider sends back.
_KEY_PATTERNS = re.compile(
    r"(sk-[A-Za-z0-9_\-*]{8,}|AIza[0-9A-Za-z_\-]{20,}|gsk_[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{20,})"
)


def redact(text: str, secrets: list[str] | tuple[str, ...] = ()) -> str:
    """Remove API keys (and anything that looks like one) from `text`."""
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[hidden]")
    return _KEY_PATTERNS.sub("[hidden]", text)


def parse_retry_after(value: str | None) -> float | None:
    """Read a Retry-After header: either seconds ('20') or a date."""
    if not value:
        return None
    value = value.strip()
    try:
        seconds = float(value)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return None
        seconds = when.timestamp() - time.time()
    return max(0.0, seconds)


class HttpProvider(Provider):
    """A connector that talks to a web service with httpx.

    Inside `async with provider:` it keeps one connection open for many
    questions, which is much faster for a run. On its own, each call opens and
    closes its own connection.
    """

    # Models that think before answering can take minutes on a hard question,
    # so allow 10 minutes for an answer. Failing to connect should be quick.
    timeout = httpx.Timeout(600.0, connect=10.0)

    def __init__(self, base_url: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.base_url = base_url.rstrip("/")
        self._transport = transport  # tests swap in a fake network here
        self._client: httpx.AsyncClient | None = None
        self._open_sessions = 0

    # Each connector says how to sign its requests and how to read its errors.
    def _headers(self) -> dict[str, str]:
        return {}

    def _secrets(self) -> list[str]:
        return []

    def _error(self, response: httpx.Response, model: str | None) -> ProviderError:
        return generic_http_error(self.label, response, self._secrets())

    def _new_client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url, timeout=self.timeout, transport=self._transport, headers=self._headers()
        )

    async def __aenter__(self) -> HttpProvider:
        if self._client is None:
            self._client = self._new_client()
        self._open_sessions += 1
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        self._open_sessions -= 1
        if self._open_sessions <= 0 and self._client is not None:
            await self._client.aclose()
            self._client = None
            self._open_sessions = 0

    @asynccontextmanager
    async def _session(self) -> AsyncIterator[httpx.AsyncClient]:
        if self._client is not None:
            yield self._client
        else:
            async with self._new_client() as client:
                yield client

    async def _request(
        self, method: str, path: str, *, model: str | None = None, json: Any = None, params: Any = None
    ) -> tuple[Any, float]:
        """Send one request and return (the JSON answer, seconds it took)."""
        started = time.perf_counter()
        try:
            async with self._session() as client:
                response = await client.request(method, path, json=json, params=params)
        except httpx.ConnectError as exc:
            raise self._cant_connect() from exc
        except httpx.TimeoutException as exc:
            raise ProviderError(
                f"{self.label} took too long to answer.",
                hint="Polygraph will try again. If it keeps happening, try again later.",
                kind="timeout",
            ) from exc
        except httpx.HTTPError as exc:
            detail = redact(str(exc), self._secrets()) or type(exc).__name__
            raise ProviderError(
                f"The connection to {self.label} broke ({detail}).", kind="network"
            ) from exc
        seconds = time.perf_counter() - started
        if response.is_error:
            raise self._error(response, model)
        try:
            return response.json(), seconds
        except ValueError as exc:
            raise ProviderError(
                f"{self.label} sent back an answer Polygraph couldn't read.", kind="unreadable"
            ) from exc

    async def _lines(
        self, method: str, path: str, *, model: str | None = None, json: Any = None, params: Any = None
    ) -> AsyncIterator[str]:
        """Send one request and hand back the answer line by line, as it
        arrives (for streamed answers). Problems become ProviderErrors, the
        same as _request()."""
        try:
            async with self._session() as client:
                async with client.stream(method, path, json=json, params=params) as response:
                    if response.is_error:
                        await response.aread()
                        raise self._error(response, model)
                    async for line in response.aiter_lines():
                        yield line
        except httpx.ConnectError as exc:
            raise self._cant_connect() from exc
        except httpx.TimeoutException as exc:
            raise ProviderError(
                f"{self.label} took too long to answer.",
                hint="Polygraph will try again. If it keeps happening, try again later.",
                kind="timeout",
            ) from exc
        except httpx.HTTPError as exc:
            detail = redact(str(exc), self._secrets()) or type(exc).__name__
            raise ProviderError(f"The connection to {self.label} broke ({detail}).", kind="network") from exc

    def _cant_connect(self) -> ProviderError:
        host = httpx.URL(self.base_url).host or self.base_url
        return ProviderError(
            f"Can't reach {self.label} at {host}.",
            hint="Check your internet connection, then try again.",
            kind="network",
        )

    def _unfinished(self) -> ProviderError:
        """The stream ended before the model said it was done."""
        return ProviderError(f"{self.label} stopped sending before the answer was finished.", kind="network")


async def sse_events(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str | None, str]]:
    """Read Server-Sent Events (the streaming format OpenAI, Anthropic, Google
    and OpenAI-compatible services use): (event name, data) for each event."""
    event: str | None = None
    data: list[str] = []
    async for line in lines:
        if line == "":
            if data:
                yield event, "\n".join(data)
            event, data = None, []
            continue
        if line.startswith(":"):
            continue  # a comment, often sent to keep the connection open
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "event":
            event = value
        elif name == "data":
            data.append(value)
    if data:
        yield event, "\n".join(data)


def error_body(response: httpx.Response) -> tuple[str, str | None, str | None]:
    """Pull (message, type, code) out of the usual {"error": {...}} shapes."""
    try:
        body = response.json()
    except ValueError:
        body = None
    message, kind, code = "", None, None
    if isinstance(body, dict):
        error = body.get("error", body)
        if isinstance(error, dict):
            message = str(error.get("message") or error.get("detail") or "")
            kind = error.get("type") or error.get("status")
            code = error.get("code")
            code = str(code) if code is not None else None
            kind = str(kind) if kind is not None else None
        elif isinstance(error, str):
            message = error
    if not message:
        message = response.text.strip()[:300] or response.reason_phrase
    return message.strip(), kind, code


def generic_http_error(label: str, response: httpx.Response, secrets: list[str]) -> ProviderError:
    """Turn an HTTP error into a ProviderError, by status code."""
    message, _, _ = error_body(response)
    message = redact(message, secrets)[:300]
    status = response.status_code
    retry_after = parse_retry_after(response.headers.get("retry-after"))
    if status == 401:
        return ProviderError(
            f"{label} didn't accept the API key.",
            hint="Check the key in .env (notepad .env in the run tab), save the file, then try again.",
            kind="auth",
            status=status,
        )
    if status == 403:
        return ProviderError(
            f"{label} says this API key isn't allowed to do that: {message}",
            hint="Check the key's permissions in your account settings.",
            kind="auth",
            status=status,
        )
    if status == 404:
        return ProviderError(f"{label} couldn't find that ({message}).", kind="not_found", status=status)
    if status == 429:
        return ProviderError(
            f"{label} says too many requests, too fast.",
            kind="rate_limit",
            status=status,
            retry_after=retry_after,
        )
    if status in (408, 409, 425) or status >= 500:
        return ProviderError(
            f"{label} is having trouble right now ({status}): {message}",
            kind="overloaded",
            status=status,
            retry_after=retry_after,
        )
    return ProviderError(f"{label} returned an error ({status}): {message}", kind="bad_request", status=status)


def count(value: Any) -> int | None:
    """A token count from a provider, or None if it's missing or odd."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def add_counts(*values: int | None) -> int | None:
    """Add token counts, ignoring missing ones. None if all are missing."""
    present = [value for value in values if value is not None]
    return sum(present) if present else None


_THINK_BLOCK = re.compile(r"^\s*<think>.*?</think>\s*", re.DOTALL)


def strip_thinking(text: str) -> str:
    """Some local models write their private reasoning inside <think>...</think>
    before the answer. Keep only the answer."""
    return _THINK_BLOCK.sub("", text, count=1)


class ThinkFilter:
    """Hides a <think>...</think> block at the start of a streamed answer, the
    way strip_thinking() does for a whole answer, so the live screen only shows
    the answer itself. (The finished answer is always taken from the whole
    text, so nothing depends on this getting an odd stream exactly right.)"""

    OPEN, CLOSE = "<think>", "</think>"

    def __init__(self, sink: TextSink | None) -> None:
        self.sink = sink
        self.buffer = ""
        self.state = "start"  # start: not sure yet; thinking: inside the block; after: just past it; answer

    def _send(self, text: str) -> None:
        if text and self.sink is not None:
            self.sink(text)

    def __call__(self, text: str) -> None:
        if self.state == "answer":
            self._send(text)
            return
        self.buffer += text
        if self.state == "start":
            head = self.buffer.lstrip()
            if len(head) < len(self.OPEN) and self.OPEN.startswith(head):
                return  # could still turn into <think>
            if not head.startswith(self.OPEN):
                self.state = "answer"
                text, self.buffer = self.buffer, ""
                self._send(text)
                return
            self.state, self.buffer = "thinking", head[len(self.OPEN) :]
        if self.state == "thinking":
            end = self.buffer.find(self.CLOSE)
            if end == -1:
                self.buffer = self.buffer[-(len(self.CLOSE) - 1) :]  # enough to spot "</think>" split in two
                return
            self.state, self.buffer = "after", self.buffer[end + len(self.CLOSE) :]
        if self.state == "after":
            rest = self.buffer.lstrip()
            self.buffer = ""
            if rest:
                self.state = "answer"
                self._send(rest)

    def finish(self) -> None:
        """The stream is over: hand over an answer too short to tell apart from "<think>"."""
        if self.state == "start" and self.buffer:
            text, self.buffer, self.state = self.buffer, "", "answer"
            self._send(text)
