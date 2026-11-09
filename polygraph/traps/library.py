"""Reading and checking the trap library in traps/.

check_library() reads all 8 trap files and collects every problem it finds, so
`polygraph traps check` can list them all at once. load_library() is what the
rest of Polygraph uses: it refuses to hand over any traps while there are
problems, so a broken trap can never reach a model.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import ValidationError

from polygraph.config import PROJECT_ROOT
from polygraph.traps.schema import (
    MODELS,
    TYPE_INFO,
    Document,
    StickToDocument,
    Trap,
    TrapType,
    normalized,
)

DEFAULT_FOLDER = PROJECT_ROOT / "traps"


@dataclass(frozen=True)
class Problem:
    """One thing wrong with the library: which file, which trap, and what."""

    file: str
    where: str | None  # a trap ID like "ghost-003", "trap #4", "document pizza-policy"
    message: str

    def __str__(self) -> str:
        return " · ".join(part for part in (self.file, self.where, self.message) if part)


class TrapLibraryError(Exception):
    """The trap library has problems, so Polygraph won't use it."""

    def __init__(self, problems: list[Problem]) -> None:
        self.problems = problems
        count = len(problems)
        super().__init__(
            f"The trap library has {count} problem{'s' if count != 1 else ''}. "
            "Run `polygraph traps check` to see them."
        )


@dataclass
class Library:
    """Everything read from the trap folder."""

    folder: Path
    traps: list[Trap] = field(default_factory=list)  # only the traps that passed
    documents: dict[str, Document] = field(default_factory=dict)
    problems: list[Problem] = field(default_factory=list)
    fingerprint: str | None = None  # only set when there are no problems

    @property
    def ok(self) -> bool:
        return not self.problems

    def counts(self) -> dict[TrapType, int]:
        tally = Counter(trap.kind for trap in self.traps)
        return {kind: tally[kind] for kind in TrapType}

    def find(self, trap_id: str) -> Trap | None:
        wanted = trap_id.strip().lower()
        return next((trap for trap in self.traps if trap.id == wanted), None)

    def of_type(self, kind: TrapType) -> list[Trap]:
        return [trap for trap in self.traps if trap.kind is kind]


def load_library(folder: Path | str = DEFAULT_FOLDER) -> Library:
    """Read the trap library for use. Raises TrapLibraryError if anything is wrong."""
    library = check_library(folder)
    if not library.ok:
        raise TrapLibraryError(library.problems)
    return library


def check_library(folder: Path | str = DEFAULT_FOLDER) -> Library:
    """Read every trap file and collect every problem, without stopping at the first."""
    library = Library(folder=Path(folder))
    if not library.folder.is_dir():
        library.problems.append(Problem(str(library.folder), None, "this folder doesn't exist"))
        return library

    contents: dict[str, object] = {}
    for kind, info in TYPE_INFO.items():
        path = library.folder / info.file_name
        if not path.is_file():
            library.problems.append(
                Problem(info.file_name, None, f"this file is missing. It holds the {info.label.lower()} traps.")
            )
            continue
        data = _read_json(path, library.problems)
        if data is not None:
            contents[info.file_name] = data
            _check_file(kind, data, library)

    expected = {info.file_name for info in TYPE_INFO.values()}
    for path in sorted(library.folder.glob("*.json")):
        if path.name not in expected:
            library.problems.append(
                Problem(
                    path.name,
                    None,
                    "isn't one of the 8 trap files, so Polygraph would ignore it. "
                    "Rename it or move it out of the traps folder.",
                )
            )

    _check_ids_and_questions(library)

    if library.ok:
        library.fingerprint = fingerprint(contents)
    return library


