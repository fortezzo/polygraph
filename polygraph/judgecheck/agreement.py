"""How often Polygraph's verdicts agree with the hand labels.

Polygraph's verdict is what the whole judging gives: the hard checks plus the
AI judge, exactly as in the judged copy of each run.

- Percent agreement: how often the two match.
- Cohen's kappa: agreement after taking out the agreement you'd expect by luck
  alone, given how often each side uses each verdict. 1 is perfect, 0 is no
  better than luck.
- 95% ranges from a bootstrap: the answers are drawn again at random, with
  repeats, 10,000 times (seed 2026), and the middle 95% is kept.
- A grid of the labeler's verdicts against Polygraph's, and every disagreement.

Tuning only ever looks at the tuning half (`polygraph agreement`), and each new
combination of rubric, judged copies and labels is logged in rounds.json. The
test half is measured once, after the rubric is final (`polygraph agreement
--final`), into final.json.
"""

from __future__ import annotations

import collections
import datetime as dt
import json
import random
import subprocess
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from polygraph import __version__
from polygraph.config import PROJECT_ROOT
from polygraph.interrogator.calls import now_iso
from polygraph.judgecheck.files import resolve, shown, write_json
from polygraph.judgecheck.labels import Label, LabelStore, half_fingerprints
from polygraph.judgecheck.sample import TEST, TUNING, Sample, SampleItem, run_files
from polygraph.judges.pipeline import HARD_CHECKS_VERSION, judged_copies
from polygraph.judges.rubric import fingerprint as rubric_fingerprint
from polygraph.runfile import RunFile, load_run
from polygraph.scoring import POINTS, percentile
from polygraph.traps.schema import TYPE_INFO, TrapType

VERDICTS = ("HONEST", "LIE", "CAVED", "CONTRADICTED", "DODGED")
NOT_JUDGED = "NOT_JUDGED"
ROUNDS_FILE = "rounds.json"
FINAL_FILE = "final.json"
RESAMPLES = 10_000
SEED = 2026
LEVEL = 0.95

# Landis and Koch (1977), the usual words for kappa values.
KAPPA_WORDS = ((0.81, "almost perfect"), (0.61, "substantial"), (0.41, "moderate"), (0.21, "fair"), (0.0, "slight"))


class AgreementError(Exception):
    """A problem with comparing, in plain English."""


# --- The math ----------------------------------------------------------------------------


def cohen_kappa(pairs: Sequence[tuple[str, str]]) -> float | None:
    """Cohen's kappa for (labeler, Polygraph) pairs. None when it can't be
    worked out: no pairs, or both sides gave every answer the same verdict."""
    n = len(pairs)
    if n == 0:
        return None
    observed = sum(a == b for a, b in pairs) / n
    first = collections.Counter(a for a, _ in pairs)
    second = collections.Counter(b for _, b in pairs)
    expected = sum(first[k] * second[k] for k in first) / (n * n)
    if expected >= 1.0:
        return None
    return (observed - expected) / (1.0 - expected)


def kappa_words(kappa: float | None) -> str:
    if kappa is None:
        return "can't be worked out"
    if kappa < 0:
        return "worse than luck"
    for cutoff, words in KAPPA_WORDS:
        if kappa >= cutoff:
            return words
    return "slight"


def _middle(values: list[float]) -> tuple[float, float] | None:
    if not values:
        return None
    ordered = sorted(values)
    tail = (1 - LEVEL) / 2
    return percentile(ordered, tail), percentile(ordered, 1 - tail)


def bootstrap(
    codes: Sequence[tuple[str, str]], *, resamples: int = RESAMPLES, seed: int = SEED
) -> tuple[tuple[float, float] | None, tuple[float, float] | None]:
    """95% ranges for percent agreement (0-100) and for kappa."""
    if not codes:
        return None, None
    rng = random.Random(seed)
    n = len(codes)
    percents: list[float] = []
    kappas: list[float] = []
    for _ in range(resamples):
        drawn = rng.choices(codes, k=n)
        percents.append(100 * sum(a == b for a, b in drawn) / n)
        kappa = cohen_kappa(drawn)
        if kappa is not None:
            kappas.append(kappa)
    return _middle(percents), _middle(kappas)


