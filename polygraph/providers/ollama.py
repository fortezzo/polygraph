"""Connector for free local models that run in Ollama (https://ollama.com)."""

from __future__ import annotations

import time

import httpx

from polygraph.providers.base import Message, Provider, ProviderError, Reply

# A model's first answer can be slow while it loads into memory, so allow
# plenty of time for answers. Failing to connect at all should be quick.
TIMEOUT = httpx.Timeout(300.0, connect=5.0)


class OllamaProvider(Provider):
    name = "ollama"

    def __init__(self, host: str, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.host = host
        self._transport = transport  # tests swap in a fake network here

    async def chat(self, messages: list[Message], model: str) -> Reply:
        payload = {
            "model": model,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "stream": False,
        }
        started = time.perf_counter()
        try:
            async with httpx.AsyncClient(
                base_url=self.host, timeout=TIMEOUT, transport=self._transport
            ) as client:
                response = await client.post("/api/chat", json=payload)
        except httpx.ConnectError as exc:
            raise ProviderError(
                f"Can't reach Ollama at {self.host}.",
                hint="Open Ollama from the Start menu, wait a few seconds, then try again.",
            ) from exc
        except httpx.TimeoutException as exc:
            raise ProviderError(
                f"Ollama took too long to answer with '{model}'.",
                hint="Try again. If it keeps happening, try a smaller model.",
            ) from exc
        except httpx.HTTPError as exc:
            raise ProviderError(f"Something went wrong talking to Ollama: {exc}") from exc
        seconds = time.perf_counter() - started

        if response.status_code == 404 and "not found" in _error_detail(response).lower():
            raise ProviderError(
                f"The model '{model}' isn't downloaded yet.",
                hint=f"Download it with: ollama pull {model}",
            )
        if response.is_error:
            raise ProviderError(
                f"Ollama returned an error ({response.status_code}): {_error_detail(response)}"
            )

        try:
            data = response.json()
            text = data["message"]["content"]
        except (ValueError, KeyError, TypeError) as exc:
            raise ProviderError("Ollama sent back an answer Polygraph couldn't read.") from exc

        return Reply(
            text=text,
            model=data.get("model") or model,
            seconds=seconds,
            input_tokens=data.get("prompt_eval_count"),
            output_tokens=data.get("eval_count"),
        )


def _error_detail(response: httpx.Response) -> str:
    """Ollama explains errors as {"error": "..."}. Fall back to the raw text."""
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict) and body.get("error"):
        return str(body["error"]).strip()
    return response.text.strip()[:200] or response.reason_phrase
