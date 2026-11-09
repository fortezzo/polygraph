"""Connector for OpenAI's models, through the Responses API.

Checked against OpenAI's docs on 2026-11-08: the Responses API is the one
OpenAI recommends for new projects (Chat Completions still works, and the
OpenAI-compatible connector uses it). Every current OpenAI model thinks before
answering. That thinking is billed as output and counts toward the answer's
length limit, which is why Polygraph gives thinking models a generous limit.
"""

from __future__ import annotations

import json
import re

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
    count,
    error_body,
    generic_http_error,
    redact,
)

OPENAI_URL = "https://api.openai.com/v1"
MIN_OUTPUT_TOKENS = 16  # OpenAI refuses a smaller limit

# Error codes that mean the account is out of credit or over a spending limit.
# Waiting won't fix these, so the run stops instead of retrying.
_OUT_OF_CREDIT = {
    "insufficient_quota",
    "credit_balance_exhausted",
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
    "billing_hard_limit_reached",
}
# Models in OpenAI's list that don't chat (images, speech, embeddings...).
_NOT_CHAT = re.compile(r"(embedding|tts|whisper|transcribe|audio|realtime|image|dall-e|moderation|search|sora)")


class OpenAIProvider(HttpProvider):
    name = "openai"
    label = "OpenAI"

    def __init__(
        self, api_key: Secret, base_url: str = OPENAI_URL, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        super().__init__(base_url, transport)
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key.reveal()}"}

    def _secrets(self) -> list[str]:
        return [self.api_key.reveal()]

    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        options = options or ChatOptions()
        system = [m.content for m in messages if m.role == "system"]
        payload: dict[str, object] = {
            "model": model,
            "input": [{"role": m.role, "content": m.content} for m in messages if m.role != "system"],
            "max_output_tokens": max(MIN_OUTPUT_TOKENS, options.max_output_tokens),
            # Don't keep a copy of the conversation on OpenAI's side.
            "store": False,
        }
        if system:
            payload["instructions"] = "\n\n".join(system)
        if options.temperature is not None:
            payload["temperature"] = options.temperature
        if options.json_schema is not None:
            # Structured outputs: the reply is guaranteed to match the schema.
            payload["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": "polygraph_reply",
                    "schema": json.loads(options.json_schema),
                    "strict": True,
                }
            }
        data, seconds = await self._request("POST", "/responses", model=model, json=payload)
        if not isinstance(data, dict):
            raise ProviderError("OpenAI sent back an answer Polygraph couldn't read.", kind="unreadable")
        if data.get("status") == "failed":
            raise self._failed(data)

        texts: list[str] = []
        refusals: list[str] = []
        for item in data.get("output") or []:
            if not isinstance(item, dict) or item.get("type") != "message":
                continue  # skips the hidden "reasoning" items
            for part in item.get("content") or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "output_text" and isinstance(part.get("text"), str):
                    texts.append(part["text"])
                elif part.get("type") == "refusal" and isinstance(part.get("refusal"), str):
                    refusals.append(part["refusal"])

        incomplete = (data.get("incomplete_details") or {}).get("reason")
        if refusals and not texts:
            finish = REFUSAL
        elif incomplete == "max_output_tokens":
            finish = LENGTH
        elif incomplete == "content_filter":
            finish = BLOCKED
        elif incomplete:
            finish = str(incomplete)
        else:
            finish = STOP

        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        input_details = usage.get("input_tokens_details") if isinstance(usage.get("input_tokens_details"), dict) else {}
        output_details = (
            usage.get("output_tokens_details") if isinstance(usage.get("output_tokens_details"), dict) else {}
        )
        reported = data.get("model") if isinstance(data.get("model"), str) else None
        return Reply(
            text="".join(texts) if texts else "\n".join(refusals),
            model=reported or model,
            seconds=seconds,
            input_tokens=count(usage.get("input_tokens")),
            # output_tokens already includes the thinking (reasoning) tokens.
            output_tokens=count(usage.get("output_tokens")),
            reasoning_tokens=count(output_details.get("reasoning_tokens")),
            finish_reason=finish,
            model_version=reported,
            cache_write_tokens=_cache_writes(input_details.get("cache_write_tokens")),
        )

    async def list_models(self) -> list[ModelInfo]:
        data, _ = await self._request("GET", "/models")
        entries = data.get("data") if isinstance(data, dict) else None
        if not isinstance(entries, list):
            raise ProviderError("OpenAI sent back a model list Polygraph couldn't read.", kind="unreadable")
        models = []
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                continue
            if _NOT_CHAT.search(entry["id"]):
                continue
            models.append(_model_info(entry))
        return sorted(models, key=lambda info: info.name)

    async def describe_model(self, model: str) -> ModelInfo:
        data, _ = await self._request("GET", f"/models/{model}", model=model)
        if not isinstance(data, dict) or not data.get("id"):
            raise ProviderError("OpenAI sent back model details Polygraph couldn't read.", kind="unreadable")
        return _model_info(data)

    def _failed(self, data: dict) -> ProviderError:
        error = data.get("error") if isinstance(data.get("error"), dict) else {}
        code = str(error.get("code") or "")
        message = redact(str(error.get("message") or "no reason given"), self._secrets())[:300]
        retryable = code in {"server_error", "rate_limit_exceeded"} or "overload" in code
        return ProviderError(
            f"OpenAI couldn't finish the answer: {message}",
            kind="overloaded" if retryable else "bad_request",
        )

    def _error(self, response: httpx.Response, model: str | None) -> ProviderError:
        message, kind, code = error_body(response)
        status = response.status_code
        if status == 401:
            # OpenAI's own message repeats part of the key, so it's never shown.
            return ProviderError(
                "OpenAI didn't accept the API key.",
                hint="Check OPENAI_API_KEY in .env (notepad .env in the run tab), save the file, then try again.",
                kind="auth",
                status=status,
            )
        if code in _OUT_OF_CREDIT or kind in _OUT_OF_CREDIT:
            return ProviderError(
                "Your OpenAI account is out of credit or has reached its spending limit.",
                hint="Add credit or raise the limit on OpenAI's billing page, then try again.",
                kind="quota",
                status=status,
            )
        if status == 404 and model:
            return ProviderError(
                f"OpenAI doesn't have a model called '{model}', or this key can't use it.",
                hint="To see the models you can use, run: polygraph models openai",
                kind="not_found",
                status=status,
            )
        if status == 400 and "temperature" in message.lower():
            return ProviderError(
                "This OpenAI model doesn't let you set the temperature.",
                hint="Run it again without --temperature.",
                kind="bad_request",
                status=status,
            )
        return generic_http_error(self.label, response, self._secrets())


def _model_info(entry: dict) -> ModelInfo:
    details = {key: entry[key] for key in ("owned_by", "created", "shutdown_date") if entry.get(key) is not None}
    return ModelInfo(name=str(entry["id"]), details=details)


def _cache_writes(value: object) -> int | None:
    """Tokens written to OpenAI's prompt cache. OpenAI may report one number,
    or split it by how long the cache lasts."""
    if isinstance(value, dict):
        short = count(value.get("ttl_30m_tokens")) or 0
        # The 12-hour cache costs 2.5x the input price instead of 1.25x, so
        # each of its tokens counts as 6 of the 30-minute kind (1.5 / 0.25).
        long = count(value.get("ttl_12h_tokens")) or 0
        return short + 6 * long
    return count(value)