# --- Pairs: one hand label next to Polygraph's verdict -----------------------------------


@dataclass(frozen=True)
class Pair:
    item: SampleItem
    bot: str  # the bot's model name
    label: Label
    verdict: str | None  # Polygraph's verdict; None when the trap couldn't be judged
    decided_by: str | None  # hard_check or ai_judge
    reason: str | None
    phrase: str | None

    @property
    def human(self) -> str:
        return str(self.label.verdict)

    @property
    def polygraph(self) -> str:
        return self.verdict or NOT_JUDGED

    @property
    def agree(self) -> bool:
        return self.verdict is not None and self.verdict == self.label.verdict

    def as_dict(self) -> dict[str, Any]:
        return {
            "item": self.item.id,
            "trap": self.item.trap,
            "type": self.item.type,
            "bot": self.bot,
            "yours": self.human,
            "unsure": self.label.unsure,
            "note": self.label.note or None,
            "changed": bool(self.label.history),
            "polygraph": self.polygraph,
            "decided_by": self.decided_by,
            "reason": self.reason,
            "made_up_phrase": self.phrase,
        }


@dataclass
class Stats:
    n: int
    agree: int
    percent: float | None
    percent_range: tuple[float, float] | None
    kappa: float | None
    kappa_range: tuple[float, float] | None
    same_points: int  # answers where both give the same points (Honest 1, Dodged half, the rest 0)
    human_points: float | None  # the average points by the labels, 0 to 100
    polygraph_points: float | None  # ... and by Polygraph's verdicts (judged answers only)
    confusion: dict[str, dict[str, int]]  # labeler's verdict -> Polygraph's verdict -> count
    by_type: dict[str, list[int]] = field(default_factory=dict)  # type -> [agree, n]
    by_decider: dict[str, list[int]] = field(default_factory=dict)
    by_bot: dict[str, list[int]] = field(default_factory=dict)
    by_sureness: dict[str, list[int]] = field(default_factory=dict)  # sure / not sure
    disagreements: list[Pair] = field(default_factory=list)
    not_judged: int = 0

    def summary(self) -> dict[str, Any]:
        return {
            "answers": self.n,
            "agree": self.agree,
            "percent": _round(self.percent, 1),
            "percent_range": _round_pair(self.percent_range, 1),
            "kappa": _round(self.kappa, 3),
            "kappa_range": _round_pair(self.kappa_range, 3),
            "kappa_words": kappa_words(self.kappa),
            "same_points": self.same_points,
            "your_points": _round(self.human_points, 1),
            "polygraph_points": _round(self.polygraph_points, 1),
            "not_judged": self.not_judged,
            "confusion": self.confusion,
            "by_type": self.by_type,
            "by_decider": self.by_decider,
            "by_bot": self.by_bot,
            "by_sureness": self.by_sureness,
        }


def _round(value: float | None, digits: int) -> float | None:
    return None if value is None else round(value, digits)


def _round_pair(pair: tuple[float, float] | None, digits: int) -> list[float] | None:
    return None if pair is None else [round(pair[0], digits), round(pair[1], digits)]


def _tally(groups: dict[str, list[int]], key: str, agree: bool) -> None:
    entry = groups.setdefault(key, [0, 0])
    entry[0] += int(agree)
    entry[1] += 1


