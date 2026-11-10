"""Connector for any service that speaks OpenAI's Chat Completions format.

Many services do: Groq, Together, OpenRouter, DeepSeek, Mistral, LM Studio,
vLLM, and Ollama itself (at http://127.0.0.1:11434/v1). Point it at the
service's base URL, which usually ends in /v1.
"""

from __future__ import annotations

import json
import time

import httpx

from polygraph.config import Secret
from polygraph.providers.base import (
    BLOCKED,
    LENGTH,
    REFUSAL,
    STOP,
    ChatOptions,
    HttpProvider,
    Message,
    ModelInfo,
    ProviderError,
    Reply,
    TextSink,
    ThinkFilter,
    count,
    error_body,
    generic_http_error,
    redact,
    sse_events,
    strip_thinking,
)

LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"})


class CompatibleProvider(HttpProvider):
    name = "compatible"

    def __init__(
        self,
        base_url: str,
        api_key: Secret | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        super().__init__(base_url, transport)
        self.api_key = api_key
        url = httpx.URL(self.base_url)
        self.host = url.host or self.base_url
        where = f"{url.host}:{url.port}" if url.port else (url.host or self.base_url)
        self.label = f"OpenAI-compatible service ({where})"
        # A service on this PC (like Ollama or LM Studio) costs nothing.
        self.local = self.host in LOCAL_HOSTS

    @property
    def identity(self) -> str:
        # Different services can use the same model name for different models,
        # so the cache keeps each service's answers apart.
        return f"compatible:{self.base_url}"

    @property
    def endpoint(self) -> str:
        return self.base_url

    def _headers(self) -> dict[str, str]:
        if self.api_key is None:
            return {}
        return {"Authorization": f"Bearer {self.api_key.reveal()}"}

    def _secrets(self) -> list[str]:
        return [self.api_key.reveal()] if self.api_key else []

    def _payload(self, messages: list[Message], model: str, options: ChatOptions, *, stream: bool) -> dict[str, object]:
        payload: dict[str, object] = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_tokens": options.max_output_tokens,
            "stream": stream,
        }
        if stream:
            # Ask for the token counts at the end of the stream, for the cost guard.
            payload["stream_options"] = {"include_usage": True}
        if options.temperature is not None:
            payload["temperature"] = options.temperature
        return payload

    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        payload = self._payload(messages, model, options or ChatOptions(), stream=False)
        data, seconds = await self._request("POST", "/chat/completions", model=model, json=payload)
        return self._reply(data, model, seconds)

    async def chat_stream(
        self, messages: list[Message], model: str, options: ChatOptions | None = None, on_text: TextSink | None = None
    ) -> Reply:
        """Chat Completions streams small chunks with the next few words
        (choices[0].delta.content), then one with the token counts, then
        "[DONE]". A service that won't stream this way gets asked once more
        without streaming, and the whole answer is handed over at once."""
        options = options or ChatOptions()
        payload = self._payload(messages, model, options, stream=True)
        started = time.perf_counter()
        visible = ThinkFilter(on_text)
        texts: list[str] = []
        finish: object = None
        refusal = False
        usage: object = None
        reported: object = None
        done = False
        started_answering = False
        try:
            async for _, data in sse_events(self._lines("POST", "/chat/completions", model=model, json=payload)):
                if data.strip() == "[DONE]":
                    done = True
                    continue
                try:
                    body = json.loads(data)
                except ValueError as exc:
                    raise ProviderError(f"{self.label} sent back an answer Polygraph couldn't read.", kind="unreadable") from exc
                if not isinstance(body, dict):
                    continue
                if body.get("error"):
                    error = body["error"] if isinstance(body["error"], dict) else {"message": str(body["error"])}
                    message = redact(str(error.get("message") or "no reason given"), self._secrets())[:300]
                    raise ProviderError(f"{self.label} couldn't finish the answer: {message}", kind="overloaded")
                started_answering = True
                if isinstance(body.get("model"), str):
                    reported = body["model"]
                if isinstance(body.get("usage"), dict):
                    usage = body["usage"]
                for choice in body.get("choices") or []:
                    if not isinstance(choice, dict):
                        continue
                    delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                    piece = delta.get("content")
                    if isinstance(piece, str) and piece:
                        texts.append(piece)
                        visible(piece)
                    if delta.get("refusal"):
                        refusal = True
                    finish = choice.get("finish_reason") or finish
        except ProviderError as problem:
            if problem.kind == "bad_request" and not started_answering:
                return await super().chat_stream(messages, model, options, on_text)
            raise
        visible.finish()
        if not done and finish is None:
            raise self._unfinished()
        whole = {
            "choices": [{"message": {"content": "".join(texts), "refusal": refusal or None}, "finish_reason": finish}],
            "usage": usage,
            "model": reported,
        }
        return self._reply(whole, model, time.perf_counter() - started)

    def _reply(self, data: object, model: str, seconds: float) -> Reply:
        try:
            choice = data["choices"][0]
            message = choice.get("message") or {}
            text = message.get("content") or ""
            if not isinstance(text, str):
                raise TypeError
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ProviderError(f"{self.label} sent back an answer Polygraph couldn't read.", kind="unreadable") from exc

        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        details = usage.get("completion_tokens_details")
        reasoning = count(details.get("reasoning_tokens")) if isinstance(details, dict) else None
        reported = data.get("model") if isinstance(data.get("model"), str) else None
        return Reply(
            text=strip_thinking(text),
            model=reported or model,
            seconds=seconds,
            input_tokens=count(usage.get("prompt_tokens")),
            output_tokens=count(usage.get("completion_tokens")),
            reasoning_tokens=reasoning,
            finish_reason=_finish(choice.get("finish_reason"), message),
            model_version=reported,
        )

    async def list_models(self) -> list[ModelInfo]:
        data, _ = await self._request("GET", "/models")
        entries = data.get("data") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            raise ProviderError(f"{self.label} sent back a model list Polygraph couldn't read.", kind="unreadable")
        return [ModelInfo(name=str(e["id"])) for e in entries if isinstance(e, dict) and e.get("id")]

    async def describe_model(self, model: str) -> ModelInfo:
        # Not every service can list its models, and some list them under a
        # slightly different name, so this only confirms the service answers.
        try:
            models = await self.list_models()
        except ProviderError as problem:
            if problem.fatal or problem.kind == "network":
                raise
            return ModelInfo(name=model)
        for info in models:
            if info.name in (model, f"{model}:latest"):
                return info
        return ModelInfo(name=model)

    def _error(self, response: httpx.Response, model: str | None) -> ProviderError:
        message, _, code = error_body(response)
        if response.status_code == 404 and model and ("model" in message.lower() or code == "model_not_found"):
            return ProviderError(
                f"{self.label} doesn't have a model called '{model}'.",
                hint="Check the model name on the service's website.",
                kind="not_found",
                status=404,
            )
        if response.status_code == 401 and self.api_key is None:
            return ProviderError(
                f"{self.label} needs an API key.",
                hint="Paste it after OPENAI_COMPATIBLE_API_KEY= in .env (notepad .env in the run tab).",
                kind="auth",
                status=401,
            )
        error = generic_http_error(self.label, response, self._secrets())
        error.message = redact(error.message, self._secrets())
        return error

    def _cant_connect(self) -> ProviderError:
        hint = (
            "Check that the program serving it is running on this PC."
            if self.local
            else "Check the address and your internet connection, then try again."
        )
        return ProviderError(f"Can't reach {self.label} at {self.base_url}.", hint=hint, kind="network")


def _finish(reason: object, message: dict) -> str | None:
    if message.get("refusal"):
        return REFUSAL
    if reason == "stop":
        return STOP
    if reason == "length":
        return LENGTH
    if reason == "content_filter":
        return BLOCKED
    return str(reason) if reason else None
