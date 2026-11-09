"""Small text helpers shared by the checks: splitting an answer into sentences
without losing track of where each one is, so anything Polygraph quotes is
copied exactly from the bot's answer."""

from __future__ import annotations

import re
import unicodedata

# Words that end with a period without ending the sentence.
_ABBREVIATIONS = {
    "e.g", "i.e", "vs", "etc", "approx", "dr", "mr", "mrs", "ms", "prof", "st", "no", "nos", "fig", "figs",
    "u.s", "u.k", "jr", "sr", "inc", "ltd", "co", "al", "ca", "cf", "vol", "pp", "p", "ed", "eds", "ch",
}
# A sentence ends at . ! or ? followed by a space and something that can start one.
_BOUNDARY = re.compile(r"[.!?](?=\s+[\"“'‘(\[*A-Z0-9])")
# List markers like "1.", "2)", "-", "*" or "#" at the start of a line.
_LIST_MARKER = re.compile(r"[ \t]*(?:\d{1,2}[.)]|[-*•]|#{1,6})[ \t]+")
# Markdown and odd spaces, swapped one-for-one so positions stay the same.
_SAME_LENGTH = str.maketrans({" ": " ", " ": " ", " ": " ", " ": " ", "−": "-", "`": " "})


def clean(text: str) -> str:
    """The same text, the same length, with markdown bold (** and __) and
    backticks turned into spaces, and odd spaces and minus signs made plain.
    Positions in the result match positions in the original."""
    return text.replace("**", "  ").replace("__", "  ").translate(_SAME_LENGTH)


def _trim(text: str, start: int, end: int) -> tuple[int, int]:
    while start < end and text[start].isspace():
        start += 1
    marker = _LIST_MARKER.match(text, start, end)
    if marker is not None and marker.end() < end:
        start = marker.end()
    while end > start and text[end - 1].isspace():
        end -= 1
    return start, end


def sentence_spans(text: str) -> list[tuple[int, int]]:
    """(start, end) of each sentence in `text`. Every line break ends a
    sentence too, and list markers at the start of a line are left out."""
    spans: list[tuple[int, int]] = []
    for line in re.finditer(r"[^\n]+", text):
        begin = line.start()
        for boundary in _BOUNDARY.finditer(text, line.start(), line.end()):
            so_far = text[begin : boundary.start() + 1]
            if re.fullmatch(r"\s*\d{1,2}[.)]", so_far):
                continue  # a list number like "1.", not a sentence
            before = re.search(r"([\w.]+)\.?$", so_far)
            if before is not None and before.group(1).casefold().rstrip(".") in _ABBREVIATIONS:
                continue
            spans.append(_trim(text, begin, boundary.end()))
            begin = boundary.end()
        spans.append(_trim(text, begin, line.end()))
    return [(start, end) for start, end in spans if end > start]


def sentences(text: str) -> list[str]:
    return [text[start:end] for start, end in sentence_spans(text)]


def plain(text: str) -> str:
    """Lowercase, with accents removed: 'Kühn' and 'kuhn' come out the same."""
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()


def one_line(text: str, limit: int = 200) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"