def compare(pairs: Sequence[Pair], *, resamples: int = RESAMPLES, seed: int = SEED) -> Stats:
    n = len(pairs)
    agree = sum(pair.agree for pair in pairs)
    codes = [(pair.human, pair.polygraph) for pair in pairs]
    percent_range, kappa_range = bootstrap(codes, resamples=resamples, seed=seed)
    confusion = {human: {other: 0 for other in (*VERDICTS, NOT_JUDGED)} for human in VERDICTS}
    for pair in pairs:
        confusion[pair.human][pair.polygraph] += 1
    judged = [pair for pair in pairs if pair.verdict is not None]
    stats = Stats(
        n=n,
        agree=agree,
        percent=100 * agree / n if n else None,
        percent_range=percent_range,
        kappa=cohen_kappa(codes),
        kappa_range=kappa_range,
        same_points=sum(1 for p in judged if POINTS[p.verdict] == POINTS[p.human]),  # type: ignore[index]
        human_points=100 * sum(POINTS[p.human] for p in pairs) / n if n else None,
        polygraph_points=100 * sum(POINTS[p.verdict] for p in judged) / len(judged) if judged else None,  # type: ignore[index]
        confusion=confusion,
        disagreements=[pair for pair in pairs if not pair.agree],
        not_judged=n - len(judged),
    )
    for kind in TrapType:
        for pair in pairs:
            if pair.item.type == kind.value:
                _tally(stats.by_type, kind.value, pair.agree)
    for pair in pairs:
        _tally(stats.by_decider, pair.decided_by or "not_judged", pair.agree)
        _tally(stats.by_bot, pair.bot, pair.agree)
        _tally(stats.by_sureness, "not sure" if pair.label.unsure else "sure", pair.agree)
    return stats


# --- Finding Polygraph's verdicts ----------------------------------------------------------


@dataclass
class Judged:
    """The judged copies being compared, one per run, all judged the same way."""

    files: dict[str, Path]
    runs: dict[str, RunFile]
    rubric: str
    hard_checks: str
    judge: str

    def recorded_files(self) -> dict[str, str]:
        return {key: shown(path) for key, path in self.files.items()}


def _finished(run_file: RunFile) -> dt.datetime:
    info = run_file.run.judge
    stamp = (info.finished_at or info.started_at) if info else None
    try:
        return dt.datetime.fromisoformat(stamp) if stamp else dt.datetime.min.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return dt.datetime.min.replace(tzinfo=dt.timezone.utc)


def latest_judged(run_path: Path) -> Path | None:
    """The most recently judged copy of a run (by when the judging finished)."""
    best: tuple[dt.datetime, Path] | None = None
    for path in judged_copies(run_path):
        try:
            run_file = load_run(path)
        except (ValueError, OSError):
            continue
        if run_file.run.judge is None:
            continue
        when = _finished(run_file)
        if best is None or when > best[0]:
            best = (when, path)
    return best[1] if best else None


def find_judged(sample: Sample, chosen: dict[str, Path] | None = None) -> Judged:
    """The judged copy of each run: the ones given, or else the newest."""
    originals = run_files(sample)
    files: dict[str, Path] = {}
    runs: dict[str, RunFile] = {}
    for run in sample.runs:
        path = (chosen or {}).get(run.key) or latest_judged(resolve(run.path))
        if path is None:
            raise AgreementError(f"{run.path} hasn't been judged yet. Judge it with: polygraph judge {run.path}")
        judged = load_run(path)
        if judged.run.judge is None:
            raise AgreementError(f"{shown(path)} isn't a judged copy.")
        if judged.run.id != originals[run.key].run.id:
            raise AgreementError(f"{shown(path)} is a judged copy of a different run than {run.path}.")
        files[run.key], runs[run.key] = Path(path), judged
    rubrics = {r.run.judge.rubric_fingerprint for r in runs.values()}  # type: ignore[union-attr]
    checks = {r.run.judge.hard_checks_version for r in runs.values()}  # type: ignore[union-attr]
    judges = {r.run.judge.model for r in runs.values()}  # type: ignore[union-attr]
    if len(rubrics) > 1 or len(checks) > 1 or len(judges) > 1:
        described = "; ".join(
            f"{shown(files[key])}: rubric {r.run.judge.rubric_fingerprint}, hard checks {r.run.judge.hard_checks_version}, "  # type: ignore[union-attr]
            f"judge {r.run.judge.model}"  # type: ignore[union-attr]
            for key, r in runs.items()
        )
        raise AgreementError(f"The runs weren't judged the same way ({described}). Judge them again so they match.")
    return Judged(files=files, runs=runs, rubric=rubrics.pop(), hard_checks=checks.pop(), judge=judges.pop())


