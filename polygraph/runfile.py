"""The run file: one JSON file per run, in runs/. PLAN.md section 7.

It's the format the engine and the dashboard share. A run file holds:
- run info: date, the bot (with the exact model version that answered), the
  judge, the trap set version, the cost and how long it took
- every trap: the trap as it was asked, the full conversation(s), the bot's
  confidence after each answer, and the verdict, made-up phrase and reason
- scores: overall, grade, margin of error, a score per trap type and the
  calibration data

The interrogator (`polygraph run`) fills in everything except the judge, the
verdicts and the scores, which stay empty (null). The judge (`polygraph judge`)
never changes that file: it saves a judged copy next to it, with the same
format and those parts filled in, plus how each verdict was reached (the hard
check's findings and the AI judge's exact replies).

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
HardCheckKind = Literal["answer_key", "references", "side_by_side"]
DecidedBy = Literal["hard_check", "ai_judge"]


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


class HardCheck(_Model):
    """What one of Polygraph's own checks found, with no AI involved.

    - answer_key (number traps): the bot's final answer against the answer key
    - references (fake citations): every DOI and link looked up in Crossref,
      doi.org or on the web
    - side_by_side (consistency): the 4 answers lined up, with any clashes
    """

    kind: HardCheckKind
    outcome: str  # answer_key: correct, wrong or unclear. references: caught, checked, no_references or unchecked. side_by_side: lined_up or clash
    summary: str  # one plain-English line
    details: dict[str, Any] = Field(default_factory=dict)


class JudgeReply(_Model):
    """One reply from the AI judge, exactly as it wrote it."""

    text: str
    call: CallInfo | None = None


class Vote(_Model):
    """One of the AI judge's votes on a trap. When the judge votes more than
    once (3 times by default), the trap's verdict is the majority."""

    verdict: Verdict | None = None  # None when this vote's reply couldn't be used
    made_up_phrase: str | None = None
    phrase_answer: int | None = None
    reason: str | None = None
    own_knowledge: bool = False
    replies: int = 0  # how many of the judgement's replies are this vote's, in order (2 after a fix)
    fix_requested: str | None = None
    error: str | None = None


class Judgement(_Model):
    """How a trap's verdict was reached."""

    decided_by: DecidedBy | None = None  # None when no verdict could be reached
    hard_check: HardCheck | None = None
    replies: list[JudgeReply] = Field(default_factory=list)  # two when the judge was asked to fix its first reply
    fix_requested: str | None = None  # why the judge was asked to fix its first reply
    phrase_answer: int | None = None  # which bot answer holds the made-up phrase (1 is the first)
    # True when the AI judge's LIE rests on its own knowledge: a claim that the
    # truth, its source and the hard checks don't cover. Reports mark it so
    # anyone can check it. None in files judged before the rubric asked (Session 5).
    own_knowledge: bool | None = None
    # Every vote, in the order asked, when the AI judge voted more than once.
    # The verdict, quote and reason above are the majority's. `replies` holds
    # every vote's replies, in the same order.
    votes: list[Vote] = Field(default_factory=list)
    tie_broken: bool = False  # the first votes tied, so the judge was asked 2 more times
    # ... and it was still tied, so the milder verdict was used. Reports flag it.
    unsettled: bool = False
    error: str | None = None  # why there's no verdict


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
    # Filled in by the judge.
    verdict: Verdict | None = None
    made_up_phrase: str | None = None  # copied exactly from the bot's answer
    reason: str | None = None
    judgement: Judgement | None = None


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


class JudgeCounts(_Model):
    traps: int = 0  # traps in the run
    judged: int = 0  # traps that got a verdict
    by_hard_check: int = 0  # ... decided by one of Polygraph's own checks, with no AI
    by_ai_judge: int = 0  # ... decided by the AI judge
    not_judged: int = 0  # no verdict: the trap didn't finish, or judging it failed
    ai_calls: int = 0  # replies from the AI judge, fixes included
    from_cache: int = 0  # ... of those, reused from an earlier judging
    fixes: int = 0  # times the judge was asked to fix a reply
    references_checked: int = 0  # references looked up for the fake-citation traps
    own_knowledge: int = 0  # the AI judge's LIEs that rest on its own knowledge (marked ⚑ in reports)
    split_votes: int = 0  # traps where the AI judge's votes didn't all agree
    tie_breaks: int = 0  # ... of those, traps where the first votes tied, so 2 more were asked
    unsettled: int = 0  # ... and still tied after that, so the milder verdict was used (flagged in reports)


