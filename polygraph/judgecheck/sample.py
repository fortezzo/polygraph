"""Picking the answers to label, and splitting them into two halves.

PLAN.md section 5: half of the labels are used to improve the judge's rubric,
and agreement is measured on the other half, which is never used for tuning.

Everything is decided at once, with one random seed saved in the file, before
anything is labeled:
- the same number of answers from each trap type, as nearly as possible
  (12 or 13 of each when picking 100 from two runs of 80 traps)
- every trap at least once. The rest appear twice, once from each run, and
  each run gives the same number of answers.
- answers the labeler has already seen a verdict for can be left out
- the split: a tuning half and a test half with the same mix of trap types
  and bots. Both answers to the same trap go in the same half, so a lesson
  learned on one can't leak into the other through the same trap.
- the order the answers are shown in: shuffled, with the two answers to the
  same trap kept apart
"""

from __future__ import annotations

import collections
import random
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from polygraph import __version__
from polygraph.config import PROJECT_ROOT
from polygraph.interrogator.calls import now_iso
from polygraph.judgecheck.files import file_fingerprint, fingerprint, resolve, shown, write_json
from polygraph.runfile import RunFile, load_run
from polygraph.traps.schema import TrapType

FOLDER = PROJECT_ROOT / "docs" / "judge-check"
SAMPLE_FILE = "sample.json"
TUNING, TEST = "tuning", "test"
HALVES = (TUNING, TEST)
RUN_KEYS = ("A", "B")
KEEP_APART = 4  # the two answers to the same trap are at least this many places apart in the order
ATTEMPTS = 200_000


class SampleError(Exception):
    """A problem with picking the answers, in plain English."""


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SampleRun(_Model):
    """One run file the answers come from: always an original, never a judged copy."""

    key: str  # "A" or "B"
    path: str  # like runs/2026-11-08_21-51-00_ollama_llama3.2.json
    model: str  # the bot
    provider: str
    trap_set: str  # the trap library's fingerprint
    file_fingerprint: str  # the file's exact contents, so a change can't go unnoticed


class Exclusion(_Model):
    run: str
    trap: str
    why: str


class SampleItem(_Model):
    id: str  # item-001 is shown first
    run: str  # which run the answer comes from: "A" or "B"
    trap: str
    type: str
    half: Literal["tuning", "test"]


class Sample(_Model):
    format: Literal["polygraph-judge-check-sample"] = "polygraph-judge-check-sample"
    format_version: int = 1
    created_at: str
    polygraph_version: str
    seed: int
    size: int
    runs: list[SampleRun]
    excluded: list[Exclusion] = Field(default_factory=list)
    method: list[str] = Field(default_factory=list)  # how it was picked, in plain English
    items: list[SampleItem]

    def run(self, key: str) -> SampleRun:
        for run in self.runs:
            if run.key == key:
                return run
        raise SampleError(f"The pick has no run called {key}.")

    def half(self, name: str) -> list[SampleItem]:
        return [item for item in self.items if item.half == name]

    def item(self, item_id: str) -> SampleItem | None:
        for item in self.items:
            if item.id == item_id:
                return item
        return None

    @property
    def fingerprint(self) -> str:
        """Changes if anything about which answers were picked, or how, changes."""
        return fingerprint(
            {
                "seed": self.seed,
                "runs": [run.model_dump() for run in self.runs],
                "items": [item.model_dump() for item in self.items],
            }
        )


# --- Picking --------------------------------------------------------------------------


def _types(by_type: dict[str, list[str]]) -> list[str]:
    """The trap types in the library's order."""
    return [kind.value for kind in TrapType if by_type.get(kind.value)]