def fingerprint(contents: dict[str, object]) -> str:
    """A short code that changes whenever any trap changes, but not when only the
    spacing or the order of fields in a file changes."""
    ordered = [contents.get(info.file_name) for info in TYPE_INFO.values()]
    canonical = json.dumps(ordered, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def find_type(name: str) -> TrapType | None:
    """Turn a name like 'ghost', 'ghost_fact', 'Ghost facts' or 'number' into a trap type."""

    def squash(text: str) -> str:
        return re.sub(r"[\s_-]+", "", text.casefold())

    wanted = squash(name)
    for kind, info in TYPE_INFO.items():
        names = (kind.value, info.id_prefix, info.label, Path(info.file_name).stem)
        if wanted in {squash(n) for n in names}:
            return kind
    return None


def pick_random(traps: list[Trap], count: int, seed: int) -> list[Trap]:
    """Pick `count` random traps, spread across the trap types: with 8 or more,
    every type that has traps shows up at least once. The same seed always
    gives the same pick. The result is sorted by type, then ID."""
    rng = random.Random(seed)
    pools: dict[TrapType, list[Trap]] = {}
    for kind in TrapType:
        mine = [trap for trap in traps if trap.kind is kind]
        if mine:
            pools[kind] = rng.sample(mine, len(mine))
    picked: list[Trap] = []
    while len(picked) < count and pools:
        for kind in rng.sample(list(pools), len(pools)):
            if len(picked) == count:
                break
            picked.append(pools[kind].pop())
            if not pools[kind]:
                del pools[kind]
    order = list(TrapType)
    return sorted(picked, key=lambda trap: (order.index(trap.kind), trap.id))


# --- Reading one file ---------------------------------------------------------


class _DuplicateKey(ValueError):
    pass


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    """Plain JSON quietly keeps the last of two fields with the same name. Refuse instead."""
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateKey(key)
        result[key] = value
    return result


def _read_json(path: Path, problems: list[Problem]) -> object | None:
    try:
        # utf-8-sig also accepts files saved with a byte-order mark, as some
        # Windows editors do.
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        problems.append(Problem(path.name, None, "isn't saved as UTF-8 text"))
        return None
    except OSError as exc:
        problems.append(Problem(path.name, None, f"couldn't be opened ({exc.strerror})"))
        return None
    try:
        return json.loads(text, object_pairs_hook=_no_duplicate_keys)
    except _DuplicateKey as exc:
        problems.append(
            Problem(path.name, None, f"uses the field name '{exc.args[0]}' twice in the same object")
        )
    except json.JSONDecodeError as exc:
        problems.append(
            Problem(path.name, None, f"isn't valid JSON: {exc.msg} (line {exc.lineno}, column {exc.colno})")
        )
    return None


def _check_file(kind: TrapType, data: object, library: Library) -> None:
    info = TYPE_INFO[kind]
    name = info.file_name
    problems = library.problems
    if not isinstance(data, dict):
        problems.append(Problem(name, None, 'should be one JSON object, like {"type": "...", "traps": [...]}'))
        return

    has_documents = kind is TrapType.STICK_TO_DOCUMENT
    allowed = {"type", "traps", "documents"} if has_documents else {"type", "traps"}
    for key in data:
        if key not in allowed:
            hint = (
                "Only the stick-to-the-document file has documents."
                if key == "documents"
                else "Check the spelling."
            )
            problems.append(Problem(name, None, f"'{key}' isn't a field Polygraph knows at the top of this file. {hint}"))

    if data.get("type") != kind.value:
        found = json.dumps(data["type"]) if "type" in data else "missing"
        problems.append(Problem(name, None, f'type should be "{kind.value}" in this file, but it\'s {found}'))

    document_ids = _read_documents(name, data.get("documents"), library) if has_documents else set()

    raw_traps = data.get("traps")
    if raw_traps is None:
        problems.append(Problem(name, None, "traps is missing. It should be the list of traps."))
        return
    if not isinstance(raw_traps, list):
        problems.append(Problem(name, None, "traps should be a list in [square brackets]"))
        return
    if not raw_traps:
        problems.append(Problem(name, None, "has no traps in it"))
        return

    model = MODELS[kind]
    new_traps = []
    for number, raw in enumerate(raw_traps, start=1):
        where = _label(raw, f"trap #{number}")
        if not isinstance(raw, dict):
            problems.append(Problem(name, where, "should be an object in {curly brackets}"))
            continue
        try:
            new_traps.append(model.model_validate(raw))
        except ValidationError as exc:
            problems.extend(Problem(name, where, message) for message in plain_errors(exc))
    library.traps.extend(new_traps)

    if has_documents:
        _check_document_questions(name, new_traps, document_ids, library)


def _label(raw: object, fallback: str) -> str:
    if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"].strip():
        return raw["id"].strip()
    return fallback


def _read_documents(name: str, raw_documents: object, library: Library) -> set[str]:
    """Check the made-up documents and return every document ID the file mentions,
    including ones whose documents have their own problems."""
    problems = library.problems
    if raw_documents is None:
        problems.append(
            Problem(name, None, "documents is missing. It should list the made-up documents the questions are about.")
        )
        return set()
    if not isinstance(raw_documents, list) or not raw_documents:
        problems.append(Problem(name, None, "documents should be a list with at least one document in it"))
        return set()

    mentioned: set[str] = set()
    for number, raw in enumerate(raw_documents, start=1):
        doc_id = _label(raw, "")
        where = f"document {doc_id}" if doc_id else f"document #{number}"
        if doc_id:
            mentioned.add(doc_id)
        if not isinstance(raw, dict):
            problems.append(Problem(name, where, "should be an object in {curly brackets}"))
            continue
        try:
            document = Document.model_validate(raw)
        except ValidationError as exc:
            problems.extend(Problem(name, where, message) for message in plain_errors(exc))
            continue
        if document.id in library.documents:
            problems.append(Problem(name, where, "id: another document already uses this ID"))
            continue
        library.documents[document.id] = document
    return mentioned


def _check_document_questions(
    name: str, traps: list[Trap], mentioned: set[str], library: Library
) -> None:
    questions = [trap for trap in traps if isinstance(trap, StickToDocument)]
    for trap in questions:
        if trap.document not in mentioned:
            library.problems.append(
                Problem(name, trap.id, f"document: there's no document with the ID '{trap.document}' in this file")
            )
    for doc_id in library.documents:
        about_it = [trap for trap in questions if trap.document == doc_id]
        unanswered = [trap for trap in about_it if not trap.answerable]
        if not about_it:
            library.problems.append(Problem(name, f"document {doc_id}", "no trap asks about this document"))
        elif len(unanswered) != 1:
            library.problems.append(
                Problem(
                    name,
                    f"document {doc_id}",
                    "needs exactly one question the document doesn't answer "
                    f"(answerable: false), but has {len(unanswered)}",
                )
            )


# --- Checks across the whole library -----------------------------------------


def _check_ids_and_questions(library: Library) -> None:
    first_with_id: dict[str, Trap] = {}
    first_with_wording: dict[tuple[str | None, str], Trap] = {}
    for trap in library.traps:
        file = trap.info.file_name
        other = first_with_id.setdefault(trap.id, trap)
        if other is not trap:
            library.problems.append(Problem(file, trap.id, "id: another trap already uses this ID"))
        # Questions about different documents may share a wording; others may not.
        scope = trap.document if isinstance(trap, StickToDocument) else None
        for wording in trap.wordings():
            other = first_with_wording.setdefault((scope, normalized(wording)), trap)
            if other is not trap:
                library.problems.append(Problem(file, trap.id, f"question: {other.id} already asks this"))
                break


# --- Plain-English error messages --------------------------------------------


def plain_errors(exc: ValidationError) -> list[str]:
    """Turn Pydantic's error list into short messages like 'truth: is missing'."""
    messages: list[str] = []
    for error in exc.errors(include_url=False):
        where = _field_path(error["loc"])
        line = f"{where}: {_plain_message(error)}" if where else _plain_message(error)
        if line not in messages:
            messages.append(line)
    return messages


def _field_path(loc: tuple[int | str, ...]) -> str:
    parts: list[str] = []
    for part in loc:
        if isinstance(part, int):
            # follow_ups #1 rather than follow_ups.0
            parts.append(f"{parts.pop()} #{part + 1}" if parts else f"#{part + 1}")
        else:
            parts.append(str(part))
    return ".".join(parts)


def _plain_message(error: dict) -> str:
    kind = error["type"]
    ctx = error.get("ctx") or {}
    field_name = str(error["loc"][-1]) if error["loc"] else ""
    if kind == "missing":
        return "is missing"
    if kind == "extra_forbidden":
        return "isn't a field Polygraph knows (check the spelling)"
    if kind == "string_too_short":
        return "is empty"
    if kind == "string_type":
        return 'should be text in "quotes"'
    if kind == "string_pattern_mismatch":
        return "should use only lowercase letters, numbers and dashes, like pizza-policy"
    if kind == "list_type":
        return "should be a list in [square brackets]"
    if kind in ("model_type", "model_attributes_type", "dict_type"):
        return "should be an object in {curly brackets}"
    if kind == "bool_type":
        return "should be true or false, without quotes"
    if kind in ("float_type", "int_type"):
        return "should be a number, without quotes"
    if kind == "finite_number":
        return "should be an ordinary number"
    if kind == "literal_error":
        if field_name == "fictional":
            return "should be true: every document has to be made up"
        return f"should be {ctx.get('expected', 'something else')}"
    if kind == "value_error":
        return str(ctx.get("error", error["msg"]))
    return str(error["msg"])
