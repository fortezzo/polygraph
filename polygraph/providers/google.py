"""Connector for Google's Gemini models, through the Gemini API's generateContent.

Checked against Google's docs (now at aistudio.google.com/docs) on 2026-11-08:
- generateContent "remains fully supported" alongside Google's newer
  Interactions API, and it's the one this connector uses.
- The key goes in the x-goog-api-key header, never in the web address, so it
  can't end up in a log of addresses.
- maxOutputTokens includes the model's thinking, which is billed as output.
- Gemini 3.6 Flash and newer silently ignore temperature, so Polygraph only
  sends it if you ask for it.
"""

from __future__ import annotations

import re
from urllib.parse import quote

import httpx

from polygraph.config import Secret
from polygraph.providers.base import (
    BLOCKED,
    LENGTH,
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

GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta"

_BLOCKED_REASONS = {
    "SAFETY",
    "RECITATION",
    "LANGUAGE",
    "BLOCKLIST",
    "PROHIBITED_CONTENT",
    "SPII",
    "IMAGE_SAFETY",
}


class GoogleProvider(HttpProvider):
    name = "google"
    label = "Google"

    def __init__(
        self, api_key: Secret, base_url: str = GOOGLE_URL, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        super().__init__(base_url, transport)
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {"x-goog-api-key": self.api_key.reveal()}

    def _secrets(self) -> list[str]:
        return [self.api_key.reveal()]

    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        options = options or ChatOptions()
        model = bare_name(model)
        system = [m.content for m in messages if m.role == "system"]
        config: dict[str, object] = {"maxOutputTokens": options.max_output_tokens}
        if options.temperature is not None:
            config["temperature"] = options.temperature
        payload: dict[str, object] = {
            "contents": [
                {"role": "model" if m.role == "assistant" else "user", "parts": [{"text": m.content}]}
                for m in messages
                if m.role != "system"
            ],
            "generationConfig": config,
        }
        if system:
            payload["systemInstruction"] = {"parts": [{"text": "\n\n".join(system)}]}
        data, seconds = await self._request(
            "POST", f"/models/{quote(model, safe='-._')}:generateContent", model=model, json=payload
        )
        if not isinstance(data, dict):
            raise ProviderError("Google sent back an answer Polygraph couldn't read.", kind="unreadable")

        usage = data.get("usageMetadata") if isinstance(data.get("usageMetadata"), dict) else {}
        thoughts = count(usage.get("thoughtsTokenCount"))
        reported = data.get("modelVersion") if isinstance(data.get("modelVersion"), str) else None
        common = dict(
            model=reported or model,
            seconds=seconds,
            input_tokens=add_counts(count(usage.get("promptTokenCount")), count(usage.get("toolUsePromptTokenCount"))),
            # Google bills the visible answer plus the thinking as output.
            output_tokens=add_counts(count(usage.get("candidatesTokenCount")), thoughts),
            reasoning_tokens=thoughts,
            model_version=reported,
        )

        candidates = data.get("candidates")
        if not isinstance(candidates, list) or not candidates:
            feedback = data.get("promptFeedback") if isinstance(data.get("promptFeedback"), dict) else {}
            if feedback.get("blockReason"):
                # Google's safety filter blocked the question before the model saw it.
                return Reply(text="", finish_reason=BLOCKED, **common)
            raise ProviderError("Google sent back an answer with nothing in it.", kind="unreadable")

        candidate = candidates[0] if isinstance(candidates[0], dict) else {}
        content = candidate.get("content") if isinstance(candidate.get("content"), dict) else {}
        parts = content.get("parts") if isinstance(content.get("parts"), list) else []
        # Parts marked "thought" are the model's private notes, not its answer.
        text = "".join(
            part["text"]
            for part in parts
            if isinstance(part, dict) and isinstance(part.get("text"), str) and not part.get("thought")
        )
        reason = candidate.get("finishReason")
        if reason == "STOP":
            finish = STOP
        elif reason in ("MAX_TOKENS", "CONTINUATION"):
            finish = LENGTH
        elif reason in _BLOCKED_REASONS:
            finish = BLOCKED
        else:
            finish = str(reason).lower() if reason else None
        return Reply(text=text, finish_reason=finish, **common)

    async def list_models(self) -> list[ModelInfo]:
        models: list[ModelInfo] = []
        params: dict[str, object] = {"pageSize": 1000}
        for _ in range(20):  # pages; far more than Google has
            data, _ = await self._request("GET", "/models", params=params)
            entries = data.get("models") if isinstance(data, dict) else None
            if not isinstance(entries, list):
                raise ProviderError("Google sent back a model list Polygraph couldn't read.", kind="unreadable")
            for entry in entries:
                if not isinstance(entry, dict) or not entry.get("name"):
                    continue
                methods = entry.get("supportedGenerationMethods") or entry.get("supportedActions") or []
                if "generateContent" in methods:
                    models.append(_model_info(entry))
            token = data.get("nextPageToken")
            if not token:
                break
            params = {"pageSize": 1000, "pageToken": token}
        return models

    async def describe_model(self, model: str) -> ModelInfo:
        name = bare_name(model)
        data, _ = await self._request("GET", f"/models/{quote(name, safe='-._')}", model=name)
        if not isinstance(data, dict) or not data.get("name"):
            raise ProviderError("Google sent back model details Polygraph couldn't read.", kind="unreadable")
        return _model_info(data)

    def _error(self, response: httpx.Response, model: str | None) -> ProviderError:
        message, kind, _ = error_body(response)
        reasons = _detail_reasons(response)
        lowered = message.lower()
        status = response.status_code
        if "API_KEY_INVALID" in reasons or "api key not valid" in lowered or status == 401:
            return ProviderError(
                "Google didn't accept the API key.",
                hint="Check GEMINI_API_KEY in .env (notepad .env in the run tab), save the file, then try again.",
                kind="auth",
                status=status,
            )
        if status == 403:
            return ProviderError(
                "Google says this API key isn't allowed to use the Gemini API.",
                hint=(
                    "Make a key in Google AI Studio, or restrict your key to the Gemini API in "
                    "Google Cloud, then paste it into .env."
                ),
                kind="auth",
                status=status,
            )
        if status == 402 or kind == "FAILED_PRECONDITION" or _out_of_quota(status, lowered, response):
            return ProviderError(
                f"Google won't run more questions on this account right now: {message[:200]}",
                hint="Check billing for your key in Google AI Studio. Daily free limits reset at midnight Pacific time.",
                kind="quota",
                status=status,
            )
        if status == 404 and model:
            return ProviderError(
                f"Google doesn't have a model called '{model}'.",
                hint="To see the models you can use, run: polygraph models google",
                kind="not_found",
                status=status,
            )
        error = generic_http_error(self.label, response, self._secrets())
        if error.kind == "rate_limit" and error.retry_after is None:
            error.retry_after = _retry_delay(response)
        if status == 499:
            error.kind = "overloaded"
        return error


def bare_name(model: str) -> str:
    """Google lists models as 'models/gemini-...'; the address wants just the name."""
    return model.removeprefix("models/")


def _out_of_quota(status: int, message: str, response: httpx.Response) -> bool:
    """Limits that waiting a minute won't fix: a spending limit, or the day's
    quota. Google's ordinary "slow down" message also mentions billing, so
    that alone doesn't count."""
    if "spend" in message and "limit" in message:
        return True
    if status == 429:
        violations = " ".join(str(d.get("violations", "")) for d in _detail_list(response))
        return "per day" in message or "perday" in message or "PerDay" in violations
    return False


def _detail_list(response: httpx.Response) -> list[dict]:
    try:
        body = response.json()
    except ValueError:
        return []
    error = body.get("error") if isinstance(body, dict) else None
    details = error.get("details") if isinstance(error, dict) else None
    return [d for d in details if isinstance(d, dict)] if isinstance(details, list) else []


def _detail_reasons(response: httpx.Response) -> set[str]:
    return {str(d["reason"]) for d in _detail_list(response) if d.get("reason")}


def _retry_delay(response: httpx.Response) -> float | None:
    """Google sometimes says how long to wait, like {"retryDelay": "34s"}."""
    for detail in _detail_list(response):
        delay = detail.get("retryDelay")
        if isinstance(delay, str):
            match = re.fullmatch(r"(\d+(?:\.\d+)?)s", delay.strip())
            if match:
                return float(match.group(1))
    return None


def _model_info(entry: dict) -> ModelInfo:
    details = {
        key: entry[key]
        for key in ("displayName", "inputTokenLimit", "outputTokenLimit", "thinking")
        if entry.get(key) is not None
    }
    version = entry.get("version") if isinstance(entry.get("version"), str) else None
    return ModelInfo(name=bare_name(str(entry["name"])), version=version, details=details)
