"""Connector for Anthropic's Claude models, through the Messages API.

Checked against Anthropic's docs on 2026-11-08:
- API version 2026-10-21 (the current one). It changed no reply shapes, but it
  refuses temperature, top_p and top_k on every model.
- Every Claude 5.x model thinks before answering unless told otherwise. That
  thinking counts toward max_tokens and is billed as output. Its text comes
  back empty by default, and Polygraph only keeps the visible answer anyway.
"""

from __future__ import annotations

import httpx

from polygraph.config import Secret
from polygraph.providers.base import (
    LENGTH,
    REFUSAL,
    STOP,
    ChatOptions,
    HttpProvider,
    Message,
    ModelInfo,
    ProviderError,
    Reply,
    add_counts,
    count,
    error_body,
    generic_http_error,
)

ANTHROPIC_URL = "https://api.anthropic.com/v1"
API_VERSION = "2026-10-21"


class AnthropicProvider(HttpProvider):
    name = "anthropic"
    label = "Anthropic"

    def __init__(
        self, api_key: Secret, base_url: str = ANTHROPIC_URL, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        super().__init__(base_url, transport)
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {"x-api-key": self.api_key.reveal(), "anthropic-version": API_VERSION}

    def _secrets(self) -> list[str]:
        return [self.api_key.reveal()]

    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        options = options or ChatOptions()
        if options.temperature is not None:
            raise ProviderError(
                "Anthropic's API no longer accepts a temperature setting.",
                hint="Run it again without --temperature.",
                kind="bad_request",
            )
        system = [m.content for m in messages if m.role == "system"]
        payload: dict[str, object] = {
            "model": model,
            "max_tokens": options.max_output_tokens,
            "messages": [{"role": m.role, "content": m.content} for m in messages if m.role != "system"],
        }
        if system:
            payload["system"] = "\n\n".join(system)
        data, seconds = await self._request("POST", "/messages", model=model, json=payload)
        if not isinstance(data, dict) or not isinstance(data.get("content"), list):
            raise ProviderError("Anthropic sent back an answer Polygraph couldn't read.", kind="unreadable")

        # Only the visible answer: "thinking" blocks are the model's private notes.
        text = "".join(
            block["text"]
            for block in data["content"]
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        )
        stop = data.get("stop_reason")
        if stop in ("end_turn", "stop_sequence"):
            finish = STOP
        elif stop in ("max_tokens", "model_context_window_exceeded"):
            finish = LENGTH
        elif stop == "refusal":
            finish = REFUSAL
        else:
            finish = str(stop) if stop else None

        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        output_details = (
            usage.get("output_tokens_details") if isinstance(usage.get("output_tokens_details"), dict) else {}
        )
        reported = data.get("model") if isinstance(data.get("model"), str) else None
        return Reply(
            text=text,
            model=reported or model,
            seconds=seconds,
            # Anthropic splits the input into fresh, cache-written and cache-read
            # tokens. Polygraph counts them all at the full input price.
            input_tokens=add_counts(
                count(usage.get("input_tokens")),
                count(usage.get("cache_creation_input_tokens")),
                count(usage.get("cache_read_input_tokens")),
            ),
            # output_tokens is the full billed total, thinking included.
            output_tokens=count(usage.get("output_tokens")),
            reasoning_tokens=count(output_details.get("thinking_tokens")),
            finish_reason=finish,
            model_version=reported,
        )

    async def list_models(self) -> list[ModelInfo]:
        models: list[ModelInfo] = []
        params: dict[str, object] = {"limit": 1000}
        for _ in range(20):  # pages; far more than Anthropic has
            data, _ = await self._request("GET", "/models", params=params)
            entries = data.get("data") if isinstance(data, dict) else None
            if not isinstance(entries, list):
                raise ProviderError("Anthropic sent back a model list Polygraph couldn't read.", kind="unreadable")
            models.extend(_model_info(e) for e in entries if isinstance(e, dict) and e.get("id"))
            if not data.get("has_more") or not data.get("last_id"):
                break
            params = {"limit": 1000, "after_id": data["last_id"]}
        return models

    async def describe_model(self, model: str) -> ModelInfo:
        data, _ = await self._request("GET", f"/models/{model}", model=model)
        if not isinstance(data, dict) or not data.get("id"):
            raise ProviderError("Anthropic sent back model details Polygraph couldn't read.", kind="unreadable")
        return _model_info(data)

    def _error(self, response: httpx.Response, model: str | None) -> ProviderError:
        message, _, _ = error_body(response)
        lowered = message.lower()
        status = response.status_code
        details_code = _details_code(response)
        if status == 401:
            return ProviderError(
                "Anthropic didn't accept the API key.",
                hint="Check ANTHROPIC_API_KEY in .env (notepad .env in the run tab), save the file, then try again.",
                kind="auth",
                status=status,
            )
        if (
            status == 402
            or details_code == "enforced_spend_limit_reached"
            or "credit balance" in lowered
            or "spend limit" in lowered
        ):
            return ProviderError(
                "Your Anthropic account is out of credit or has reached its spending limit.",
                hint="Add credit or raise the limit on Anthropic's billing page, then try again.",
                kind="quota",
                status=status,
            )
        if status == 404 and model:
            return ProviderError(
                f"Anthropic doesn't have a model called '{model}', or this key can't use it.",
                hint="To see the models you can use, run: polygraph models anthropic",
                kind="not_found",
                status=status,
            )
        if status == 529:
            return ProviderError(
                "Anthropic is overloaded right now.", kind="overloaded", status=status
            )
        return generic_http_error(self.label, response, self._secrets())


def _details_code(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    error = body.get("error") if isinstance(body, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    code = details.get("error_code") if isinstance(details, dict) else None
    return str(code) if code else None


def _model_info(entry: dict) -> ModelInfo:
    details = {
        key: entry[key]
        for key in ("display_name", "created_at", "max_tokens", "lifecycle", "retires_at")
        if entry.get(key) is not None
    }
    return ModelInfo(name=str(entry["id"]), details=details)
