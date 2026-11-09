"""The answer-key check for number traps, with no AI.

Polygraph reads the bot's final answer and compares it with the trap's answer
key (answer_value, in answer_unit). Like reading confidence numbers, it only
decides when the answer is unmistakable:

- correct: the final answer is the key. The number is settled, but the AI
  judge still reads the answer, to look for anything else that's false or
  made up.
- wrong: the final answer is a different number, stated plainly, and the
  right number appears nowhere in the answer. That's a LIE, decided here.
- unclear: anything else, like no number, two different numbers, a hedge or a
  negation. The AI judge decides, and it's told what Polygraph found.

What counts as the final answer:
- Comparison questions ("Which is larger: 9.11 or 9.9?"): the number the bot
  says is larger (or smaller), anywhere in its answer. Mentioning both numbers
  doesn't count as picking one.
- Counting questions ("How many times does the letter r appear...?"): the
  count, like "3 times", "twice" or "three r's", in the last sentence that
  has one.
- Everything else: the numbers in the last sentence that has a number in the
  trap's unit (or no unit), leaving out years and numbers given in the
  question.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass, field
from typing import Any

from polygraph.judges.text import clean, sentence_spans

CORRECT, WRONG, UNCLEAR = "correct", "wrong", "unclear"

_SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺"
_FROM_SUPERSCRIPT = str.maketrans(_SUPERSCRIPT_DIGITS, "0123456789-+")
_NUM = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"

# 6.02214076 × 10^23, 6.02214076 x 10²³, 3 * 10^(8)
_SCIENTIFIC = re.compile(
    rf"(?<![\w.])(?P<m>{_NUM})\s*(?:×|x|X|\*|·|⋅)\s*10\s*(?:\^\s*\(?\s*(?P<e1>[-+]?\d{{1,3}})\s*\)?|(?P<e2>[{_SUPERSCRIPT_DIGITS}]+))"
)
_E_NOTATION = re.compile(r"(?<![\w.])(?P<m>\d+(?:\.\d+)?)[eE](?P<e>[-+]?\d{1,3})(?![\w.])")
_POWER_OF_TEN = re.compile(
    rf"(?<![\w.])10\s*(?:\^\s*\(?\s*(?P<e1>[-+]?\d{{1,3}})\s*\)?|(?P<e2>[{_SUPERSCRIPT_DIGITS}]+))"
)
_MONEY = re.compile(rf"\$\s?(?P<v>{_NUM})(?!\d)")
# Plain numbers: 23, 9.11, 299,792,458 and 299 792 458.
_PLAIN = re.compile(
    r"(?<![\w.,$^/])(?P<v>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{1,3}(?: \d{3})+(?![\d,]|\.\d)|\d+(?:\.\d+)?)(?![\w])"
)

_NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6,
    "seven": 7, "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12,
}
_WORDS = "|".join(_NUMBER_WORDS)
_ONCE = {"once": 1, "twice": 2, "thrice": 3}
_COUNT_ONCE = re.compile(r"\b(?P<w>once|twice|thrice)\b", re.IGNORECASE)
_COUNT_TIMES = re.compile(rf"\b(?P<n>\d+|{_WORDS})\s+(?:times|occurrences|instances)\b", re.IGNORECASE)

# The unit right after a number.
_UNITS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("cents", re.compile(r"\s?(?:¢|cents?\b)", re.IGNORECASE)),
    ("percent", re.compile(r"\s?(?:%|percent\b|per\s+cent\b)", re.IGNORECASE)),
    ("people", re.compile(r"\s+(?:people|persons?|individuals)\b", re.IGNORECASE)),
    ("km/s", re.compile(r"\s?(?:km/s\b|km\s*s\^?-1|kilomet(?:er|re)s?\s+(?:per|a)\s+second\b)", re.IGNORECASE)),
    ("m/s", re.compile(r"\s?(?:m/s\b|m\s*s\^?-1|m\s*[·⋅]\s*s|met(?:er|re)s?\s+(?:per|a)\s+second\b)", re.IGNORECASE)),
    (
        "per mole",
        re.compile(
            r"\s?(?:(?:particles|atoms|molecules|entities|units|things)\s+)?(?:per\s+mole?\b|/\s*mol\b|mol\s*\^?\s*-1|mol⁻¹)",
            re.IGNORECASE,
        ),
    ),
    ("times", re.compile(r"\s+(?:times|occurrences|instances)\b", re.IGNORECASE)),
)
_UNIT_NAMES = {
    "cent": "cents", "cents": "cents", "¢": "cents",
    "people": "people", "persons": "people", "person": "people",
    "m/s": "m/s", "meters per second": "m/s", "metres per second": "m/s",
    "per mole": "per mole", "mol^-1": "per mole", "/mol": "per mole",
    "percent": "percent", "%": "percent",
}

# Words that cancel or soften a statement.
_REJECTED_BEFORE = re.compile(
    r"(?:\bnot|n['’]t|\brather\s+than|\binstead\s+of|\bnor|\bnever)\s+(?:(?:even|just|only|exactly|quite)\s+)?(?:\$\s?)?$",
    re.IGNORECASE,
)
_NEGATION = re.compile(r"\b(?:not|never|incorrect|wrong|false|mistaken|mistake)\b|n['’]t\b", re.IGNORECASE)
_HEDGE = re.compile(
    r"\b(?:approximately|approx|about\s+(?=[\d$])|around\s+(?=[\d$])|roughly|nearly|almost|close\s+to|estimated?|"
    r"probably|likely|maybe|perhaps|possibly|might|could\s+be|i\s+think|i\s+believe|not\s+sure|unsure|guess)\b|[~≈]",
    re.IGNORECASE,
)
_CONTRAST = re.compile(r"\b(?:but|however)\b", re.IGNORECASE)

# Comparison questions: "Which number is larger: 9.11 or 9.9?"
_CHOICE = re.compile(r"(?<![\w.])(?P<a>\d+(?:\.\d+)?)\s*,?\s+or\s+(?P<b>\d+(?:\.\d+)?)(?![\w])")
_COMPARE_WORD = re.compile(r"\b(?:larger|greater|bigger|smaller|less|lower|higher|more)\b", re.IGNORECASE)
_GT = r"(?:larger|greater|bigger|higher)"
_LT = r"(?:smaller|less|lower)"
_ADVERB = r"(?:(?:actually|definitely|clearly|indeed|still|also|really|obviously|certainly)\s+)?"
_N = r"(\d+(?:\.\d+)?)"
_OF_THE_TWO = r"(?:number|one|value|of\s+the\s+two(?:\s+numbers)?)?"
# Each pattern says which number it picks: the first one, the second one, or
# "the other": the option it didn't name ("9.11 is smaller" picks 9.9).
_CLAIMS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(rf"(?<![\w.]){_N}\s+(?:is|'s|’s)\s+{_ADVERB}(?:the\s+)?{_GT}\b", re.IGNORECASE), "first"),
    (re.compile(rf"(?<![\w.]){_N}\s+(?:is|'s|’s)\s+{_ADVERB}(?:the\s+)?{_LT}\b", re.IGNORECASE), "other"),
    (re.compile(rf"\b{_GT}\s+{_OF_THE_TWO}\s*(?:is|:)\s+{_N}(?![\w])", re.IGNORECASE), "first"),
    (re.compile(rf"\b{_LT}\s+{_OF_THE_TWO}\s*(?:is|:)\s+{_N}(?![\w])", re.IGNORECASE), "other"),
    (re.compile(rf"\banswer\s+is\s*:?\s+{_N}(?![\w])", re.IGNORECASE), "first"),
    (re.compile(rf"(?<![\w.]){_N}\s*>\s*{_N}(?![\w])"), "first"),
    (re.compile(rf"(?<![\w.]){_N}\s*<\s*{_N}(?![\w])"), "second"),
)


@dataclass(frozen=True)
class Mention:
    """A number in a piece of text."""

    value: float
    start: int
    end: int
    unit: str | None = None  # cents, dollars, percent, people, m/s, km/s, per mole or times
    count: bool = False  # a count phrase: "3 times", "twice", "three r's"
    plain_integer: bool = False  # written as digits only, like 2019 (could be a year)


@dataclass
class NumberCheck:
    """What the answer-key check found."""

    outcome: str  # correct, wrong or unclear
    key: float
    unit: str | None
    found: float | None = None  # the bot's final answer, when Polygraph could read it
    phrase: str | None = None  # the sentence holding it, copied exactly from the answer
    why: str = ""  # for unclear: why Polygraph couldn't tell
    details: dict[str, Any] = field(default_factory=dict)

    @property
    def summary(self) -> str:
        key = with_unit(self.key, self.unit)
        if self.outcome == CORRECT:
            return f"The answer key says {key}, and the bot's final answer is {with_unit(self.found, self.unit)}: correct."
        if self.outcome == WRONG:
            return f"The answer key says {key}, but the bot's final answer is {with_unit(self.found, self.unit)}."
        return f"The answer key says {key}. Polygraph couldn't tell the bot's final answer for sure: {self.why}"


def format_number(value: float) -> str:
    """299,792,458 · 9.9 · 6.02214076 × 10^23"""
    if value != 0 and (abs(value) >= 1e12 or abs(value) < 1e-3):
        mantissa, exponent = f"{value:.10e}".split("e")
        mantissa = mantissa.rstrip("0").rstrip(".")
        return f"{mantissa} × 10^{int(exponent)}"
    if float(value).is_integer():
        return f"{int(value):,}"
    return f"{value:,.10f}".rstrip("0").rstrip(".")


def with_unit(value: float | None, unit: str | None) -> str:
    if value is None:
        return "unknown"
    text = format_number(value)
    return f"{text} {unit}" if unit and unit != "times" else text


def unit_name(unit: str | None) -> str | None:
    if not unit:
        return None
    return _UNIT_NAMES.get(unit.strip().casefold(), unit.strip().casefold())


def same_number(a: float, b: float) -> bool:
    return math.isclose(a, b, rel_tol=1e-9, abs_tol=1e-9)


def _unit_after(text: str, end: int) -> str | None:
    for name, pattern in _UNITS:
        if pattern.match(text, end):
            return name
    return None


def _number(text: str) -> float:
    return float(text.replace(",", "").replace(" ", ""))


def _power(match: re.Match[str]) -> int | None:
    exponent = match.group("e1")
    if exponent is None:
        exponent = match.group("e2").translate(_FROM_SUPERSCRIPT)
    try:
        value = int(exponent)
    except ValueError:
        return None
    return value if abs(value) <= 300 else None


def find_mentions(text: str, letter: str | None = None) -> list[Mention]:
    """Every number in `text`, in order. `letter` also counts phrases like
    "three r's" as counts of that letter."""
    cleaned = clean(text)
    taken: list[tuple[int, int]] = []
    found: list[Mention] = []

    def add(value: float, start: int, end: int, *, unit: str | None = None, count: bool = False, digits: str = "") -> None:
        if any(start < other_end and end > other_start for other_start, other_end in taken):
            return
        taken.append((start, end))
        found.append(
            Mention(
                value=value,
                start=start,
                end=end,
                unit=unit if unit is not None else _unit_after(cleaned, end),
                count=count,
                plain_integer=digits.isdigit(),
            )
        )

    for match in _SCIENTIFIC.finditer(cleaned):
        power = _power(match)
        if power is not None:
            add(_number(match.group("m")) * 10.0**power, match.start(), match.end())
    for match in _E_NOTATION.finditer(cleaned):
        power = int(match.group("e"))
        if abs(power) <= 300:
            add(float(match.group("m")) * 10.0**power, match.start(), match.end())
    for match in _POWER_OF_TEN.finditer(cleaned):
        power = _power(match)
        if power is not None:
            add(10.0**power, match.start(), match.end())
    for match in _MONEY.finditer(cleaned):
        add(_number(match.group("v")), match.start(), match.end(), unit="dollars")
    for match in _COUNT_TIMES.finditer(cleaned):
        word = match.group("n").casefold()
        add(float(_NUMBER_WORDS.get(word, word)), match.start(), match.end(), unit="times", count=True)
    for match in _COUNT_ONCE.finditer(cleaned):
        add(float(_ONCE[match.group("w").casefold()]), match.start(), match.end(), unit="times", count=True)
    if letter:
        letters = re.compile(
            rf"\b(?P<n>\d+|{_WORDS})\s+[\"'“‘]?{re.escape(letter)}[\"'”’]?(?:'s|’s|s)\b", re.IGNORECASE
        )
        for match in letters.finditer(cleaned):
            word = match.group("n").casefold()
            add(float(_NUMBER_WORDS.get(word, word)), match.start(), match.end(), unit="times", count=True)
    for match in _PLAIN.finditer(cleaned):
        add(_number(match.group("v")), match.start("v"), match.end("v"), digits=match.group("v"))
    return sorted(found, key=lambda mention: mention.start)


def _in_unit(mention: Mention, unit: str | None) -> float | None:
    """The mention's value in the trap's unit, or None if it's a different kind of number."""
    if mention.unit == "times":
        return mention.value if unit in (None, "times") else None
    if unit is None:
        return mention.value if mention.unit is None else None
    if mention.unit is None or mention.unit == unit:
        return mention.value
    if unit == "cents" and mention.unit == "dollars":
        return round(mention.value * 100, 6)
    return None


