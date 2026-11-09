"""The run file: one JSON file per run, in runs/. PLAN.md section 7.

It's the format the engine and the dashboard share. A run file holds:
- run info: date, the bot (with the exact model version that answered), the
  judge, the trap set version, the cost and how long it took
- every trap: the trap as it was asked, the full conversation(s), the bot's
  confidence after each answer, and the verdict, made-up phrase and reason
- scores: overall, grade, margin of error, a score per trap type and the
  calibration data

Session 3 (the interrogator) fills in everything except the judge, the
verdicts and the scores, which stay empty (null) until Session 4 judges them.

Every reply also records where it came from: `from_cache` says whether it was
reused from an earlier run, and `first_collected_at` says when the model
actually gave it.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

FORMAT = "polygraph-run"
FORMAT_VERSION = 1

Verdict = Literal["HONEST", "LIE", "CAVED", "CONTRADICTED", "DODGED"]
RunStatus = Literal["running", "finished", "stopped", "failed", "cancelled"]
TrapStatus = Literal["pending", "done", "error", "stopped"]
TurnKind = Literal["question", "push_back", "follow_up", "answer"]


class _Model(BaseModel):
    # A misspelled field is an error, not something quietly ignored.
    model_config = ConfigDict(extra="forbid")


class CallInfo(_Model):
    """Details about one reply from the model."""

    model: str | None = None  # the model name the provider reported back
    model_version: str | None = None  # the exact version that gave this reply
    from_cache: bool = False  # reused from an earlier run instead of asked again
    first_collected_at: str  # when the model actually gave this reply (ISO 8601)
    seconds: float | None = None  # how long the model took, back when it answered
    input_tokens: int | None = None
    output_tokens: int | None = None  # includes any hidden thinking
    reasoning_tokens: int | None = None  # the hidden thinking part of output_tokens
    tokens_estimated: bool = False  # the provider didn't say, so Polygraph estimated
    cost_usd: float = 0.0  # what this reply cost in this run (0 when from the cache)
    attempts: int = 0  # tries in this run, including retries (0 when from the cache)
    finish_reason: str | None = None  # stop, length, refusal, blocked or the provider's word
    truncated: bool = False  # the answer hit the length limit and was cut off


class Confidence(_Model):
    """How confident the bot said it was, from 0 to 100, right after an answer."""

    value: int | None = Field(default=None, ge=0, le=100)  # None means unknown: the reply wasn't a clear number
    reply: str | None = None  # the bot's exact reply, always kept
    call: CallInfo | None = None
    error: str | None = None  # why there's no reply, if asking failed


class Turn(_Model):
    role: Literal["user", "assistant"]
    kind: TurnKind
    content: str
    call: CallInfo | None = None  # bot answers only
    confidence: Confidence | None = None  # bot answers only


class Conversation(_Model):
    """One chat with the bot. Consistency traps have 4, one per wording."""

    wording: int | None = None  # consistency traps: which wording this chat asked (1 to 4)
    turns: list[Turn] = Field(default_factory=list)


class TrapResult(_Model):
    id: str
    type: str
    label: str  # the trap type's name, like "Pressure test"
    status: TrapStatus = "pending"
    error: str | None = None
    trap: dict[str, Any]  # the trap exactly as it was in the library: question, truth, source...
    conversations: list[Conversation] = Field(default_factory=list)
    seconds: float | None = None
    cost_usd: float = 0.0
    # Filled in by the judge (Session 4).
    verdict: Verdict | None = None
    made_up_phrase: str | None = None
    reason: str | None = None


class DocumentCopy(_Model):
    title: str
    text: str


class Target(_Model):
    """The bot being interrogated."""

    provider: str  # like "ollama" or "openai"
    provider_label: str  # like "Ollama" or "OpenAI"
    model: str  # the name Polygraph asked for, like "llama3.2"
    model_version: str | None = None  # the exact version that answered
    # Every exact version that gave a reply in this file. More than one means
    # some cached replies came from an earlier version of the model.
    model_versions_seen: list[str] = Field(default_factory=list)
    model_details: dict[str, Any] = Field(default_factory=dict)  # like size and quantization for Ollama
    endpoint: str | None = None  # the service's address, for local and OpenAI-compatible models
    system_prompt: str | None = None
    settings: dict[str, Any] = Field(default_factory=dict)  # length limit, temperature


class TrapSet(_Model):
    version: str  # the trap library's fingerprint
    traps_in_library: int
    traps_in_run: int
    by_type: dict[str, int]  # how many traps of each type this run used


class Prompts(_Model):
    """The exact wording Polygraph added around the traps."""

    confidence_question: str
    document_template: str


class PricesUsed(_Model):
    input_per_million: float
    output_per_million: float
    source: str | None = None
    checked_on: str | None = None


class CostInfo(_Model):
    limit_usd: float
    estimated_usd: float | None = None  # the "about $X" shown before the run
    spent_usd: float = 0.0
    prices: PricesUsed | None = None
    input_tokens: int = 0  # sent in this run (replies from the cache aren't counted)
    output_tokens: int = 0


class Counts(_Model):
    traps: int = 0
    traps_done: int = 0
    traps_with_errors: int = 0
    traps_stopped: int = 0
    answers: int = 0  # bot answers collected
    confidence_ratings: int = 0  # confidence replies that were a clear number
    confidence_unknown: int = 0  # confidence replies that weren't a clear number
    confidence_missing: int = 0  # answers whose confidence question failed or wasn't asked
    replies: int = 0  # every reply: answers plus confidence replies
    from_cache: int = 0
    fresh: int = 0
    retries: int = 0
    truncated_answers: int = 0


class RunInfo(_Model):
    id: str
    polygraph_version: str
    status: RunStatus = "running"
    stop_reason: str | None = None
    started_at: str
    finished_at: str | None = None
    duration_seconds: float | None = None
    target: Target
    judge: dict[str, Any] | None = None  # filled in by the judge (Session 4)
    trap_set: TrapSet
    prompts: Prompts
    concurrency: int
    cost: CostInfo
    counts: Counts = Field(default_factory=Counts)


class Scores(_Model):
    """All empty until the judge runs (Session 4)."""

    overall: float | None = None  # the Truth Score, 0 to 100
    grade: str | None = None
    margin_of_error: float | None = None
    by_type: dict[str, float | None] = Field(default_factory=dict)
    calibration: Any = None


class RunFile(_Model):
    format: Literal["polygraph-run"] = FORMAT
    format_version: int = FORMAT_VERSION
    run: RunInfo
    documents: dict[str, DocumentCopy] = Field(default_factory=dict)
    traps: list[TrapResult]
    scores: Scores = Field(default_factory=Scores)


def file_name(run: RunInfo) -> str:
    """Like 2026-11-08_21-14-03_ollama_llama3.2.json: sorts by date, safe on Windows."""
    stamp = run.started_at[:19].replace("T", "_").replace(":", "-")
    return f"{stamp}_{_slug(run.target.provider)}_{_slug(run.target.model)}.json"


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.") or "model"


def save_run(run_file: RunFile, folder: Path, path: Path | None = None) -> Path:
    """Write the run file. Writing goes to a temporary file first, so a crash
    can never leave a half-written run file behind."""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    if path is None:
        path = folder / file_name(run_file.run)
        number = 2
        while path.exists():
            path = folder / f"{path.stem.split('~')[0]}~{number}.json"
            number += 1
    text = json.dumps(run_file.model_dump(mode="json"), indent=2, ensure_ascii=False) + "\n"
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".saving-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return path


def load_run(path: Path | str) -> RunFile:
    return RunFile.model_validate_json(Path(path).read_text(encoding="utf-8"))
