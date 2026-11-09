"""Connector for free local models that run in Ollama (https://ollama.com)."""

from __future__ import annotations

import httpx

from polygraph.providers.base import (
    LENGTH,
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
    strip_thinking,
)


class OllamaProvider(HttpProvider):
    name = "ollama"
    label = "Ollama"
    local = True
    # A model's first answer can be slow while it loads into memory, so allow
    # plenty of time for answers. Failing to connect at all should be quick.
    timeout = httpx.Timeout(300.0, connect=5.0)

    def __init__(self, host: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        super().__init__(host, transport)
        self.host = host
        # model name -> exact version, filled in by describe_model() before a run
        self._versions: dict[str, str] = {}

    @property
    def endpoint(self) -> str:
        return self.base_url

    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        options = options or ChatOptions()
        settings: dict[str, object] = {"num_predict": options.max_output_tokens}
        if options.temperature is not None:
            settings["temperature"] = options.temperature
        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": False,
            "options": settings,
        }
        data, seconds = await self._request("POST", "/api/chat", model=model, json=payload)
        try:
            text = data["message"]["content"]
            if not isinstance(text, str):
                raise TypeError
        except (KeyError, TypeError) as exc:
            raise ProviderError("Ollama sent back an answer Polygraph couldn't read.", kind="unreadable") from exc

        done_reason = data.get("done_reason")
        if done_reason == "length":
            finish = LENGTH
        elif done_reason in (None, "stop"):
            finish = STOP
        else:
            finish = str(done_reason)
        return Reply(
            text=strip_thinking(text),
            model=data.get("model") or model,
            seconds=seconds,
            input_tokens=count(data.get("prompt_eval_count")),
            output_tokens=count(data.get("eval_count")),
            finish_reason=finish,
            model_version=self._versions.get(model),
        )

    async def list_models(self) -> list[ModelInfo]:
        data, _ = await self._request("GET", "/api/tags")
        models = data.get("models") if isinstance(data, dict) else None
        if not isinstance(models, list):
            raise ProviderError("Ollama sent back a model list Polygraph couldn't read.", kind="unreadable")
        return [_model_info(entry) for entry in models if isinstance(entry, dict) and entry.get("name")]

    async def describe_model(self, model: str) -> ModelInfo:
        wanted = full_name(model)
        for info in await self.list_models():
            if info.name == wanted:
                if info.version:
                    self._versions[model] = info.version
                return info
        raise _not_downloaded(model)

    def _error(self, response: httpx.Response, model: str | None) -> ProviderError:
        message, _, _ = error_body(response)
        if response.status_code == 404 and "not found" in message.lower() and model:
            return _not_downloaded(model)
        return generic_http_error(self.label, response, [])

    def _cant_connect(self) -> ProviderError:
        return ProviderError(
            f"Can't reach Ollama at {self.host}.",
            hint="Open Ollama from the Start menu, wait a few seconds, then try again.",
            kind="network",
        )


def full_name(model: str) -> str:
    """Ollama calls 'llama3.2' 'llama3.2:latest' in its model list."""
    return model if ":" in model else f"{model}:latest"


def _model_info(entry: dict) -> ModelInfo:
    name = str(entry["name"])
    digest = entry.get("digest")
    details = entry.get("details") if isinstance(entry.get("details"), dict) else {}
    info = {
        key: details[key]
        for key in ("family", "parameter_size", "quantization_level", "format")
        if details.get(key)
    }
    if digest:
        info["digest"] = digest
    if entry.get("modified_at"):
        info["downloaded_at"] = entry["modified_at"]
    # The digest is the fingerprint of the exact download, so it pins the version.
    version = f"{name}@sha256:{digest}" if digest else None
    return ModelInfo(name=name, version=version, details=info)


def _not_downloaded(model: str) -> ProviderError:
    return ProviderError(
        f"The model '{model}' isn't downloaded yet.",
        hint=f"Download it with: ollama pull {model}",
        kind="not_found",
        status=404,
    )