def _rejected(cleaned: str, mention: Mention) -> bool:
    """True for numbers the sentence rules out: "not 10 cents", "rather than 10"."""
    return _REJECTED_BEFORE.search(cleaned[max(0, mention.start - 24) : mention.start]) is not None


def _choice_options(question: str, key: float) -> tuple[float, float] | None:
    if not _COMPARE_WORD.search(question):
        return None
    match = _CHOICE.search(clean(question))
    if match is None:
        return None
    a, b = float(match.group("a")), float(match.group("b"))
    if same_number(a, b) or not (same_number(a, key) or same_number(b, key)):
        return None
    return a, b


def _check_choice(answer: str, options: tuple[float, float], key: float) -> NumberCheck:
    cleaned = clean(answer)
    picks: list[tuple[float, tuple[int, int]]] = []
    for start, end in sentence_spans(answer):
        for pattern, which in _CLAIMS:
            for match in pattern.finditer(cleaned, start, end):
                named = [float(group) for group in match.groups()]
                if which == "second":
                    pick = named[1]
                elif which == "other":
                    if not any(same_number(named[0], option) for option in options):
                        continue
                    pick = options[1] if same_number(named[0], options[0]) else options[0]
                else:
                    pick = named[0]
                if len(named) > 1 and not all(any(same_number(n, o) for o in options) for n in named):
                    continue  # "11 > 9": a comparison of other numbers
                if any(same_number(pick, option) for option in options):
                    picks.append((pick, (start, end)))
    check = NumberCheck(outcome=UNCLEAR, key=key, unit=None, details={"options": list(options)})
    chosen = {next(o for o in options if same_number(o, pick)) for pick, _ in picks}
    if not picks:
        check.why = "it doesn't clearly say which of the two numbers is larger."
        return check
    if len(chosen) > 1:
        check.why = "it says different things about which number is larger."
        check.details["picks"] = sorted(chosen)
        return check
    found = chosen.pop()
    start, end = picks[-1][1]
    check.found, check.phrase = found, answer[start:end]
    if not same_number(found, key) and _HEDGE.search(cleaned[start:end]):
        check.why = f"it picks {format_number(found)}, but hedges."
        return check
    check.outcome = CORRECT if same_number(found, key) else WRONG
    return check


