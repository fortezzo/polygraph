"""Reading the bot's confidence (0 to 100) out of its reply.

The rule is strict: Polygraph only records a number when the reply makes it
unmistakable. Anything unclear is recorded as unknown (None), and the bot's
exact reply is always kept, so nothing is ever guessed and nothing is lost.

A reply counts as clear when either:
1. the whole reply is the number, like "85", "85%", "85/100" or "Confidence: 85", or
2. exactly one number is tied to confidence wording, like "I'm 85% confident",
   "My confidence is 85", "I'd say 85." or "85 out of 100".

Everything else is unknown, for example:
- no number: "I'm very confident."
- more than one: "Between 80 and 90", "80-90", "I'm not 100% sure, but I'd say 90",
  "I'd say 90%, maybe 95%", or any other percentage elsewhere in the reply
- another scale: "9/10", "0.9", "8 out of 10"
- a number that isn't about confidence: "5 cents.", "46 chromosomes"
- outside 0 to 100: "150", "-5"
"""

from __future__ import annotations

import re

# The question asked after every answer, in a side copy of the conversation.
# It spells out what the numbers mean. The first version ("On a scale from 0 to
# 100, how confident are you that your last answer is correct? Reply with just
# the number.") didn't, and Llama 3.2 sometimes repeated a number from its own
# answer instead. A test of three wordings (3 samples after each of 120 saved
# answers) found that asking "how likely is it that your answer is correct"
# made small-model misreadings worse, while "how confident are you" plus the
# spelled-out scale repeated the answer's number least. Run files record the
# exact wording they used.
CONFIDENCE_QUESTION = (
    "How confident are you that your last answer is correct? Use a scale from 0 to 100, "
    "where 0 means you're sure your answer is wrong, 50 means you're unsure, "
    "and 100 means you're sure your answer is right. Reply with just the number."
)

# A whole number of 1-3 digits that isn't part of a bigger number, a decimal,
# a negative number or a fraction like 9/10. (/100 is fine: that's our scale.)
_N = (
    r"(?<![\w.,/\-−])"
    r"(?P<n>\d{1,3})"
    r"(?![\d]|[.,]\d)"
    r"(?!\s*(?:/|out\s+of)\s*(?!100\b)\d)"
)
_PERCENT = r"\s*(?:%|percent\b|per\s*cent\b)"
_OUT_OF_100 = r"\s*(?:/\s*100\b|out\s+of\s+100\b)"
_ABOUT = r"(?:(?:about|around|roughly|approximately|approx\.?|maybe|~)\s*)?"
_LABEL = (
    r"(?:(?:my\s+)?(?:confidence|certainty)(?:\s+(?:level|score|rating))?|rating|score|answer)"
)
_CONFIDENT = r"(?:confident|confidence|sure|certain|certainty)\b"

# 1. The whole reply is the number.
_BARE = re.compile(
    rf"(?:{_LABEL}\s*(?:is|=|:|-)?\s*)?{_N}(?:{_PERCENT}|{_OUT_OF_100})?\s*[.!]?",
    re.IGNORECASE,
)

# 2. A number tied to confidence wording.
_TIED = [
    # "I'm 85% confident", "85 percent sure", "with 85% confidence"
    re.compile(rf"{_N}{_PERCENT}\s*{_CONFIDENT}", re.IGNORECASE),
    # "My confidence is 85", "confidence level: 85%", "confidence of about 85/100"
    re.compile(
        rf"(?:confidence|certainty)(?:\s+(?:level|score|rating))?\s*(?:is|of|at|would\s+be|=|:|-)?\s*"
        rf"(?:at\s+)?{_ABOUT}{_N}",
        re.IGNORECASE,
    ),
    # "I'd say 85.", "I would rate it at 85%", "I'd put it at 85", "I'd give it a 90"
    re.compile(
        r"\bI(?:'d|’d|\s+would)?\s+(?:say|rate(?:\s+(?:it|this|that|myself|my\s+(?:answer|confidence)))?"
        r"(?:\s+(?:at|as))?|put\s+(?:it|my\s+confidence)\s+at|estimate(?:\s+it\s+at)?|"
        r"give\s+(?:it|myself|this|that)(?:\s+an?)?)\s*"
        rf"{_ABOUT}{_N}(?:{_PERCENT}|{_OUT_OF_100})?"
        r"(?=\s*(?:[.!,;)]|$)|\s+(?:on\s+a\s+scale|confidence|confident|sure|certain))",
        re.IGNORECASE,
    ),
    # "85 out of 100", "85/100"
    re.compile(rf"{_N}{_OUT_OF_100}", re.IGNORECASE),
]

# Any number written as a percentage or out of 100. If one of these differs
# from the confidence number, the reply is ambiguous.
_MARKED = re.compile(rf"{_N}(?:{_PERCENT}|{_OUT_OF_100})", re.IGNORECASE)

# Restating the scale ("on a scale from 0 to 100") isn't an answer.
_SCALE = re.compile(
    r"(?:on\s+a\s+scale\s+)?(?:(?:of|from)\s+)?\(?\b0\s*(?:to|-|–|—|and)\s*100\b\)?"
    r"|\bbetween\s+0\s+and\s+100\b",
    re.IGNORECASE,
)
# Two numbers joined as a range ("80-90", "80 to 90", "between 80 and 90").
_RANGE = re.compile(
    r"\b\d{1,3}\s*%?\s*(?:-|–|—|to)\s*\d{1,3}\b|\bbetween\s+\d{1,3}\s*%?\s+and\s+\d{1,3}\b",
    re.IGNORECASE,
)


def parse_confidence(reply: str | None) -> int | None:
    """The confidence (0 to 100) in `reply`, or None if it isn't clear."""
    if not reply:
        return None
    text = _tidy(reply)
    text = _tidy(_SCALE.sub(" ", text))
    if not text:
        return None

    bare = _BARE.fullmatch(text)
    if bare:
        return _in_range(bare.group("n"))

    if _RANGE.search(text):
        return None
    found = {int(match.group("n")) for pattern in _TIED for match in pattern.finditer(text)}
    if len(found) != 1:
        return None
    value = found.pop()
    if {int(match.group("n")) for match in _MARKED.finditer(text)} - {value}:
        return None
    return _in_range(str(value))


def _tidy(text: str) -> str:
    """Drop formatting (bold, quotes, brackets) and extra spaces."""
    text = re.sub(r"[*_`#]+", "", text)
    text = text.replace("−", "-")
    text = re.sub(r"[()\[\]]", " ", text)
    text = " ".join(text.split())
    return text.strip(" \"'“”‘’,;:")


def _in_range(digits: str) -> int | None:
    value = int(digits)
    return value if 0 <= value <= 100 else None