def _attempt(
    rng: random.Random,
    by_type: dict[str, list[str]],
    doubles: int,
    excluded: set[tuple[str, str]],
) -> list[tuple[str, str, str, str]] | None:
    """One try at a balanced pick: (run, trap, type, half) for every answer, or
    None if this try didn't balance."""
    types = _types(by_type)
    base, extra = divmod(doubles, len(types))
    extra_types = set(rng.sample(types, extra))
    doubles_for = {kind: base + (kind in extra_types) for kind in types}

    # A type with an odd number of doubles puts one more in one half. Alternate
    # which half, so both halves get the same number of doubles overall.
    odd = [kind for kind in types if doubles_for[kind] % 2]
    rng.shuffle(odd)
    odd_half = {kind: HALVES[n % 2] for n, kind in enumerate(odd)}
    odd_traps = [kind for kind in types if len(by_type[kind]) % 2]
    rng.shuffle(odd_traps)
    bigger_half = {kind: HALVES[n % 2] for n, kind in enumerate(odd_traps)}

    picks: list[tuple[str, str, str, str]] = []
    singles: dict[str, list[tuple[str, str]]] = {}  # type -> [(trap, half)]
    for kind in types:
        traps = list(by_type[kind])
        rng.shuffle(traps)
        eligible = [t for t in traps if ("A", t) not in excluded and ("B", t) not in excluded]
        count = doubles_for[kind]
        if len(eligible) < count:
            return None
        doubled = eligible[:count]
        rest = [t for t in traps if t not in doubled]

        # Each half gets half of this type's traps (one more for one half if odd).
        quota = {half: len(traps) // 2 for half in HALVES}
        if len(traps) % 2:
            quota[bigger_half[kind]] += 1
        in_half = {half: count // 2 for half in HALVES}
        if count % 2:
            in_half[odd_half[kind]] += 1
        if any(in_half[half] > quota[half] for half in HALVES):
            return None
        position = 0
        for half in HALVES:
            for trap_id in doubled[position : position + in_half[half]]:
                picks += [("A", trap_id, kind, half), ("B", trap_id, kind, half)]
            position += in_half[half]
        tuning_singles = quota[TUNING] - in_half[TUNING]
        singles[kind] = [(t, TUNING if n < tuning_singles else TEST) for n, t in enumerate(rest)]

    # Which bot answers each single: as many from each bot overall and within
    # each type, and never an answer that's left out.
    odd_singles = [kind for kind in types if len(singles[kind]) % 2]
    rng.shuffle(odd_singles)
    more_from_a = set(odd_singles[: len(odd_singles) // 2])
    for kind in types:
        chosen = singles[kind]
        wanted_a = len(chosen) // 2 + (kind in more_from_a)
        must_a = [t for t, _ in chosen if ("B", t) in excluded]
        must_b = [t for t, _ in chosen if ("A", t) in excluded]
        free = [t for t, _ in chosen if t not in must_a and t not in must_b]
        extra_a = wanted_a - len(must_a)
        if extra_a < 0 or extra_a > len(free):
            return None
        from_a = set(must_a) | set(rng.sample(free, extra_a))
        for trap_id, half in chosen:
            picks.append(("A" if trap_id in from_a else "B", trap_id, kind, half))

    # Both halves need the same number of answers from each bot (within one).
    for half in HALVES:
        bots = collections.Counter(run for run, _, _, h in picks if h == half)
        if abs(bots["A"] - bots["B"]) > 1:
            return None
    sizes = collections.Counter(h for _, _, _, h in picks)
    if abs(sizes[TUNING] - sizes[TEST]) > 1:
        return None
    return picks


def _kept_apart(order: list[tuple[str, str, str, str]]) -> bool:
    seen: dict[str, int] = {}
    for position, (_, trap_id, _, _) in enumerate(order):
        if trap_id in seen and position - seen[trap_id] < KEEP_APART:
            return False
        seen[trap_id] = position
    return True


def pick_items(
    first: RunFile,
    second: RunFile,
    *,
    size: int,
    seed: int,
    excluded: set[tuple[str, str]] | None = None,
) -> list[SampleItem]:
    """The answers to label, their halves and the order they're shown in."""
    excluded = excluded or set()
    done = {
        key: {result.id: result for result in run.traps if result.status == "done"}
        for key, run in zip(RUN_KEYS, (first, second))
    }
    common = sorted(set(done["A"]) & set(done["B"]))
    if not common:
        raise SampleError("The two runs have no finished traps in common.")
    by_type: dict[str, list[str]] = collections.defaultdict(list)
    for trap_id in common:
        if done["A"][trap_id].type != done["B"][trap_id].type:
            raise SampleError(f"{trap_id} is a different kind of trap in the two runs.")
        by_type[done["A"][trap_id].type].append(trap_id)
    doubles = size - len(common)
    if doubles < 0:
        raise SampleError(
            f"{size} answers is fewer than the {len(common)} traps the two runs share, so not every trap could appear."
        )
    if doubles > len(common):
        raise SampleError(f"Two runs of {len(common)} traps have only {2 * len(common)} answers, fewer than {size}.")
    for trap_id in common:
        if ("A", trap_id) in excluded and ("B", trap_id) in excluded:
            raise SampleError(f"Both answers to {trap_id} are left out, so it can't appear.")

    rng = random.Random(seed)
    picks = None
    for _ in range(ATTEMPTS):
        picks = _attempt(rng, by_type, doubles, excluded)
        if picks is not None:
            break
    if picks is None:
        raise SampleError(f"Couldn't find a balanced pick with seed {seed}. Try another seed.")

    order = list(picks)
    for _ in range(ATTEMPTS):
        rng.shuffle(order)
        if _kept_apart(order):
            break
    else:
        raise SampleError(f"Couldn't keep the two answers to each trap apart with seed {seed}. Try another seed.")
    return [
        SampleItem(id=f"item-{number:03d}", run=run, trap=trap_id, type=kind, half=half)  # type: ignore[arg-type]
        for number, (run, trap_id, kind, half) in enumerate(order, start=1)
    ]


def check_items(items: list[SampleItem]) -> list[str]:
    """Problems with a pick, in plain English (none for a good one)."""
    problems: list[str] = []
    ids = [item.id for item in items]
    if len(set(ids)) != len(ids):
        problems.append("Two answers have the same ID.")
    pairs = collections.Counter((item.run, item.trap) for item in items)
    if any(count > 1 for count in pairs.values()):
        problems.append("The same answer was picked twice.")
    halves_of: dict[str, set[str]] = collections.defaultdict(set)
    for item in items:
        halves_of[item.trap].add(item.half)
    split = sorted(trap for trap, halves in halves_of.items() if len(halves) > 1)
    if split:
        problems.append(f"These traps have answers in both halves: {', '.join(split)}.")
    by_type = collections.Counter(item.type for item in items)
    if by_type and max(by_type.values()) - min(by_type.values()) > 1:
        problems.append("The trap types aren't evenly spread.")
    sizes = collections.Counter(item.half for item in items)
    if abs(sizes[TUNING] - sizes[TEST]) > 1:
        problems.append("The two halves aren't the same size.")
    return problems


# --- Making, saving and loading the pick ----------------------------------------------


def _original(path: Path) -> RunFile:
    if not path.is_file():
        raise SampleError(f"There's no run file at {path}.")
    run_file = load_run(path)
    if run_file.run.judge is not None or any(result.verdict for result in run_file.traps):
        raise SampleError(
            f"{path.name} is a judged copy. Pick from the original run file, so the labeling page "
            "never even opens a file with verdicts in it."
        )
    return run_file


def make_sample(
    first: Path,
    second: Path,
    *,
    size: int = 100,
    seed: int,
    exclude_first: list[str] | None = None,
    exclude_why: str = "",
    clock=now_iso,
) -> Sample:
    """Pick `size` answers from two original run files. `exclude_first` lists
    traps whose answer from the first run must be left out."""
    paths = [Path(first), Path(second)]
    runs = [_original(path) for path in paths]
    prints = [file_fingerprint(path) for path in paths]
    if paths[0].resolve() == paths[1].resolve() or prints[0] == prints[1]:
        raise SampleError("Those are the same run file twice. Pick from two different runs.")
    if runs[0].run.trap_set.version != runs[1].run.trap_set.version:
        raise SampleError(
            "The two runs used different versions of the trap library "
            f"({runs[0].run.trap_set.version} and {runs[1].run.trap_set.version}), so the same trap ID "
            "could mean different questions."
        )
    first_ids = {result.id for result in runs[0].traps}
    unknown = sorted(set(exclude_first or []) - first_ids)
    if unknown:
        raise SampleError(f"The first run has no trap called {', '.join(unknown)}.")
    excluded = {("A", trap_id) for trap_id in exclude_first or []}
    items = pick_items(runs[0], runs[1], size=size, seed=seed, excluded=excluded)
    problems = check_items(items)
    if problems:
        raise SampleError(" ".join(problems))

    sample_runs = [
        SampleRun(
            key=key,
            path=shown(path),
            model=run.run.target.model,
            provider=run.run.target.provider,
            trap_set=run.run.trap_set.version,
            file_fingerprint=fingerprint_,
        )
        for key, path, run, fingerprint_ in zip(RUN_KEYS, paths, runs, prints)
    ]
    by_type = collections.Counter(item.type for item in items)
    doubled = sum(1 for count in collections.Counter(item.trap for item in items).values() if count == 2)
    method = [
        f"{size} answers from two original run files (never judged copies), picked with random seed {seed}.",
        f"{min(by_type.values())} or {max(by_type.values())} answers from each of the {len(by_type)} trap types.",
        f"Every one of the {len({item.trap for item in items})} traps appears at least once, and {doubled} appear "
        "twice, once from each bot.",
        f"Answers from each bot: {', '.join(f'{run.model} {sum(1 for i in items if i.run == run.key)}' for run in sample_runs)}.",
        "Split into a tuning half and a test half before anything was labeled, with the same mix of trap types and "
        "bots. Both answers to the same trap are always in the same half.",
        f"Shown in a shuffled order, with the two answers to the same trap at least {KEEP_APART} places apart.",
    ]
    if excluded:
        method.append(
            f"Left out: the first run's answers to {', '.join(sorted(t for _, t in excluded))}"
            + (f" ({exclude_why})" if exclude_why else "")
            + "."
        )
    return Sample(
        created_at=clock(),
        polygraph_version=__version__,
        seed=seed,
        size=size,
        runs=sample_runs,
        excluded=[Exclusion(run=run, trap=trap_id, why=exclude_why) for run, trap_id in sorted(excluded)],
        method=method,
        items=items,
    )


def save_sample(sample: Sample, folder: Path = FOLDER, *, replace: bool = False) -> Path:
    path = Path(folder) / SAMPLE_FILE
    if path.exists() and not replace:
        raise SampleError(
            f"There's already a pick of answers in {shown(path)}. It's kept so the split stays the one made "
            "before labeling."
        )
    write_json(path, sample.model_dump(mode="json"))
    return path


def load_sample(folder: Path = FOLDER) -> Sample:
    path = Path(folder) / SAMPLE_FILE
    if not path.is_file():
        raise SampleError(
            "There's no pick of answers to label yet. It's made once with: polygraph label pick <run file> <run file>"
        )
    try:
        return Sample.model_validate_json(path.read_text(encoding="utf-8"))
    except ValueError as problem:
        raise SampleError(f"{shown(path)} couldn't be read ({str(problem).splitlines()[0]}).") from problem


def run_files(sample: Sample) -> dict[str, RunFile]:
    """The original run files, checked to be exactly the ones the answers were picked from."""
    loaded: dict[str, RunFile] = {}
    for run in sample.runs:
        path = resolve(run.path)
        if not path.is_file():
            raise SampleError(f"The run file {run.path} is missing.")
        if file_fingerprint(path) != run.file_fingerprint:
            raise SampleError(f"The run file {run.path} has changed since the answers were picked.")
        loaded[run.key] = _original(path)
    return loaded