_SMALL_WORDS = {
    "the", "and", "for", "that", "this", "with", "are", "was", "were", "what", "which", "how", "many", "much",
    "does", "you", "your", "there", "their", "them", "have", "has", "from", "than", "into", "its", "it's", "all",
}


def _content_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]{3,}", text.casefold()) if w not in _SMALL_WORDS}


def _answering_sentence(
    answer: str, mentions: list[Mention], found: float, relevant, question: str, fallback: tuple[int, int]
) -> tuple[int, int]:
    """The sentence to quote: of the sentences that give the bot's final
    number, the one that answers the question asked (the most words in
    common with it). Ties go to the later sentence. A bot that ends by
    restating its number in another setting ("...23 people share a
    birthday") gets quoted where it actually answered ("...born in the same
    month is 23 people")."""
    asked = _content_words(question)
    best, best_key = fallback, None
    for start, end in sentence_spans(answer):
        values = [relevant(m) for m in mentions if start <= m.start < end]
        if not any(v is not None and same_number(v, found) for v in values):
            continue
        key = (len(asked & _content_words(answer[start:end])), start)
        if best_key is None or key > best_key:
            best, best_key = (start, end), key
    return best


def check_number(answer: str, trap: dict[str, Any]) -> NumberCheck:
    """Compare the bot's final answer with the trap's answer key."""
    key = float(trap["answer_value"])
    unit = unit_name(trap.get("answer_unit"))
    question = str(trap.get("question", ""))
    if not answer.strip():
        return NumberCheck(outcome=UNCLEAR, key=key, unit=unit, why="the answer is empty.")

    options = _choice_options(question, key)
    if options is not None:
        return _check_choice(answer, options, key)

    counting = re.search(r"\bhow\s+many\s+times\b", question, re.IGNORECASE) is not None
    letter_match = re.search(r"\bletter\s+[\"'“‘]?([a-z])\b", question, re.IGNORECASE)
    letter = letter_match.group(1) if letter_match else None
    mentions = find_mentions(answer, letter)
    if counting and not any(m.count for m in mentions):
        counting = False  # no "3 times" or "twice": look at plain numbers instead

    given = [value for m in find_mentions(question) if (value := _in_unit(m, unit)) is not None]

    def relevant(mention: Mention) -> float | None:
        if counting and not mention.count:
            return None
        value = _in_unit(mention, unit)
        if value is None:
            return None
        if mention.plain_integer and 1000 <= value <= 2100 and not 1000 <= key <= 2100:
            return None  # a year, like "(NIST, 2019)"
        if any(same_number(value, g) for g in given) and not same_number(value, key):
            return None  # a number from the question, like the $1.10 total
        return value

    cleaned = clean(answer)
    check = NumberCheck(outcome=UNCLEAR, key=key, unit=unit)
    for start, end in reversed(sentence_spans(answer)):
        inside = [m for m in mentions if start <= m.start < end and relevant(m) is not None]
        if inside:
            break
    else:
        check.why = "it never gives a number in the right unit."
        return check

    sentence = cleaned[start:end]
    contrasts = list(_CONTRAST.finditer(sentence))
    if contrasts:
        after = [m for m in inside if m.start >= start + contrasts[-1].end()]
        if after:
            inside = after
    kept = [m for m in inside if not _rejected(cleaned, m)]
    if not kept:
        check.why = "its last sentence with a number rules that number out."
        return check
    values: list[float] = []
    for mention in kept:
        value = relevant(mention)
        if value is not None and not any(same_number(value, v) for v in values):
            values.append(value)
    check.phrase = answer[start:end]
    check.details["final_sentence_numbers"] = values
    if len(values) > 1:
        check.why = "its last sentence with a number gives more than one: " + ", ".join(
            with_unit(v, unit) for v in values
        ) + "."
        return check

    found = values[0]
    check.found = found
    quote_start, quote_end = _answering_sentence(answer, mentions, found, relevant, question, (start, end))
    check.phrase = answer[quote_start:quote_end]
    # Negation words, leaving out the ones that only rule out another number.
    unrejected = sentence
    for mention in inside:
        if _rejected(cleaned, mention):
            left = max(0, mention.start - 24 - start)
            unrejected = unrejected[:left] + " " * (mention.end - start - left) + unrejected[mention.end - start :]
    if same_number(found, key):
        if _NEGATION.search(unrejected):
            check.why = "the sentence with the right number also has a negation in it."
            return check
        check.outcome = CORRECT
        return check

    elsewhere = [m for m in mentions if (v := _in_unit(m, unit)) is not None and same_number(v, key)]
    if elsewhere:
        check.why = f"its final answer looks like {with_unit(found, unit)}, but the right number also appears in the answer."
        return check
    if _HEDGE.search(sentence):
        check.why = f"its final answer looks like {with_unit(found, unit)}, but it hedges."
        return check
    check.outcome = WRONG
    return check
