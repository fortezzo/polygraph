"""Tests for streamed answers (Session 8): every connector can hand over the
answer's text a few words at a time, for the live dashboard, and the finished
Reply is exactly what the same answer gives when it isn't streamed.

The streams are faked in each company's documented streaming format (checked
on 2026-11-09). Nothing here uses the internet or costs anything.
"""

from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from polygraph.config import Secret
from polygraph.providers import (
    BLOCKED,
    LENGTH,
    STOP,
    AnthropicProvider,
    ChatOptions,
    CompatibleProvider,
    GoogleProvider,
    Message,
    OllamaProvider,
    OpenAIProvider,
    Provider,
    ProviderError,
    Reply,
)
from polygraph.providers.base import ThinkFilter, sse_events

FAKE_KEY = "sk-test-FAKE-0123456789abcdefghij"
GOOGLE_KEY = "AIzaFAKEtestKEY0123456789abcdefgh"
QUESTION = [Message("system", "You are the support bot for Bob's Pizza."), Message("user", "Is Sydney the capital?")]


class Network:
    """A fake network: answers each request with the next reply on the list,
    and records every request."""

    def __init__(self, *replies: httpx.Response) -> None:
        self.replies = list(replies)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.replies.pop(0)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)

    def body(self, n: int = -1) -> dict:
        return json.loads(self.requests[n].content)


def sse(*events: tuple[str | None, object]) -> httpx.Response:
    """A Server-Sent Events stream: (event name, data) pairs. Data that isn't a
    string is sent as JSON."""
    lines = []
    for name, data in events:
        if name:
            lines.append(f"event: {name}")
        lines.append(f"data: {data if isinstance(data, str) else json.dumps(data)}")
        lines.append("")
    return httpx.Response(200, content=("\n".join(lines) + "\n").encode(), headers={"content-type": "text/event-stream"})


def ndjson(*objects: dict) -> httpx.Response:
    body = "".join(json.dumps(o) + "\n" for o in objects)
    return httpx.Response(200, content=body.encode(), headers={"content-type": "application/x-ndjson"})


def stream(provider: Provider, model: str, messages=QUESTION, options=None) -> tuple[Reply, list[str]]:
    pieces: list[str] = []
    reply = asyncio.run(provider.chat_stream(messages, model, options, pieces.append))
    return reply, pieces


# --- Ollama ----------------------------------------------------------------------


def ollama(*replies: httpx.Response) -> tuple[OllamaProvider, Network]:
    network = Network(*replies)
    return OllamaProvider("http://127.0.0.1:11434", transport=network.transport), network


def test_ollama_streams_the_answer_line_by_line():
    provider, network = ollama(
        ndjson(
            {"model": "llama3.2", "message": {"role": "assistant", "content": "No, "}, "done": False},
            {"model": "llama3.2", "message": {"role": "assistant", "content": "it's Canberra."}, "done": False},
            {"model": "llama3.2", "message": {"role": "assistant", "content": ""}, "done": True,
             "done_reason": "stop", "prompt_eval_count": 31, "eval_count": 9},
        )
    )
    reply, pieces = stream(provider, "llama3.2")
    assert pieces == ["No, ", "it's Canberra."]
    assert reply.text == "No, it's Canberra."
    assert (reply.input_tokens, reply.output_tokens, reply.finish_reason) == (31, 9, STOP)
    sent = network.body()
    assert sent["stream"] is True
    assert sent["messages"][0] == {"role": "system", "content": "You are the support bot for Bob's Pizza."}


def test_a_streamed_ollama_answer_matches_the_same_answer_not_streamed():
    whole = {"model": "llama3.2", "message": {"role": "assistant", "content": "It's Canberra."}, "done": True,
             "done_reason": "length", "prompt_eval_count": 31, "eval_count": 4096}
    provider, _ = ollama(
        httpx.Response(200, json=whole),
        ndjson({"model": "llama3.2", "message": {"content": "It's "}, "done": False},
               {"model": "llama3.2", "message": {"content": "Canberra."}, "done": False},
               {**whole, "message": {"content": ""}}),
    )
    plain = asyncio.run(provider.chat(QUESTION, "llama3.2"))
    streamed, _ = stream(provider, "llama3.2")
    assert streamed.text == plain.text
    assert (streamed.input_tokens, streamed.output_tokens, streamed.finish_reason) == (
        plain.input_tokens, plain.output_tokens, plain.finish_reason)
    assert streamed.truncated and streamed.finish_reason == LENGTH


