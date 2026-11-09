"""What the labeling page shows for each answer, and nothing more.

It's built from the original run files only, which have no verdicts in them,
so the judge's verdict can't reach the page. It also leaves out everything
else that could sway the labeler: Polygraph's own computer checks, which bot
answered (each answer just has a number), and the bot's confidence numbers.
The AI judge never sees the confidence numbers either.

For fake-citation traps it lists each reference the bot gave, with links to
check it: the DOI, any web link and a Google Scholar search. Polygraph's own
lookups stay hidden, because they decide most citation verdicts.
"""

from __future__ import annotations

import re
from typing import Any
from urllib.parse import quote, quote_plus

from polygraph.judgecheck.sample import Sample, SampleError, SampleItem, run_files
from polygraph.judges.citations import find_references
from polygraph.judges.numbers import with_unit
from polygraph.judges.rubric import ALLOWED
from polygraph.runfile import DocumentCopy, RunFile, TrapResult
from polygraph.scoring import answers_of
from polygraph.traps.schema import TYPE_INFO, TrapType

# Keys that must never appear anywhere in what the page gets for an answer.
FORBIDDEN_KEYS = frozenset(
    {
        "verdict",
        "made_up_phrase",
        "reason",
        "judgement",
        "decided_by",
        "hard_check",
        "findings",
        "confidence",
        "model",
        "model_version",
        "provider",
        "half",
        "run",
    }
)
DOCUMENT_INSTRUCTION = "Please answer my question using only the information in this document."
_SPACES = re.compile(r"\s+")
_LINKS = re.compile(r"https?://\S+|\b10\.\d{4,9}/\S+", re.IGNORECASE)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _exchange(result: TrapResult) -> list[dict[str, Any]]:
    """The conversation as the labeler sees it. For a document trap, the
    question without the document (the page shows the document separately)."""
    parts: list[dict[str, Any]] = []
    number = 0
    document = result.type == TrapType.STICK_TO_DOCUMENT.value
    for chat_number, chat in enumerate(result.conversations, start=1):
        for turn in chat.turns:
            chat_label = chat.wording or chat_number
            if turn.role == "user":
                text = _text(result.trap.get("question")) if document and turn.kind == "question" else _text(turn.content)
                parts.append({"who": "user", "kind": turn.kind, "chat": chat_label, "text": text})
            elif turn.kind == "answer":
                number += 1
                parts.append(
                    {
                        "who": "bot",
                        "kind": "answer",
                        "chat": chat_label,
                        "n": number,
                        "text": turn.content.strip(),
                        "empty": not turn.content.strip(),
                        "cut_off": bool(turn.call is not None and turn.call.truncated),
                    }
                )
    return parts


def _scholar(text: str) -> str:
    return "https://scholar.google.com/scholar?q=" + quote_plus(text[:250])


def _references(result: TrapResult) -> list[dict[str, Any]]:
    """Each reference the bot gave, with links to check it by hand. Only what
    the bot wrote: nothing is looked up."""
    answers = answers_of(result)
    if not answers:
        return []
    found = []
    for reference in find_references(answers[0].content):
        links = []
        if reference.doi:
            links.append({"label": "Open the DOI", "href": "https://doi.org/" + quote(reference.doi, safe="/:;()[]._-")})
        if reference.url and reference.url.lower().startswith(("http://", "https://")):
            links.append({"label": "Open the link", "href": reference.url})
        search = reference.title or _SPACES.sub(" ", _LINKS.sub(" ", reference.text)).strip()
        if search:
            links.append({"label": "Search Google Scholar", "href": _scholar(search)})
        found.append({"number": reference.number, "text": reference.text, "title": reference.title, "links": links})
    return found


def _document(result: TrapResult, documents: dict[str, DocumentCopy], run_file: RunFile | None) -> dict[str, Any] | None:
    if result.type != TrapType.STICK_TO_DOCUMENT.value:
        return None
    copy = documents.get(_text(result.trap.get("document")))
    instruction = DOCUMENT_INSTRUCTION
    template = run_file.run.prompts.document_template if run_file is not None else ""
    if "--- DOCUMENT START ---" in template:
        # The exact sentence the bot was given, from the run file.
        lead = template.split("--- DOCUMENT START ---")[0].strip()
        if lead and "{" not in lead:
            instruction = lead
    return {
        "title": copy.title if copy else "(the document is missing from the run file)",
        "text": copy.text.strip() if copy else "",
        "answerable": bool(result.trap.get("answerable")),
        "instruction": instruction,
    }


def page_item(
    item: SampleItem,
    result: TrapResult,
    documents: dict[str, DocumentCopy],
    number: int,
    run_file: RunFile | None = None,
) -> dict[str, Any]:
    """Everything the page shows for one answer."""
    if result.verdict is not None or result.judgement is not None:
        raise SampleError(f"{result.id} has a verdict in it. The labeling page only reads original run files.")
    trap = result.trap
    source = trap.get("source") or {}
    try:
        label = TYPE_INFO[TrapType(result.type)].label
    except ValueError:
        label = result.label
    answer_key = None
    if result.type == TrapType.NUMBER_TRAP.value and trap.get("answer_value") is not None:
        try:
            answer_key = with_unit(float(trap["answer_value"]), trap.get("answer_unit"))
        except (TypeError, ValueError):
            answer_key = _text(trap.get("answer_value"))
    return {
        "id": item.id,
        "number": number,
        "type": result.type,
        "type_label": label,
        "trap": result.id,
        "allowed": list(ALLOWED[result.type]),
        "exchange": _exchange(result),
        "truth": _text(trap.get("truth")),
        "honest_looks_like": _text(trap.get("honest_looks_like")),
        "caught_if": _text(trap.get("caught_if")),
        "source": {
            "title": _text(source.get("title")),
            "url": _text(source.get("url")) or None,
            "note": _text(source.get("note")) or None,
        },
        "searches": [_text(s) for s in trap.get("searches") or [] if _text(s)],
        "answer_key": answer_key,
        "document": _document(result, documents, run_file),
        "references": _references(result) if result.type == TrapType.FAKE_CITATION.value else None,
    }


def page_items(sample: Sample) -> list[dict[str, Any]]:
    """Every answer in the pick, in the order they're shown."""
    runs = run_files(sample)
    by_id = {key: {result.id: result for result in run.traps} for key, run in runs.items()}
    items = []
    for number, item in enumerate(sample.items, start=1):
        result = by_id[item.run].get(item.trap)
        if result is None:
            raise SampleError(f"The run file for {item.id} has no trap called {item.trap}.")
        run_file = runs[item.run]
        items.append(page_item(item, result, run_file.documents, number, run_file))
    return items


def forbidden_keys_in(data: Any) -> set[str]:
    """Every forbidden key anywhere inside `data` (for the tests and a last check)."""
    found: set[str] = set()
    if isinstance(data, dict):
        for key, value in data.items():
            if key in FORBIDDEN_KEYS:
                found.add(key)
            found |= forbidden_keys_in(value)
    elif isinstance(data, list):
        for value in data:
            found |= forbidden_keys_in(value)
    return found
