"""The side-by-side comparison for consistency traps, with no AI.

The 4 answers are lined up: each wording's question, the answer's opening
line, whether it opens with a yes or a no, and the numbers it opens with.
Clear clashes are flagged: different numbers, or a yes next to a no.

This check never decides a verdict by itself. Whether "nitrogen (N2), about
78%" and "mostly nitrogen" mean the same thing can't be told reliably without
reading them, so the AI judge makes the call, seeing all 4 answers together
plus these flags.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from polygraph.judges.numbers import find_mentions, format_number
from polygraph.judges.text import clean, sentence_spans
from polygraph.runfile import TrapResult

LINED_UP, CLASH = "lined_up", "clash"

_YES = re.compile(r"^\W*(?:yes|yeah|yep|correct|that'?s\s+(?:right|correct|true)|true|indeed|absolutely)\b", re.IGNORECASE)
_NO = re.compile(
    r"^\W*(?:no|nope|not\s+(?:really|quite|exactly)|incorrect|false|that'?s\s+(?:not|incorrect|a\s+(?:common\s+)?(?:myth|misconception))|actually,?\s+no)\b",
    re.IGNORECASE,
)
_WORD_NUMBERS = {
    "zero": 0, "none": 0, "single": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}
_NUMBER_WORD = re.compile(rf"\b({'|'.join(_WORD_NUMBERS)})\b(?!\s+of\b)", re.IGNORECASE)
OPENING_SENTENCES = 2  # the numbers are read from this many opening sentences


@dataclass
class Row:
    wording: int
    question: str
    answer: str
    opening: str  # the answer's first sentence, exactly as written
    stance: str | None  # "yes", "no" or None
    numbers: list[float] = field(default_factory=list)


@dataclass
class SideBySide:
    rows: list[Row]
    clashes: list[str]

    @property
    def outcome(self) -> str:
        return CLASH if self.clashes else LINED_UP

    @property
    def summary(self) -> str:
        if self.clashes:
            return "Possible clashes between the answers: " + " ".join(self.clashes)
        return f"The {len(self.rows)} answers are lined up for the judge. No clash in their numbers or yes/no openings."

    def details(self) -> dict[str, Any]:
        return {
            "rows": [
                {
                    "wording": row.wording,
                    "question": row.question,
                    "opening": row.opening,
                    "stance": row.stance,
                    "numbers": row.numbers,
                }
                for row in self.rows
            ],
            "clashes": self.clashes,
        }

    def findings(self) -> str:
        """What the AI judge is told."""
        lines = [
            "Polygraph lined the answers up side by side (no AI involved). It only reads the openings, "
            "so read the full answers above too.",
        ]
        for row in self.rows:
            stance = {"yes": "opens with yes", "no": "opens with no"}.get(row.stance or "", "no yes or no")
            numbers = ", ".join(format_number(n) for n in row.numbers) or "none"
            lines.append(f'- Wording {row.wording}: {stance}; numbers in its opening: {numbers}; first sentence: "{row.opening}"')
        if self.clashes:
            lines.append("Flags: " + " ".join(self.clashes))
        else:
            lines.append("Flags: none.")
        return "\n".join(lines)


def _stance(answer: str) -> str | None:
    opening = clean(answer).strip()
    if _YES.match(opening):
        return "yes"
    if _NO.match(opening):
        return "no"
    return None


def _opening_numbers(answer: str) -> list[float]:
    spans = sentence_spans(answer)[:OPENING_SENTENCES]
    if not spans:
        return []
    text = answer[: spans[-1][1]]
    values: list[float] = [m.value for m in find_mentions(text)]
    values += [float(_WORD_NUMBERS[w.casefold()]) for w in _NUMBER_WORD.findall(clean(text))]
    return sorted(set(values))


def line_up(result: TrapResult) -> SideBySide:
    rows: list[Row] = []
    for number, chat in enumerate(sorted(result.conversations, key=lambda c: c.wording or 0), start=1):
        question = next((turn.content for turn in chat.turns if turn.role == "user"), "")
        answer = next((turn.content for turn in chat.turns if turn.kind == "answer"), "")
        spans = sentence_spans(answer)
        opening = answer[spans[0][0] : spans[0][1]] if spans else ""
        rows.append(
            Row(
                wording=chat.wording or number,
                question=question,
                answer=answer,
                opening=opening,
                stance=_stance(answer),
                numbers=_opening_numbers(answer),
            )
        )

    clashes: list[str] = []
    with_numbers = [row for row in rows if row.numbers]
    if len({tuple(row.numbers) for row in with_numbers}) > 1:
        listed = "; ".join(
            f"wording {row.wording}: {', '.join(format_number(n) for n in row.numbers)}" for row in with_numbers
        )
        clashes.append(f"Their openings give different numbers ({listed}).")
    yes = [row.wording for row in rows if row.stance == "yes"]
    no = [row.wording for row in rows if row.stance == "no"]
    if yes and no:
        clashes.append(
            f"Wording {_and(yes)} {'opens' if len(yes) == 1 else 'open'} with yes and wording {_and(no)} with no: "
            "check whether those questions need the same answer."
        )
    return SideBySide(rows=rows, clashes=clashes)


def _and(numbers: list[int]) -> str:
    items = [str(n) for n in numbers]
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + " and " + items[-1]