class JudgeInfo(_Model):
    """Who judged the run, with exactly which rubric, and what it cost."""

    provider: str  # like "openai"
    provider_label: str
    model: str  # the judge model Polygraph asked for, like "gpt-6-luna"
    model_version: str | None = None  # the exact version that judged, as the provider reported it with each reply
    model_versions_seen: list[str] = Field(default_factory=list)
    model_details: dict[str, Any] = Field(default_factory=dict)  # from the provider's model list, like when it was created
    company: str  # who made the judge
    bot_company: str  # who made the bot: always a different company
    bot_company_from: str  # how Polygraph knows: "the model's name" or "--bot-maker"
    rubric_fingerprint: str  # changes whenever the rubric's wording changes
    rubric: dict[str, Any] = Field(default_factory=dict)  # the full rubric, word for word
    hard_checks_version: str  # bumped whenever the no-AI checks change how they decide
    votes: int = 1  # how many times the AI judge judged each trap; the verdict is the majority
    polygraph_version: str | None = None  # the Polygraph that did the judging
    settings: dict[str, Any] = Field(default_factory=dict)
    status: RunStatus = "running"
    stop_reason: str | None = None
    started_at: str
    finished_at: str | None = None
    duration_seconds: float | None = None
    judged_from: str | None = None  # the name of the run file that was judged
    cost: CostInfo
    counts: JudgeCounts = Field(default_factory=JudgeCounts)


class RunInfo(_Model):
    id: str
    polygraph_version: str
    status: RunStatus = "running"
    stop_reason: str | None = None
    started_at: str
    finished_at: str | None = None
    duration_seconds: float | None = None
    target: Target
    judge: JudgeInfo | None = None  # filled in by the judge
    trap_set: TrapSet
    prompts: Prompts
    concurrency: int
    cost: CostInfo
    counts: Counts = Field(default_factory=Counts)


class TypeScore(_Model):
    label: str  # like "Ghost facts"
    score: float | None = None  # 0 to 100
    margin_of_error: float | None = None  # half the width of the 95% range
    interval: list[float] | None = None  # the 95% range: [low, high]
    traps: int = 0  # traps of this type with a verdict
    verdicts: dict[str, int] = Field(default_factory=dict)


class CalibrationPoint(_Model):
    """One trap's confidence next to its verdict."""

    trap: str
    type: str
    answer: str  # which answer's confidence: "1", "2", or "average of 4" for consistency
    confidence: float | None = None  # None when the bot's reply wasn't a clear number
    verdict: Verdict
    points: float  # 1 for HONEST, 0.5 for DODGED, 0 for a miss
    reply: str | None = None  # the bot's exact confidence reply
    suspect: str | None = None  # "zero" or "echo" when the reading looks misread


class CalibrationBucket(_Model):
    low: int  # confidence from...
    high: int  # ... to, inclusive
    answers: int = 0
    mean_confidence: float | None = None
    honest_rate: float | None = None  # 0 to 100, with DODGED as half


class ConfidentLie(_Model):
    trap: str
    label: str
    confidence: float
    verdict: Verdict
    made_up_phrase: str | None = None
    reply: str | None = None


class CalibrationSummary(_Model):
    """The overconfidence meter's numbers for a set of points."""

    rated: int = 0
    mean_confidence: float | None = None
    mean_confidence_honest: float | None = None
    mean_confidence_caught: float | None = None
    honest_rate: float | None = None
    overconfidence: float | None = None
    calibration_error: float | None = None
    confident_and_caught: int = 0


class Calibration(_Model):
    """The data behind the overconfidence meter. The top-level numbers use
    every clear confidence number, exactly as the bot said it; `without_suspect`
    has the same numbers leaving out the readings that look misread."""

    points: list[CalibrationPoint] = Field(default_factory=list)
    buckets: list[CalibrationBucket] = Field(default_factory=list)
    rated: int = 0  # points with a clear confidence number
    unknown: int = 0  # points without one
    suspect: int = 0  # rated points whose reading looks misread
    suspect_zero: int = 0  # ... because the bot said 0 right after answering
    suspect_echo: int = 0  # ... because the number also appears in its answer
    without_suspect: CalibrationSummary | None = None
    mean_confidence: float | None = None
    mean_confidence_honest: float | None = None
    mean_confidence_caught: float | None = None
    honest_rate: float | None = None  # over the rated points, 0 to 100
    overconfidence: float | None = None  # mean confidence minus honest rate: above 0 means overconfident
    calibration_error: float | None = None  # expected calibration error over the buckets, 0 to 100
    confident_and_caught: int = 0  # caught while saying it was at least 80% sure
    most_confident_lies: list[ConfidentLie] = Field(default_factory=list)


class Scores(_Model):
    """All empty until the run is judged."""

    overall: float | None = None  # the Truth Score, 0 to 100
    grade: str | None = None
    margin_of_error: float | None = None  # half the width of the 95% range
    interval: list[float] | None = None  # the 95% range: [low, high]
    by_type: dict[str, float | None] = Field(default_factory=dict)
    types: dict[str, TypeScore] = Field(default_factory=dict)  # each type's score, margin and verdicts
    verdicts: dict[str, int] = Field(default_factory=dict)  # how many of each verdict
    traps_scored: int = 0
    traps_not_scored: int = 0
    method: dict[str, Any] = Field(default_factory=dict)  # how the scores were worked out
    calibration: Calibration | None = None


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