def test_ollama_hides_private_thinking_while_streaming_too():
    provider, _ = ollama(
        ndjson({"message": {"content": "<thi"}, "done": False},
               {"message": {"content": "nk>Let me check.</th"}, "done": False},
               {"message": {"content": "ink>\n\nCanberra."}, "done": False},
               {"message": {"content": ""}, "done": True, "done_reason": "stop"})
    )
    reply, pieces = stream(provider, "deepseek-r1")
    assert "".join(pieces) == "Canberra."
    assert reply.text == "Canberra."


def test_ollama_trouble_partway_through_is_tried_again():
    provider, _ = ollama(ndjson({"message": {"content": "No"}, "done": False}, {"error": "model runner has unexpectedly stopped"}))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "llama3.2")
    assert caught.value.retryable


def test_an_ollama_stream_that_never_finishes_is_an_error():
    provider, _ = ollama(ndjson({"message": {"content": "No, it's"}, "done": False}))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "llama3.2")
    assert caught.value.kind == "network" and "stopped sending" in caught.value.message


def test_ollama_model_not_downloaded_when_streaming():
    provider, _ = ollama(httpx.Response(404, json={"error": "model 'gemma9' not found"}))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "gemma9")
    assert caught.value.kind == "not_found" and "ollama pull gemma9" in (caught.value.hint or "")


# --- OpenAI (Responses API) ----------------------------------------------------------

OPENAI_DONE = {
    "id": "resp_1",
    "object": "response",
    "status": "completed",
    "model": "gpt-6-luna",
    "output": [
        {"type": "reasoning", "summary": []},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "No, it's Canberra."}]},
    ],
    "usage": {"input_tokens": 41, "output_tokens": 180, "output_tokens_details": {"reasoning_tokens": 170}},
}


def openai(*replies: httpx.Response) -> tuple[OpenAIProvider, Network]:
    network = Network(*replies)
    return OpenAIProvider(Secret(FAKE_KEY), transport=network.transport), network


def test_openai_streams_the_text_then_reads_the_finished_response():
    provider, network = openai(
        sse(("response.created", {"type": "response.created", "response": {**OPENAI_DONE, "status": "in_progress", "output": []}}),
            ("response.output_text.delta", {"type": "response.output_text.delta", "delta": "No, "}),
            ("response.output_text.delta", {"type": "response.output_text.delta", "delta": "it's Canberra."}),
            ("response.completed", {"type": "response.completed", "response": OPENAI_DONE})),
        httpx.Response(200, json=OPENAI_DONE),
    )
    streamed, pieces = stream(provider, "gpt-6-luna")
    plain = asyncio.run(provider.chat(QUESTION, "gpt-6-luna"))
    assert pieces == ["No, ", "it's Canberra."]
    assert streamed == Reply(**{**plain.__dict__, "seconds": streamed.seconds})
    assert network.body(0)["stream"] is True and "stream" not in network.body(1)
    assert network.body(0)["instructions"] == "You are the support bot for Bob's Pizza."


def test_openai_stream_cut_off_by_the_length_limit():
    cut = {**OPENAI_DONE, "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}
    provider, _ = openai(sse(("response.output_text.delta", {"type": "response.output_text.delta", "delta": "No, it"}),
                             ("response.incomplete", {"type": "response.incomplete", "response": cut})))
    reply, _ = stream(provider, "gpt-6-luna")
    assert reply.truncated


@pytest.mark.parametrize(
    ("code", "kind"),
    [("rate_limit_exceeded", "rate_limit"), ("server_error", "overloaded"), ("insufficient_quota", "quota"), ("invalid_prompt", "bad_request")],
)
def test_openai_errors_in_the_middle_of_a_stream(code, kind):
    provider, _ = openai(sse(("error", {"type": "error", "code": code, "message": f"Problem {FAKE_KEY}"})))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "gpt-6-luna")
    assert caught.value.kind == kind
    assert FAKE_KEY not in caught.value.message


def test_openai_bad_key_when_streaming_never_shows_openais_message():
    provider, _ = openai(httpx.Response(401, json={"error": {"message": f"Incorrect API key provided: {FAKE_KEY[:12]}..."}}))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "gpt-6-luna")
    assert caught.value.kind == "auth" and caught.value.message == "OpenAI didn't accept the API key."


