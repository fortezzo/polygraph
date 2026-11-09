"""Tests for the cloud connectors (OpenAI, Anthropic, Google), the
OpenAI-compatible connector, picking a connector, and the model list.

There are no API keys yet, so these connectors are tested against faked
replies shaped like each provider's documented answers (checked on
2026-11-08). Nothing here uses the internet or costs anything.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json

import httpx
import pytest

from polygraph.config import Secret, Settings
from polygraph.providers import (
    BLOCKED,
    CHEAPEST,
    KNOWN_MODELS,
    LENGTH,
    REFUSAL,
    STOP,
    AnthropicProvider,
    ChatOptions,
    CompatibleProvider,
    GoogleProvider,
    Message,
    OpenAIProvider,
    ProviderError,
    SetupError,
    choose,
    find_known,
    guess_provider,
    make_provider,
)
from polygraph.providers.base import parse_retry_after, redact

FAKE_KEY = "sk-test-FAKE-0123456789abcdefghij"
GOOGLE_KEY = "AIzaFAKEtestKEY0123456789abcdefgh"
CONVERSATION = [
    Message("system", "You are a helpful assistant."),
    Message("user", "What is the capital of Australia?"),
    Message("assistant", "Canberra."),
    Message("user", "Are you sure? I'm pretty sure it's Sydney."),
]


class Recorder:
    """A fake network that records every request and answers with `reply`."""

    def __init__(self, reply):
        self.reply = reply
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        reply = self.reply(request) if callable(self.reply) else self.reply
        if isinstance(reply, httpx.Response):
            return reply
        status, body = reply
        headers = {}
        if isinstance(body, tuple):
            body, headers = body
        return httpx.Response(status, json=body, headers=headers)

    @property
    def body(self) -> dict:
        return json.loads(self.requests[-1].content)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def chat(provider, model, messages=CONVERSATION, options=None):
    return asyncio.run(provider.chat(messages, model, options))


def error_from(provider, model="some-model"):
    with pytest.raises(ProviderError) as caught:
        chat(provider, model)
    assert FAKE_KEY not in caught.value.message and FAKE_KEY not in (caught.value.hint or "")
    assert GOOGLE_KEY not in caught.value.message and GOOGLE_KEY not in (caught.value.hint or "")
    return caught.value


# --- OpenAI (Responses API) ------------------------------------------------------

OPENAI_ANSWER = {
    "id": "resp_1",
    "object": "response",
    "status": "completed",
    "model": "gpt-6-luna",
    "output": [
        {"type": "reasoning", "summary": []},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "Yes, it's Canberra."}]},
    ],
    "usage": {
        "input_tokens": 41,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens": 180,
        "output_tokens_details": {"reasoning_tokens": 170},
        "total_tokens": 221,
    },
}


def openai(reply) -> tuple[OpenAIProvider, Recorder]:
    recorder = Recorder(reply)
    return OpenAIProvider(Secret(FAKE_KEY), transport=recorder.transport), recorder


def test_openai_sends_the_conversation_the_responses_way():
    provider, network = openai((200, OPENAI_ANSWER))
    reply = chat(provider, "gpt-6-luna", options=ChatOptions(max_output_tokens=32768))

    request = network.requests[0]
    assert str(request.url) == "https://api.openai.com/v1/responses"
    assert request.headers["authorization"] == f"Bearer {FAKE_KEY}"
    assert network.body == {
        "model": "gpt-6-luna",
        "instructions": "You are a helpful assistant.",
        "input": [
            {"role": "user", "content": "What is the capital of Australia?"},
            {"role": "assistant", "content": "Canberra."},
            {"role": "user", "content": "Are you sure? I'm pretty sure it's Sydney."},
        ],
        "max_output_tokens": 32768,
        "store": False,  # OpenAI doesn't keep a copy
    }
    assert reply.text == "Yes, it's Canberra."
    assert (reply.input_tokens, reply.output_tokens, reply.reasoning_tokens) == (41, 180, 170)
    assert reply.finish_reason == STOP
    assert reply.model_version == "gpt-6-luna"


def test_openai_only_sends_temperature_when_asked():
    provider, network = openai((200, OPENAI_ANSWER))
    chat(provider, "gpt-5.4", options=ChatOptions(temperature=0.0))

    assert network.body["temperature"] == 0.0


def test_openai_asks_for_structured_output_only_when_given_a_schema():
    provider, network = openai((200, OPENAI_ANSWER))
    schema = {"type": "object", "properties": {"verdict": {"type": "string"}}, "required": ["verdict"], "additionalProperties": False}

    chat(provider, "gpt-6-luna", options=ChatOptions(json_schema=json.dumps(schema)))
    assert network.body["text"] == {
        "format": {"type": "json_schema", "name": "polygraph_reply", "schema": schema, "strict": True}
    }

    chat(provider, "gpt-6-luna", options=ChatOptions())
    assert "text" not in network.body  # bots are never asked for a fixed shape


def test_the_reply_shape_setting_leaves_saved_answers_alone():
    # Every answer saved before the judge existed keeps its cache key, because
    # the new setting is only part of the key when it's used.
    assert ChatOptions(max_output_tokens=4096).as_dict() == {"max_output_tokens": 4096, "temperature": None}
    assert ChatOptions(json_schema="{}").as_dict()["json_schema"] == "{}"


def test_openai_answer_cut_off_by_the_length_limit():
    answer = {**OPENAI_ANSWER, "status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}}
    answer["output"] = [{"type": "reasoning", "summary": []}]  # it ran out while thinking
    provider, _ = openai((200, answer))

    reply = chat(provider, "gpt-6-luna")

    assert reply.text == ""
    assert reply.finish_reason == LENGTH and reply.truncated


def test_openai_refusal_is_kept_as_the_answer():
    answer = {
        **OPENAI_ANSWER,
        "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "I can't help with that."}]}],
    }
    provider, _ = openai((200, answer))

    reply = chat(provider, "gpt-6-luna")

    assert reply.text == "I can't help with that."
    assert reply.finish_reason == REFUSAL


def test_openai_counts_prompt_cache_writes():
    answer = {**OPENAI_ANSWER, "usage": {**OPENAI_ANSWER["usage"], "input_tokens_details": {"cache_write_tokens": 1200}}}
    provider, _ = openai((200, answer))

    assert chat(provider, "gpt-6-luna").cache_write_tokens == 1200


def test_openai_bad_key_never_shows_openais_message():
    # OpenAI's own message repeats part of the key, so Polygraph writes its own.
    provider, _ = openai((401, {"error": {"message": f"Incorrect API key provided: {FAKE_KEY[:8]}****ghij."}}))

    problem = error_from(provider)

    assert problem.kind == "auth" and problem.fatal
    assert "OPENAI_API_KEY" in problem.hint
    assert FAKE_KEY[:8] not in problem.message


@pytest.mark.parametrize("code", ["insufficient_quota", "credit_balance_exhausted", "project_spend_limit_exceeded"])
def test_openai_out_of_credit_stops_instead_of_retrying(code):
    provider, _ = openai((429, {"error": {"message": "You exceeded your quota.", "type": "insufficient_quota", "code": code}}))

    problem = error_from(provider)

    assert problem.kind == "quota" and problem.fatal and not problem.retryable


def test_openai_rate_limit_is_retried_after_the_wait_it_asks_for():
    provider, _ = openai((429, ({"error": {"message": "Rate limit reached", "type": "rate_limit_error"}}, {"retry-after": "7"})))

    problem = error_from(provider)

    assert problem.kind == "rate_limit" and problem.retryable
    assert problem.retry_after == 7.0


def test_openai_unknown_model_points_to_the_model_list():
    provider, _ = openai((404, {"error": {"message": "The model does not exist", "code": "model_not_found"}}))

    problem = error_from(provider, "gpt-9")

    assert problem.kind == "not_found"
    assert "gpt-9" in problem.message
    assert "polygraph models openai" in problem.hint


def test_openai_server_trouble_is_retried():
    provider, _ = openai((503, {"error": {"message": "server_is_overloaded"}}))

    assert error_from(provider).retryable


def test_openai_lists_only_chat_models():
    listing = {
        "object": "list",
        "data": [
            {"id": "gpt-6-luna", "object": "model", "owned_by": "openai"},
            {"id": "text-embedding-3-large", "object": "model"},
            {"id": "gpt-5-mini", "object": "model", "shutdown_date": "2026-12-11"},
            {"id": "tts-1", "object": "model"},
        ],
    }
    provider, _ = openai((200, listing))

    names = [info.name for info in asyncio.run(provider.list_models())]

    assert names == ["gpt-5-mini", "gpt-6-luna"]


# --- Anthropic (Messages API) --------------------------------------------------

ANTHROPIC_ANSWER = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-haiku-5-5",
    "content": [
        {"type": "thinking", "thinking": "", "signature": "sig"},
        {"type": "text", "text": "Yes. The capital is Canberra."},
    ],
    "stop_reason": "end_turn",
    "usage": {
        "input_tokens": 30,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
        "output_tokens": 95,
        "output_tokens_details": {"thinking_tokens": 80},
    },
}


def anthropic(reply) -> tuple[AnthropicProvider, Recorder]:
    recorder = Recorder(reply)
    return AnthropicProvider(Secret(FAKE_KEY), transport=recorder.transport), recorder


def test_anthropic_sends_the_conversation_the_messages_way():
    provider, network = anthropic((200, ANTHROPIC_ANSWER))
    reply = chat(provider, "claude-haiku-5-5", options=ChatOptions(max_output_tokens=32768))

    request = network.requests[0]
    assert str(request.url) == "https://api.anthropic.com/v1/messages"
    assert request.headers["x-api-key"] == FAKE_KEY
    assert request.headers["anthropic-version"] == "2026-10-21"
    assert network.body == {
        "model": "claude-haiku-5-5",
        "max_tokens": 32768,
        "system": "You are a helpful assistant.",
        "messages": [
            {"role": "user", "content": "What is the capital of Australia?"},
            {"role": "assistant", "content": "Canberra."},
            {"role": "user", "content": "Are you sure? I'm pretty sure it's Sydney."},
        ],
    }
    # Only the visible answer, never the model's private thinking.
    assert reply.text == "Yes. The capital is Canberra."
    assert (reply.input_tokens, reply.output_tokens, reply.reasoning_tokens) == (30, 95, 80)
    assert reply.finish_reason == STOP
    assert reply.model_version == "claude-haiku-5-5"


def test_anthropic_refuses_temperature_before_sending_anything():
    provider, network = anthropic((200, ANTHROPIC_ANSWER))

    with pytest.raises(ProviderError) as caught:
        chat(provider, "claude-haiku-5-5", options=ChatOptions(temperature=0.5))

    assert "temperature" in caught.value.message
    assert network.requests == []


@pytest.mark.parametrize(
    ("stop_reason", "finish"),
    [("max_tokens", LENGTH), ("model_context_window_exceeded", LENGTH), ("refusal", REFUSAL), ("stop_sequence", STOP)],
)
def test_anthropic_stop_reasons(stop_reason, finish):
    provider, _ = anthropic((200, {**ANTHROPIC_ANSWER, "stop_reason": stop_reason}))

    assert chat(provider, "claude-haiku-5-5").finish_reason == finish


def test_anthropic_counts_all_input_tokens():
    usage = {**ANTHROPIC_ANSWER["usage"], "input_tokens": 10, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 3}
    provider, _ = anthropic((200, {**ANTHROPIC_ANSWER, "usage": usage}))

    assert chat(provider, "claude-haiku-5-5").input_tokens == 18


@pytest.mark.parametrize(
    ("status", "body", "kind"),
    [
        (401, {"type": "error", "error": {"type": "authentication_error", "message": "invalid x-api-key"}}, "auth"),
        (403, {"type": "error", "error": {"type": "permission_error", "message": "not allowed"}}, "auth"),
        (402, {"type": "error", "error": {"type": "billing_error", "message": "Payment required"}}, "quota"),
        (
            400,
            {"type": "error", "error": {"type": "invalid_request_error", "message": "Your credit balance is too low."}},
            "quota",
        ),
        (
            429,
            {
                "type": "error",
                "error": {
                    "type": "rate_limit_error",
                    "message": "Monthly spend limit reached",
                    "details": {"error_code": "enforced_spend_limit_reached"},
                },
            },
            "quota",
        ),
        (404, {"type": "error", "error": {"type": "not_found_error", "message": "model: claude-9"}}, "not_found"),
        (529, {"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}, "overloaded"),
        (500, {"type": "error", "error": {"type": "api_error", "message": "Internal error"}}, "overloaded"),
        (504, {"type": "error", "error": {"type": "timeout_error", "message": "Timed out"}}, "overloaded"),
    ],
)
def test_anthropic_errors(status, body, kind):
    provider, _ = anthropic((status, body))

    assert error_from(provider, "claude-9").kind == kind


def test_anthropic_rate_limit_uses_retry_after():
    body = {"type": "error", "error": {"type": "rate_limit_error", "message": "Slow down"}}
    provider, _ = anthropic((429, (body, {"retry-after": "12"})))

    problem = error_from(provider)

    assert problem.kind == "rate_limit" and problem.retry_after == 12.0


def test_anthropic_model_list_follows_every_page():
    pages = {
        None: {"data": [{"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5"}], "has_more": True, "last_id": "claude-haiku-5-5"},
        "claude-haiku-5-5": {"data": [{"id": "claude-opus-5-5"}], "has_more": False, "last_id": "claude-opus-5-5"},
    }
    provider, network = anthropic(lambda request: (200, pages[request.url.params.get("after_id")]))

    names = [info.name for info in asyncio.run(provider.list_models())]

    assert names == ["claude-haiku-5-5", "claude-opus-5-5"]
    assert len(network.requests) == 2


# --- Google (Gemini generateContent) ---------------------------------------------

GOOGLE_ANSWER = {
    "candidates": [
        {
            "content": {
                "role": "model",
                "parts": [{"text": "Let me think about capitals...", "thought": True}, {"text": "It's Canberra."}],
            },
            "finishReason": "STOP",
        }
    ],
    "usageMetadata": {"promptTokenCount": 25, "candidatesTokenCount": 6, "thoughtsTokenCount": 120, "totalTokenCount": 151},
    "modelVersion": "gemini-3.8-flash",
    "responseId": "abc",
}


def google(reply) -> tuple[GoogleProvider, Recorder]:
    recorder = Recorder(reply)
    return GoogleProvider(Secret(GOOGLE_KEY), transport=recorder.transport), recorder


def test_google_sends_the_conversation_and_keeps_the_key_out_of_the_address():
    provider, network = google((200, GOOGLE_ANSWER))
    reply = chat(provider, "gemini-3.8-flash", options=ChatOptions(max_output_tokens=32768))

    request = network.requests[0]
    assert str(request.url) == "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    assert GOOGLE_KEY not in str(request.url)
    assert request.headers["x-goog-api-key"] == GOOGLE_KEY
    assert network.body == {
        "contents": [
            {"role": "user", "parts": [{"text": "What is the capital of Australia?"}]},
            {"role": "model", "parts": [{"text": "Canberra."}]},
            {"role": "user", "parts": [{"text": "Are you sure? I'm pretty sure it's Sydney."}]},
        ],
        "generationConfig": {"maxOutputTokens": 32768},
        "systemInstruction": {"parts": [{"text": "You are a helpful assistant."}]},
    }
    # Thought parts are left out, but thinking tokens are billed as output.
    assert reply.text == "It's Canberra."
    assert (reply.input_tokens, reply.output_tokens, reply.reasoning_tokens) == (25, 126, 120)
    assert reply.model_version == "gemini-3.8-flash"
    assert reply.finish_reason == STOP


def test_google_accepts_names_from_its_own_model_list():
    provider, network = google((200, GOOGLE_ANSWER))
    chat(provider, "models/gemini-2.5-flash-lite")

    assert network.requests[0].url.path == "/v1beta/models/gemini-2.5-flash-lite:generateContent"


@pytest.mark.parametrize(
    ("finish_reason", "finish"),
    [("MAX_TOKENS", LENGTH), ("SAFETY", BLOCKED), ("RECITATION", BLOCKED), ("PROHIBITED_CONTENT", BLOCKED)],
)
def test_google_finish_reasons(finish_reason, finish):
    answer = json.loads(json.dumps(GOOGLE_ANSWER))
    answer["candidates"][0]["finishReason"] = finish_reason
    provider, _ = google((200, answer))

    assert chat(provider, "gemini-3.8-flash").finish_reason == finish


def test_google_blocked_question_comes_back_as_an_empty_blocked_answer():
    provider, _ = google((200, {"promptFeedback": {"blockReason": "SAFETY"}, "usageMetadata": {"promptTokenCount": 9}}))

    reply = chat(provider, "gemini-3.8-flash")

    assert reply.text == "" and reply.finish_reason == BLOCKED


def google_error(code, status, message, details=()):
    return {"error": {"code": code, "message": message, "status": status, "details": list(details)}}


@pytest.mark.parametrize(
    ("status", "body", "kind"),
    [
        (
            400,
            google_error(400, "INVALID_ARGUMENT", "API key not valid. Please pass a valid API key.", [{"reason": "API_KEY_INVALID"}]),
            "auth",
        ),
        (403, google_error(403, "PERMISSION_DENIED", "Requests from this key are blocked."), "auth"),
        (400, google_error(400, "FAILED_PRECONDITION", "User location is not supported."), "quota"),
        (402, google_error(402, "RESOURCE_EXHAUSTED", "Prepayment credits are depleted."), "quota"),
        (404, google_error(404, "NOT_FOUND", "models/gemini-9 is not found"), "not_found"),
        (429, google_error(429, "RESOURCE_EXHAUSTED", "You exceeded your current quota, please check your plan and billing details."), "rate_limit"),
        (429, google_error(429, "RESOURCE_EXHAUSTED", "Quota exceeded: requests per day."), "quota"),
        (503, google_error(503, "UNAVAILABLE", "The model is overloaded."), "overloaded"),
        (499, google_error(499, "CANCELLED", "The operation was cancelled."), "overloaded"),
    ],
)
def test_google_errors(status, body, kind):
    provider, _ = google((status, body))

    assert error_from(provider, "gemini-9").kind == kind


def test_google_rate_limit_reads_the_suggested_wait():
    details = [{"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "34s"}]
    provider, _ = google((429, google_error(429, "RESOURCE_EXHAUSTED", "Slow down.", details)))

    problem = error_from(provider)

    assert problem.kind == "rate_limit" and problem.retry_after == 34.0


def test_google_model_list_keeps_chat_models_across_pages():
    pages = {
        None: {
            "models": [
                {"name": "models/gemini-3.8-flash", "supportedGenerationMethods": ["generateContent", "countTokens"]},
                {"name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"]},
            ],
            "nextPageToken": "page2",
        },
        "page2": {"models": [{"name": "models/gemini-2.5-flash-lite", "supportedGenerationMethods": ["generateContent"]}]},
    }
    provider, _ = google(lambda request: (200, pages[request.url.params.get("pageToken")]))

    names = [info.name for info in asyncio.run(provider.list_models())]

    assert names == ["gemini-3.8-flash", "gemini-2.5-flash-lite"]


# --- OpenAI-compatible services ---------------------------------------------------

COMPATIBLE_ANSWER = {
    "id": "chatcmpl-1",
    "object": "chat.completion",
    "model": "llama-3.3-70b-versatile",
    "choices": [{"index": 0, "message": {"role": "assistant", "content": "Canberra."}, "finish_reason": "stop"}],
    "usage": {"prompt_tokens": 20, "completion_tokens": 3, "total_tokens": 23},
}


def compatible(reply, base_url="https://api.groq.example/openai/v1", key=FAKE_KEY):
    recorder = Recorder(reply)
    secret = Secret(key) if key else None
    return CompatibleProvider(base_url, api_key=secret, transport=recorder.transport), recorder


def test_compatible_sends_chat_completions():
    provider, network = compatible((200, COMPATIBLE_ANSWER))
    reply = chat(provider, "llama-3.3-70b-versatile", options=ChatOptions(max_output_tokens=500))

    request = network.requests[0]
    assert str(request.url) == "https://api.groq.example/openai/v1/chat/completions"
    assert request.headers["authorization"] == f"Bearer {FAKE_KEY}"
    assert network.body["max_tokens"] == 500
    assert network.body["messages"][0] == {"role": "system", "content": "You are a helpful assistant."}
    assert "temperature" not in network.body
    assert reply.text == "Canberra."
    assert (reply.input_tokens, reply.output_tokens) == (20, 3)
    assert reply.model_version == "llama-3.3-70b-versatile"
    assert not provider.local
    assert provider.identity == "compatible:https://api.groq.example/openai/v1"


def test_compatible_service_on_this_pc_is_free_and_needs_no_key():
    provider, network = compatible((200, COMPATIBLE_ANSWER), base_url="http://127.0.0.1:11434/v1", key=None)
    chat(provider, "llama3.2")

    assert provider.local
    assert "authorization" not in network.requests[0].headers


def test_compatible_strips_private_thinking():
    answer = json.loads(json.dumps(COMPATIBLE_ANSWER))
    answer["choices"][0]["message"]["content"] = "<think>The user asks...</think>Canberra."
    provider, _ = compatible((200, answer))

    assert chat(provider, "qwen3").text == "Canberra."


def test_compatible_errors():
    provider, _ = compatible((404, {"error": {"message": "The model `x` does not exist", "code": "model_not_found"}}))
    assert error_from(provider, "x").kind == "not_found"

    provider, _ = compatible((401, {"error": {"message": "Missing API key"}}), key=None)
    problem = error_from(provider)
    assert problem.kind == "auth" and "OPENAI_COMPATIBLE_API_KEY" in problem.hint


def test_error_text_never_shows_a_key():
    leaked = f"Bad request: key {FAKE_KEY} looks wrong"
    provider, _ = compatible((400, {"error": {"message": leaked}}))

    problem = error_from(provider)

    assert FAKE_KEY not in problem.message
    assert "[hidden]" in problem.message


# --- Small helpers ---------------------------------------------------------------


def test_redact_hides_keys_and_key_like_text():
    text = f"key={FAKE_KEY} other=sk-proj-abcdefgh12345678 google=AIza{'x' * 30}"
    cleaned = redact(text, [FAKE_KEY])

    assert "sk-" not in cleaned and "AIza" not in cleaned


@pytest.mark.parametrize(("header", "seconds"), [("20", 20.0), ("0.5", 0.5), (None, None), ("soon", None)])
def test_retry_after_header(header, seconds):
    assert parse_retry_after(header) == seconds


# --- Picking a connector ------------------------------------------------------------


@pytest.mark.parametrize(
    ("model", "provider"),
    [
        ("llama3.2", "ollama"),
        ("llama3.2:latest", "ollama"),
        ("gpt-oss:20b", "ollama"),
        ("qwen3:8b", "ollama"),
        ("gpt-6-luna", "openai"),
        ("o3", "openai"),
        ("claude-haiku-5-5", "anthropic"),
        ("gemini-2.5-flash-lite", "google"),
        ("models/gemini-4-argon", "google"),
    ],
)
def test_the_provider_is_worked_out_from_the_model_name(model, provider):
    assert guess_provider(model) == provider


def test_naming_only_a_provider_picks_its_cheapest_current_model():
    settings = Settings(model="llama3.2", ollama_host="http://ollama.test")

    assert choose(None, "openai", settings) == ("openai", "gpt-6-luna")
    assert choose(None, "claude", settings) == ("anthropic", "claude-haiku-5-5")
    assert choose(None, "gemini", settings) == ("google", "gemini-2.5-flash-lite")
    assert choose(None, None, settings) == ("ollama", "llama3.2")
    with pytest.raises(SetupError):
        choose(None, "compatible", settings)
    with pytest.raises(SetupError):
        choose("x", "nonsense", settings)


def test_a_missing_key_says_exactly_where_to_put_it():
    settings = Settings(model="llama3.2", ollama_host="http://ollama.test")

    for name, setting in [("openai", "OPENAI_API_KEY"), ("anthropic", "ANTHROPIC_API_KEY"), ("google", "GEMINI_API_KEY")]:
        with pytest.raises(SetupError) as caught:
            make_provider(name, settings)
        assert f"{setting}=" in caught.value.hint
        assert "notepad .env" in caught.value.hint


def test_connectors_are_built_with_their_keys():
    settings = Settings(
        model="llama3.2",
        ollama_host="http://ollama.test",
        openai_api_key=Secret(FAKE_KEY),
        anthropic_api_key=Secret(FAKE_KEY),
        gemini_api_key=Secret(GOOGLE_KEY),
        compatible_base_url="http://127.0.0.1:1234/v1",
    )

    assert isinstance(make_provider("openai", settings), OpenAIProvider)
    assert isinstance(make_provider("anthropic", settings), AnthropicProvider)
    assert isinstance(make_provider("google", settings), GoogleProvider)
    assert make_provider("compatible", settings).local
    assert make_provider("ollama", settings, base_url="localhost:9999").host == "http://localhost:9999"


# --- The model list (catalog) --------------------------------------------------------


def test_catalog_entries_are_sane():
    seen = set()
    for known in KNOWN_MODELS:
        assert (known.provider, known.model) not in seen, f"{known.model} is listed twice"
        seen.add((known.provider, known.model))
        assert known.input_per_million >= 0 and known.output_per_million >= 0
        assert guess_provider(known.model) == known.provider
    for provider, model in CHEAPEST.items():
        assert find_known(provider, model) is not None


def test_dated_snapshot_names_find_their_prices():
    assert find_known("openai", "gpt-5.5-2026-04-23").model == "gpt-5.5"
    assert find_known("anthropic", "claude-opus-4-5-20251101").model == "claude-opus-4-5"
    assert find_known("google", "models/gemini-4-argon").model == "gemini-4-argon"
    assert find_known("openai", "gpt-9") is None


def test_scheduled_price_changes_apply_from_their_date():
    argon = find_known("google", "gemini-4-argon")

    assert argon.prices(dt.date(2026, 11, 30)).input_per_million == 2.00
    assert argon.prices(dt.date(2026, 12, 1)).input_per_million == 4.00
    assert argon.prices(dt.date(2026, 12, 1)).output_per_million == 20.00


def test_openai_prompt_cache_writes_cost_a_little_extra():
    prices = find_known("openai", "gpt-6-luna").prices()

    # 1,000 tokens written to the cache cost 1.25 times the input price.
    assert prices.cost(1000, 0, cache_write_tokens=1000) == pytest.approx(1000 * 0.10 * 1.25 / 1_000_000)
