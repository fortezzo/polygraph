"""The hand labels: saved the moment they're made, so labeling can stop and
pick up again any time.

- labels.json holds one label per answer: the verdict, "not sure", a note,
  when it was made and every earlier version (a changed label keeps its old
  ones in its history).
- Locking (lock.json) freezes the labels once all of them are done, before
  anything is compared with the judge. After that, the labeling page is
  read-only, and only a tuning-half label can still change, during the
  walkthrough, with the change recorded. The test half stays exactly as it
  was labeled, and the final measurement checks that it did.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from polygraph import __version__
from polygraph.interrogator.calls import now_iso
from polygraph.judgecheck.files import fingerprint, shown, write_json
from polygraph.judgecheck.sample import TEST, TUNING, Sample
from polygraph.judges.rubric import ALLOWED
from polygraph.runfile import Verdict

LABELS_FILE = "labels.json"
LOCK_FILE = "lock.json"
NOTE_LIMIT = 2_000  # characters
LABELER = "Christian Fortezzo"
_UNSET = object()

Where = Literal["page", "walkthrough"]


class LabelError(Exception):
    """A label that can't be saved, in plain English. `code` says why, for the page."""

    def __init__(self, message: str, code: str = "invalid") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Version(_Model):
    """An earlier version of a label."""

    verdict: Verdict | None = None
    unsure: bool = False
    note: str = ""
    at: str | None = None  # when this version was made
    where: Where = "page"


class Label(_Model):
    verdict: Verdict | None = None  # None until a verdict is picked
    unsure: bool = False
    note: str = ""
    first_labeled_at: str | None = None
    labeled_at: str | None = None  # when the verdict last changed
    labeled_in: Where = "page"
    seconds: float | None = None  # time on the page before the first pick
    history: list[Version] = Field(default_factory=list)  # earlier versions, oldest first


class LabelFile(_Model):
    format: Literal["polygraph-judge-check-labels"] = "polygraph-judge-check-labels"
    format_version: int = 1
    sample: str  # the pick's fingerprint: labels only ever belong to one pick
    labeler: str = LABELER
    labels: dict[str, Label] = Field(default_factory=dict)


class Lock(_Model):
    format: Literal["polygraph-judge-check-lock"] = "polygraph-judge-check-lock"
    format_version: int = 1
    locked_at: str
    sample: str
    labels: int
    fingerprints: dict[str, str]  # all, tuning and test: change if any verdict in them changes
    polygraph_version: str


def labels_fingerprint(labels: dict[str, Label], item_ids: list[str]) -> str:
    """Changes if any of these answers' verdicts changes."""
    return fingerprint({item: labels[item].verdict if item in labels else None for item in sorted(item_ids)})


def half_fingerprints(sample: Sample, labels: dict[str, Label]) -> dict[str, str]:
    return {
        "all": labels_fingerprint(labels, [item.id for item in sample.items]),
        TUNING: labels_fingerprint(labels, [item.id for item in sample.half(TUNING)]),
        TEST: labels_fingerprint(labels, [item.id for item in sample.half(TEST)]),
    }