def test_an_openai_stream_without_the_finished_response_is_an_error():
    provider, _ = openai(sse(("response.output_text.delta", {"type": "response.output_text.delta", "delta": "No"})))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "gpt-6-luna")
    assert caught.value.retryable


# --- Anthropic (Messages API) --------------------------------------------------------


def anthropic(*replies: httpx.Response) -> tuple[AnthropicProvider, Network]:
    network = Network(*replies)
    return AnthropicProvider(Secret(FAKE_KEY), transport=network.transport), network


def anthropic_stream(stop_reason: str = "end_turn") -> httpx.Response:
    return sse(
        ("message_start", {"type": "message_start", "message": {
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-haiku-5-5-20261001", "content": [],
            "usage": {"input_tokens": 25, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 10, "output_tokens": 1}}}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Hmm."}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("ping", {"type": "ping"}),
        ("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "No, "}}),
        ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "it's Canberra."}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 1}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop_reason}, "usage": {"output_tokens": 57}}),
        ("message_stop", {"type": "message_stop"}),
    )


def test_anthropic_streams_only_the_visible_answer():
    provider, network = anthropic(anthropic_stream())
    reply, pieces = stream(provider, "claude-haiku-5-5")
    assert pieces == ["No, ", "it's Canberra."]  # the thinking never shows
    assert reply.text == "No, it's Canberra."
    assert (reply.input_tokens, reply.output_tokens, reply.finish_reason) == (35, 57, STOP)
    assert reply.model_version == "claude-haiku-5-5-20261001"
    assert network.body()["stream"] is True and network.body()["system"] == "You are the support bot for Bob's Pizza."


def test_anthropic_stream_cut_off_by_the_length_limit():
    provider, _ = anthropic(anthropic_stream("max_tokens"))
    reply, _ = stream(provider, "claude-haiku-5-5")
    assert reply.finish_reason == LENGTH


def test_anthropic_overloaded_partway_through_is_tried_again():
    provider, _ = anthropic(sse(("error", {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "claude-haiku-5-5")
    assert caught.value.kind == "overloaded" and caught.value.retryable


def test_anthropic_refuses_temperature_before_streaming_anything():
    provider, network = anthropic()
    with pytest.raises(ProviderError):
        stream(provider, "claude-haiku-5-5", options=ChatOptions(temperature=0.2))
    assert network.requests == []


def test_an_anthropic_stream_without_message_stop_is_an_error():
    provider, _ = anthropic(sse(("message_start", {"type": "message_start", "message": {"model": "claude-haiku-5-5", "usage": {}}})))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "claude-haiku-5-5")
    assert caught.value.kind == "network"


# --- Google (streamGenerateContent) ------------------------------------------------------


def google(*replies: httpx.Response) -> tuple[GoogleProvider, Network]:
    network = Network(*replies)
    return GoogleProvider(Secret(GOOGLE_KEY), transport=network.transport), network


def test_google_streams_pieces_and_keeps_the_key_out_of_the_address():
    provider, network = google(
        sse((None, {"candidates": [{"content": {"parts": [{"text": "Thinking it over", "thought": True}], "role": "model"}}]}),
            (None, {"candidates": [{"content": {"parts": [{"text": "No, "}], "role": "model"}}], "modelVersion": "gemini-3.5-flash-lite"}),
            (None, {"candidates": [{"content": {"parts": [{"text": "it's Canberra."}], "role": "model"}, "finishReason": "STOP"}],
                    "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 6, "thoughtsTokenCount": 40},
                    "modelVersion": "gemini-3.5-flash-lite"}))
    )
    reply, pieces = stream(provider, "models/gemini-3.5-flash-lite")
    assert pieces == ["No, ", "it's Canberra."]
    assert (reply.text, reply.finish_reason, reply.input_tokens, reply.output_tokens) == ("No, it's Canberra.", STOP, 12, 46)
    url = network.requests[0].url
    assert url.path.endswith("/models/gemini-3.5-flash-lite:streamGenerateContent")
    assert url.params["alt"] == "sse" and GOOGLE_KEY not in str(url)
    assert network.requests[0].headers["x-goog-api-key"] == GOOGLE_KEY


def test_google_blocked_question_streams_back_as_an_empty_blocked_answer():
    provider, _ = google(sse((None, {"promptFeedback": {"blockReason": "SAFETY"}, "usageMetadata": {"promptTokenCount": 9}})))
    reply, pieces = stream(provider, "gemini-3.5-flash-lite")
    assert pieces == [] and reply.text == "" and reply.finish_reason == BLOCKED


def test_google_cut_off_by_the_length_limit_when_streaming():
    provider, _ = google(sse((None, {"candidates": [{"content": {"parts": [{"text": "No"}]}, "finishReason": "MAX_TOKENS"}]})))
    reply, _ = stream(provider, "gemini-3.5-flash-lite")
    assert reply.truncated


# --- OpenAI-compatible services (Chat Completions) ---------------------------------------


def compatible(*replies: httpx.Response) -> tuple[CompatibleProvider, Network]:
    network = Network(*replies)
    return CompatibleProvider("https://api.groq.example/openai/v1", api_key=Secret(FAKE_KEY), transport=network.transport), network


def chunk(content: str | None = None, finish: str | None = None, **extra) -> dict:
    delta = {"content": content} if content is not None else {}
    return {"id": "c1", "object": "chat.completion.chunk", "model": "llama-3.3-70b",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}], **extra}