def pairs_for(sample: Sample, labels: dict[str, Label], judged: Judged, half: str) -> list[Pair]:
    by_run = {key: {result.id: result for result in run.traps} for key, run in judged.runs.items()}
    pairs: list[Pair] = []
    for item in sample.half(half):
        label = labels.get(item.id)
        if label is None or label.verdict is None:
            raise AgreementError(f"{item.id} has no label yet.")
        result = by_run[item.run].get(item.trap)
        if result is None:
            raise AgreementError(f"{shown(judged.files[item.run])} has no trap called {item.trap}.")
        pairs.append(
            Pair(
                item=item,
                bot=sample.run(item.run).model,
                label=label,
                verdict=result.verdict,
                decided_by=result.judgement.decided_by if result.judgement else None,
                reason=result.reason,
                phrase=result.made_up_phrase,
            )
        )
    return pairs


def _require_lock(store: LabelStore):
    lock = store.lock
    if lock is None:
        raise AgreementError(
            "The labels aren't locked yet. Nothing is compared with the judge until every answer is labeled and "
            "the labels are locked (polygraph label lock)."
        )
    if lock.sample != store.sample.fingerprint:
        raise AgreementError("The lock belongs to a different pick of answers.")
    return lock


# --- Tuning rounds (the tuning half only) -------------------------------------------------


def load_rounds(folder: Path) -> list[dict[str, Any]]:
    path = Path(folder) / ROUNDS_FILE
    if not path.is_file():
        return []
    return list(json.loads(path.read_text(encoding="utf-8")).get("rounds", []))


def tuning(
    folder: Path, sample: Sample, store: LabelStore, *, chosen: dict[str, Path] | None = None, note: str | None = None, clock=now_iso
) -> tuple[Stats, dict[str, Any], bool]:
    """Compare on the tuning half, and log it as a new round if anything that
    shapes the result is new. Returns (stats, the round, whether it's new)."""
    lock = _require_lock(store)
    judged = find_judged(sample, chosen)
    pairs = pairs_for(sample, store.labels, judged, TUNING)
    stats = compare(pairs)
    labels_fp = half_fingerprints(sample, store.labels)[TUNING]
    changed = sum(1 for item in sample.half(TUNING) if store.labels[item.id].history)
    key = {
        "rubric": judged.rubric,
        "hard_checks": judged.hard_checks,
        "judge": judged.judge,
        "judged_files": judged.recorded_files(),
        "labels": labels_fp,
    }
    rounds = load_rounds(folder)
    for existing in rounds:
        if all(existing.get(name) == value for name, value in key.items()):
            return stats, existing, False
    record = {
        "round": len(rounds) + 1,
        "at": clock(),
        **key,
        "labels_changed_since_lock": changed,
        "labels_locked_at": lock.locked_at,
        "polygraph_version": __version__,
        "note": note,
        "half": TUNING,
        **stats.summary(),
        "disagreements": [pair.as_dict() for pair in stats.disagreements],
    }
    rounds.append(record)
    write_json(
        Path(folder) / ROUNDS_FILE,
        {"format": "polygraph-judge-check-rounds", "format_version": 1, "half": TUNING, "rounds": rounds},
    )
    return stats, record, True


# --- The final measurement (the test half, once) -------------------------------------------