class LabelStore:
    """Reads and saves labels.json. Safe to use from the labeling page's
    threads: every change re-reads the file, applies the change and saves."""

    def __init__(self, folder: Path, sample: Sample, *, clock=now_iso) -> None:
        self.folder = Path(folder)
        self.path = self.folder / LABELS_FILE
        self.lock_path = self.folder / LOCK_FILE
        self.sample = sample
        self.items = {item.id: item for item in sample.items}
        self.clock = clock
        self._mutex = threading.Lock()
        self.data = self._read()

    def _read(self) -> LabelFile:
        if not self.path.is_file():
            return LabelFile(sample=self.sample.fingerprint)
        try:
            data = LabelFile.model_validate_json(self.path.read_text(encoding="utf-8"))
        except ValueError as problem:
            raise LabelError(f"{shown(self.path)} couldn't be read ({str(problem).splitlines()[0]}).") from problem
        if data.sample != self.sample.fingerprint:
            raise LabelError(
                f"The labels in {shown(self.path)} belong to a different pick of answers "
                f"({data.sample}, not {self.sample.fingerprint})."
            )
        unknown = sorted(set(data.labels) - set(self.items))
        if unknown:
            raise LabelError(f"{shown(self.path)} has labels for answers that aren't in the pick: {', '.join(unknown)}.")
        return data

    @property
    def labels(self) -> dict[str, Label]:
        return self.data.labels

    @property
    def lock(self) -> Lock | None:
        if not self.lock_path.is_file():
            return None
        return Lock.model_validate_json(self.lock_path.read_text(encoding="utf-8"))

    def labeled(self) -> int:
        return sum(1 for label in self.labels.values() if label.verdict is not None)

    def first_unlabeled(self) -> str | None:
        for item in self.sample.items:
            label = self.labels.get(item.id)
            if label is None or label.verdict is None:
                return item.id
        return None

    def set(
        self,
        item_id: str,
        *,
        verdict: object = _UNSET,
        unsure: bool | None = None,
        note: str | None = None,
        seconds: float | None = None,
        where: Where = "page",
    ) -> Label:
        """Change one label and save it straight away."""
        with self._mutex:
            self.data = self._read()  # another window may have saved since
            item = self.items.get(item_id)
            if item is None:
                raise LabelError(f"There's no answer called {item_id}.", code="unknown")
            lock = self.lock
            if lock is not None and where == "page":
                raise LabelError(
                    "Your labels are locked, so this page is read-only now. To change a label after we've talked "
                    "it through, tell Claude in the polygraph tab.",
                    code="locked",
                )
            if lock is not None and item.half == TEST:
                raise LabelError(
                    f"{item_id} is in the test half. Those labels stay exactly as you made them, so the final "
                    "number is measured against them.",
                    code="test_half",
                )
            label = self.labels.get(item_id) or Label()
            new_verdict = label.verdict if verdict is _UNSET else verdict
            if new_verdict is not None and new_verdict not in ALLOWED[item.type]:
                allowed = ", ".join(v.title() for v in ALLOWED[item.type])
                raise LabelError(f"{str(new_verdict).title()} doesn't apply to this kind of trap. Pick one of: {allowed}.")
            new_unsure = label.unsure if unsure is None else bool(unsure)
            new_note = label.note if note is None else str(note)
            if len(new_note) > NOTE_LIMIT:
                raise LabelError(f"Notes can be up to {NOTE_LIMIT:,} characters.")

            changed = new_verdict != label.verdict
            if where == "walkthrough":
                changed = changed or new_unsure != label.unsure or new_note != label.note
            now = self.clock()
            if changed and label.verdict is not None:
                label.history.append(
                    Version(
                        verdict=label.verdict,
                        unsure=label.unsure,
                        note=label.note,
                        at=label.labeled_at,
                        where=label.labeled_in,
                    )
                )
            if new_verdict is not None and label.first_labeled_at is None:
                label.first_labeled_at = now
                if seconds is not None and seconds >= 0:
                    label.seconds = round(float(seconds), 1)
            if changed:
                label.labeled_at = now
                label.labeled_in = where
            label.verdict = new_verdict  # type: ignore[assignment]
            label.unsure = new_unsure
            label.note = new_note
            self.labels[item_id] = label
            write_json(self.path, self.data.model_dump(mode="json"))
            return label


def lock_labels(store: LabelStore) -> Lock:
    """Freeze the labels, once every answer has one. Run before anything is
    compared with the judge."""
    if store.lock is not None:
        raise LabelError(f"The labels were already locked on {store.lock.locked_at}.", code="locked")
    missing = [item.id for item in store.sample.items if (store.labels.get(item.id) or Label()).verdict is None]
    if missing:
        raise LabelError(
            f"{len(missing)} answer{'s' if len(missing) != 1 else ''} still need{'s' if len(missing) == 1 else ''} "
            f"a label, starting with {missing[0]}.",
            code="incomplete",
        )
    lock = Lock(
        locked_at=store.clock(),
        sample=store.sample.fingerprint,
        labels=len(store.sample.items),
        fingerprints=half_fingerprints(store.sample, store.labels),
        polygraph_version=__version__,
    )
    write_json(store.lock_path, lock.model_dump(mode="json"))
    return lock