def test_compatible_streams_chunks_then_the_token_counts():
    provider, network = compatible(
        sse((None, chunk("No, ")), (None, chunk("it's Canberra.")), (None, chunk(finish="stop")),
            (None, {"id": "c1", "choices": [], "model": "llama-3.3-70b", "usage": {"prompt_tokens": 20, "completion_tokens": 7}}),
            (None, "[DONE]"))
    )
    reply, pieces = stream(provider, "llama-3.3-70b")
    assert pieces == ["No, ", "it's Canberra."]
    assert (reply.text, reply.finish_reason, reply.input_tokens, reply.output_tokens) == ("No, it's Canberra.", STOP, 20, 7)
    sent = network.body()
    assert sent["stream"] is True and sent["stream_options"] == {"include_usage": True}


def test_a_service_that_wont_stream_is_asked_again_without_streaming():
    whole = {"choices": [{"message": {"content": "It's Canberra."}, "finish_reason": "stop"}], "model": "local-model",
             "usage": {"prompt_tokens": 20, "completion_tokens": 4}}
    provider, network = compatible(
        httpx.Response(400, json={"error": {"message": "Unrecognized request argument: stream_options"}}),
        httpx.Response(200, json=whole),
    )
    reply, pieces = stream(provider, "local-model")
    assert pieces == ["It's Canberra."]  # the whole answer, at once
    assert reply.text == "It's Canberra."
    assert [network.body(n)["stream"] for n in (0, 1)] == [True, False]


def test_compatible_stream_that_never_finishes_is_an_error():
    provider, _ = compatible(sse((None, chunk("No, it"))))
    with pytest.raises(ProviderError) as caught:
        stream(provider, "llama-3.3-70b")
    assert caught.value.kind == "network"


# --- The pieces ------------------------------------------------------------------------


def test_a_connector_that_cant_stream_hands_over_the_whole_answer():
    class Plain(Provider):
        name, label = "plain", "Plain"

        async def chat(self, messages, model, options=None):
            return Reply(text="Canberra.", model=model, seconds=0.1)

    reply, pieces = stream(Plain(), "m")
    assert pieces == ["Canberra."] and reply.text == "Canberra."


def test_reading_server_sent_events():
    async def lines():
        for line in [": keep-alive", "event: delta", "data: one", "data: two", "", "data: {\"x\": 1}", "", "data: last"]:
            yield line

    async def read():
        return [event async for event in sse_events(lines())]

    assert asyncio.run(read()) == [("delta", "one\ntwo"), (None, '{"x": 1}'), (None, "last")]


@pytest.mark.parametrize(
    ("pieces", "shown"),
    [
        (["<think>", "plan", "</think>", "\n", "Hi"], "Hi"),
        (["<th", "ink>a</thi", "nk> Hi there"], "Hi there"),
        (["Hello", " world"], "Hello world"),
        (["<b>bold</b>"], "<b>bold</b>"),
        (["<t"], "<t"),  # an answer too short to tell apart from <think>
        (["  <think>x</think>Yes"], "Yes"),
    ],
)
def test_private_thinking_is_hidden_while_streaming(pieces, shown):
    out: list[str] = []
    hide = ThinkFilter(out.append)
    for piece in pieces:
        hide(piece)
    hide.finish()
    assert "".join(out) == shown