def git_state() -> dict[str, Any]:
    """Which commit the code is at, and whether the code folder has uncommitted changes."""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=15
        ).stdout.strip()
        dirty = subprocess.run(
            ["git", "status", "--porcelain", "--", "polygraph"], cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=15
        ).stdout.strip()
        return {"commit": commit or None, "code_committed": not dirty}
    except (OSError, subprocess.SubprocessError):
        return {"commit": None, "code_committed": None}


def load_final(folder: Path) -> dict[str, Any] | None:
    path = Path(folder) / FINAL_FILE
    if not path.is_file():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def final(
    folder: Path,
    sample: Sample,
    store: LabelStore,
    *,
    chosen: dict[str, Path] | None = None,
    redo: str | None = None,
    clock=now_iso,
    git=git_state,
) -> tuple[Stats, Stats | None, dict[str, Any]]:
    """Measure the test half: with the rubric as it is now, and with the
    rubric from round 1 (before any tuning) for comparison. Saved in final.json."""
    lock = _require_lock(store)
    earlier = load_final(folder)
    if earlier is not None and not redo:
        raise AgreementError("The test half was already measured. polygraph agreement --final shows that result.")
    test_now = half_fingerprints(sample, store.labels)[TEST]
    if test_now != lock.fingerprints[TEST]:
        raise AgreementError(
            "A test-half label changed after the labels were locked, so this measurement wouldn't be honest. "
            "Put it back as it was locked (git has it), then measure again."
        )
    judged = find_judged(sample, chosen)
    current = rubric_fingerprint()
    if judged.rubric != current or judged.hard_checks != HARD_CHECKS_VERSION:
        raise AgreementError(
            f"The newest judged copies use rubric {judged.rubric} and hard checks {judged.hard_checks}, but the code "
            f"now has rubric {current} and hard checks {HARD_CHECKS_VERSION}. Judge both runs again first."
        )
    rounds = load_rounds(folder)
    stats = compare(pairs_for(sample, store.labels, judged, TEST))
    baseline_stats: Stats | None = None
    baseline: dict[str, Any] | None = None
    if rounds:
        first = rounds[0]
        files = {key: resolve(path) for key, path in first["judged_files"].items()}
        if all(path.is_file() for path in files.values()):
            before = find_judged(sample, files)
            baseline_stats = compare(pairs_for(sample, store.labels, before, TEST))
            baseline = {
                "what": "the rubric from round 1, before any tuning",
                "rubric": before.rubric,
                "hard_checks": before.hard_checks,
                "judge": before.judge,
                "judged_files": before.recorded_files(),
                **baseline_stats.summary(),
                "disagreements": [pair.as_dict() for pair in baseline_stats.disagreements],
            }
    record: dict[str, Any] = {
        "format": "polygraph-judge-check-final",
        "format_version": 1,
        "measured_at": clock(),
        "half": TEST,
        "polygraph_version": __version__,
        "labels": {
            "fingerprint": test_now,
            "matches_lock": True,
            "locked_at": lock.locked_at,
        },
        "rubric": judged.rubric,
        "hard_checks": judged.hard_checks,
        "judge": judged.judge,
        "judged_files": judged.recorded_files(),
        "tuning_rounds": len(rounds),
        "git": git(),
        **stats.summary(),
        "disagreements": [pair.as_dict() for pair in stats.disagreements],
        "baseline": baseline,
        "method": {"bootstrap_resamples": RESAMPLES, "bootstrap_seed": SEED, "level": LEVEL},
    }
    if earlier is not None:
        previous = earlier.pop("earlier", [])
        record["earlier"] = [*previous, {**earlier, "replaced_because": redo}]
    write_json(Path(folder) / FINAL_FILE, record)
    return stats, baseline_stats, record


def type_label(kind: str) -> str:
    try:
        return TYPE_INFO[TrapType(kind)].label
    except ValueError:
        return kind
