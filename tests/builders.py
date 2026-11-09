"""Builders for the judging and scoring tests: small fake run files with
exactly the traps, answers, confidence numbers and verdicts a test needs.
Nothing here touches the internet or a real model."""

from __future__ import annotations

from typing import Any

from polygraph.runfile import (
    CallInfo,
    Confidence,
    Conversation,
    CostInfo,
    DocumentCopy,
    Judgement,
    Prompts,
    RunFile,
    RunInfo,
    Target,
    TrapResult,
    TrapSet,
    Turn,
)
from polygraph.traps.schema import TYPE_INFO

LABELS = {kind.value: info.label for kind, info in TYPE_INFO.items()}
STAMP = "2026-11-08T21:00:00-06:00"


def call(model: str = "bot-v1", cached: bool = False, cost: float = 0.0, **extra: Any) -> CallInfo:
    return CallInfo(model=model, model_version=model, from_cache=cached, first_collected_at=STAMP, cost_usd=cost, **extra)


def answer(text: str, confidence: int | None = None, reply: str | None = None, **call_extra: Any) -> Turn:
    """A bot answer, with the confidence it gave right after (None: unknown)."""
    if reply is None:
        reply = str(confidence) if confidence is not None else "I'm not sure how to rate that."
    return Turn(
        role="assistant",
        kind="answer",
        content=text,
        call=call(**call_extra),
        confidence=Confidence(value=confidence, reply=reply, call=call()),
    )


def asked(text: str, kind: str = "question") -> Turn:
    return Turn(role="user", kind=kind, content=text)


def trap(
    trap_id: str,
    kind: str,
    answers: list[Turn],
    *,
    question: str = "A question?",
    verdict: str | None = None,
    phrase: str | None = None,
    reason: str | None = None,
    phrase_answer: int | None = None,
    status: str = "done",
    push_back: str = "Are you sure? I think you're wrong.",
    wordings: list[str] | None = None,
    **fields: Any,
) -> TrapResult:
    """One trap result. Pressure tests take 2 answers, consistency traps 4."""
    data: dict[str, Any] = {
        "id": trap_id,
        "type": kind,
        "question": question,
        "follow_ups": [push_back] if kind == "pressure_test" else [],
        "truth": "The truth, checked by hand.",
        "honest_looks_like": "Tells the truth.",
        "caught_if": "Makes something up.",
        "source": {"title": "A source", "url": "https://example.org/source", "note": None},
        "verified_on": "2026-11-08",
        **fields,
    }
    if kind == "consistency":
        words = wordings or [f"{question} (wording {n})" for n in range(1, len(answers) + 1)]
        data["rewordings"] = words[1:]
        chats = [Conversation(wording=n, turns=[asked(w), a]) for n, (w, a) in enumerate(zip(words, answers), start=1)]
    elif kind == "pressure_test":
        turns = [asked(question), answers[0]]
        if len(answers) > 1:
            turns += [asked(push_back, "push_back"), answers[1]]
        chats = [Conversation(turns=turns)]
    else:
        chats = [Conversation(turns=[asked(question), answers[0]])] if answers else []
    result = TrapResult(
        id=trap_id,
        type=kind,
        label=LABELS.get(kind, kind),
        status=status,  # type: ignore[arg-type]
        trap=data,
        conversations=chats,
        verdict=verdict,  # type: ignore[arg-type]
        made_up_phrase=phrase,
        reason=reason,
    )
    if verdict is not None:
        result.judgement = Judgement(decided_by="ai_judge", phrase_answer=phrase_answer)
    return result


def judged(trap_id: str, kind: str, verdict: str, confidence: int | None = 90, **extra: Any) -> TrapResult:
    """A trap that already has a verdict, with one answer (two for a pressure
    test, four for consistency), each followed by `confidence`."""
    count = {"pressure_test": 2, "consistency": 4}.get(kind, 1)
    answers = [answer(f"Answer {n} to {trap_id}.", confidence) for n in range(1, count + 1)]
    return trap(trap_id, kind, answers, verdict=verdict, **extra)


def run_file(
    traps: list[TrapResult],
    *,
    provider: str = "ollama",
    provider_label: str = "Ollama",
    model: str = "llama3.2",
    details: dict[str, Any] | None = None,
    documents: dict[str, DocumentCopy] | None = None,
) -> RunFile:
    kinds: dict[str, int] = {}
    for result in traps:
        kinds[result.type] = kinds.get(result.type, 0) + 1
    run = RunInfo(
        id="2026-11-08_21-00-00_ollama_llama3.2",
        polygraph_version="test",
        status="finished",
        started_at=STAMP,
        finished_at="2026-11-08T21:02:00-06:00",
        duration_seconds=120.0,
        target=Target(
            provider=provider,
            provider_label=provider_label,
            model=model,
            model_details={"family": "llama", "parameter_size": "3.2B"} if details is None else details,
        ),
        trap_set=TrapSet(version="abc123def456", traps_in_library=80, traps_in_run=len(traps), by_type=kinds),
        prompts=Prompts(confidence_question="How sure are you?", document_template="{document}\n{question}"),
        concurrency=2,
        cost=CostInfo(limit_usd=2.0),
    )
    return RunFile(run=run, traps=traps, documents=documents or {})
