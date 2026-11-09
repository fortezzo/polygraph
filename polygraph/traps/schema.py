"""The trap format: the rulebook every trap has to pass before Polygraph uses it.

Every trap has the fields from PLAN.md section 4: id, type, question,
follow_ups, truth, honest_looks_like, caught_if, source and verified_on. Some
trap types need a field or two more, so each type has its own model below:

- ghost_fact: searches, the exact web searches that turned up nothing
- consistency: rewordings, so the question gets asked 4 different ways
- number_trap: answer_value (and answer_unit), the answer key
- stick_to_document: document (which document) and answerable (does it say?)

The rules are strict on purpose. A missing field, a misspelled field name or
the wrong kind of value makes a trap fail, instead of being quietly ignored and
turning into a broken test later.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated, ClassVar, Literal
from urllib.parse import urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationInfo,
    field_validator,
)


class TrapType(StrEnum):
    """The 8 trap types, in the order PLAN.md lists them."""

    GHOST_FACT = "ghost_fact"
    FALSE_PREMISE = "false_premise"
    FAKE_CITATION = "fake_citation"
    PRESSURE_TEST = "pressure_test"
    CONSISTENCY = "consistency"
    KNOW_YOUR_LIMITS = "know_your_limits"
    NUMBER_TRAP = "number_trap"
    STICK_TO_DOCUMENT = "stick_to_document"


@dataclass(frozen=True)
class TypeInfo:
    label: str  # the name people see, from PLAN.md
    file_name: str  # the type's file in traps/
    id_prefix: str  # every ID of this type starts with it, like ghost-001
    needs_link: bool  # the source has to include a web link


TYPE_INFO: dict[TrapType, TypeInfo] = {
    TrapType.GHOST_FACT: TypeInfo("Ghost facts", "ghost_facts.json", "ghost", needs_link=False),
    TrapType.FALSE_PREMISE: TypeInfo("False premise", "false_premises.json", "premise", needs_link=True),
    TrapType.FAKE_CITATION: TypeInfo("Fake citations", "fake_citations.json", "citation", needs_link=True),
    TrapType.PRESSURE_TEST: TypeInfo("Pressure test", "pressure_tests.json", "pressure", needs_link=True),
    TrapType.CONSISTENCY: TypeInfo("Consistency", "consistency.json", "consistency", needs_link=True),
    TrapType.KNOW_YOUR_LIMITS: TypeInfo(
        "Know your limits", "know_your_limits.json", "limits", needs_link=False
    ),
    TrapType.NUMBER_TRAP: TypeInfo("Number traps", "number_traps.json", "number", needs_link=True),
    TrapType.STICK_TO_DOCUMENT: TypeInfo(
        "Stick to the document", "stick_to_the_document.json", "document", needs_link=False
    ),
}

CONSISTENCY_WAYS = 4  # a consistency trap asks the same question this many ways

_PLACEHOLDER = re.compile(r"\b(TODO|TBD|FIXME|lorem ipsum)\b", re.IGNORECASE)


def normalized(text: str) -> str:
    """Lowercase with punctuation and extra spaces removed, for spotting repeats.
    'Is 1 a prime number?' and 'is 1 a  prime number' come out the same."""
    return " ".join(re.sub(r"[^\w\s]", " ", text.casefold()).split())


def _no_placeholder(value: str) -> str:
    if _PLACEHOLDER.search(value):
        raise ValueError("still has placeholder text in it (like TODO)")
    return value


def _web_link(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc or any(c.isspace() for c in value):
        raise ValueError("should be a full web address that starts with https://")
    return value


def _past_date(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("should be a date written like 2026-11-08")
    try:
        day = dt.date.fromisoformat(value)
    except ValueError:
        raise ValueError(f"'{value}' isn't a real date") from None
    if day > dt.date.today():
        raise ValueError(f"'{value}' is in the future")
    return value


# Text that can't be blank or a placeholder. Spaces at either end are ignored.
Text = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1), AfterValidator(_no_placeholder)
]
WebLink = Annotated[str, StringConstraints(strip_whitespace=True), AfterValidator(_web_link)]
CheckDate = Annotated[str, StringConstraints(strip_whitespace=True), AfterValidator(_past_date)]
DocumentId = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
]


class _Strict(BaseModel):
    # extra="forbid": a misspelled field name is an error, not silently ignored.
    # strict=True: no guessing, so the text "5" doesn't count as the number 5.
    model_config = ConfigDict(extra="forbid", strict=True, frozen=True)


class Source(_Strict):
    """Where the truth comes from."""

    title: Text
    url: WebLink | None = None
    note: Text | None = None


class Document(_Strict):
    """A short, made-up document that the stick-to-the-document traps ask about."""

    id: DocumentId
    title: Text
    fictional: Literal[True]  # every document has to be made up, never a real business
    text: Text


class TrapBase(_Strict):
    """The fields every trap has, from PLAN.md section 4."""

    kind: ClassVar[TrapType]

    id: str
    type: str
    question: Text
    follow_ups: list[Text]
    truth: Text
    honest_looks_like: Text
    caught_if: Text
    source: Source
    verified_on: CheckDate

    @field_validator("id")
    @classmethod
    def _check_id(cls, value: str) -> str:
        prefix = TYPE_INFO[cls.kind].id_prefix
        if not re.fullmatch(rf"{prefix}-\d{{3}}", value):
            raise ValueError(f"should look like {prefix}-001 ('{prefix}-' and then 3 digits)")
        return value

    @field_validator("source")
    @classmethod
    def _check_source(cls, value: Source) -> Source:
        if TYPE_INFO[cls.kind].needs_link and value.url is None:
            raise ValueError("needs a url: a link to a page that backs up the truth")
        return value

    @property
    def info(self) -> TypeInfo:
        return TYPE_INFO[self.kind]

    def wordings(self) -> list[str]:
        """Every wording of the question this trap asks."""
        return [self.question]


class GhostFact(TrapBase):
    """Asks about something that doesn't exist."""

    kind: ClassVar[TrapType] = TrapType.GHOST_FACT
    type: Literal["ghost_fact"]
    searches: list[Text]

    @field_validator("searches")
    @classmethod
    def _check_searches(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("needs at least one search: the exact web searches that found nothing")
        return value


class FalsePremise(TrapBase):
    """A question with a wrong assumption built in."""

    kind: ClassVar[TrapType] = TrapType.FALSE_PREMISE
    type: Literal["false_premise"]


class FakeCitation(TrapBase):
    """Asks for real studies, to see whether the bot invents references."""

    kind: ClassVar[TrapType] = TrapType.FAKE_CITATION
    type: Literal["fake_citation"]

    @field_validator("source")
    @classmethod
    def _check_doi(cls, value: Source) -> Source:
        if value.url is not None and not value.url.startswith("https://doi.org/10."):
            raise ValueError("url should be the real paper's DOI link, like https://doi.org/10.1000/...")
        return value


class PressureTest(TrapBase):
    """Gets a correct answer, then pushes back to see if the bot caves."""

    kind: ClassVar[TrapType] = TrapType.PRESSURE_TEST
    type: Literal["pressure_test"]

    @field_validator("follow_ups")
    @classmethod
    def _needs_push_back(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError(
                "needs at least one push-back, like \"Are you sure? I'm pretty sure it's Sydney.\""
            )
        return value


class Consistency(TrapBase):
    """Asks the same question 4 different ways, each in a fresh chat."""

    kind: ClassVar[TrapType] = TrapType.CONSISTENCY
    type: Literal["consistency"]
    rewordings: list[Text]

    @field_validator("follow_ups")
    @classmethod
    def _no_follow_ups(cls, value: list[str]) -> list[str]:
        if value:
            raise ValueError("should be empty: each wording is asked in its own fresh chat")
        return value

    @field_validator("rewordings")
    @classmethod
    def _four_different_ways(cls, value: list[str], info: ValidationInfo) -> list[str]:
        needed = CONSISTENCY_WAYS - 1
        if len(value) != needed:
            raise ValueError(
                f"needs exactly {needed} rewordings, so the question is asked "
                f"{CONSISTENCY_WAYS} ways (found {len(value)})"
            )
        seen = {}
        question = info.data.get("question")
        if question:
            seen[normalized(question)] = "the question"
        for number, wording in enumerate(value, start=1):
            key = normalized(wording)
            if key in seen:
                raise ValueError(f"rewording #{number} is the same as {seen[key]}")
            seen[key] = f"rewording #{number}"
        return value

    def wordings(self) -> list[str]:
        return [self.question, *self.rewordings]


class KnowYourLimits(TrapBase):
    """Asks something nobody could know."""

    kind: ClassVar[TrapType] = TrapType.KNOW_YOUR_LIMITS
    type: Literal["know_your_limits"]


class NumberTrap(TrapBase):
    """Trick math and logic, or an exact number. answer_value is the answer key."""

    kind: ClassVar[TrapType] = TrapType.NUMBER_TRAP
    type: Literal["number_trap"]
    answer_value: Annotated[float, Field(allow_inf_nan=False)]
    answer_unit: Text | None = None


class StickToDocument(TrapBase):
    """A question about one of the made-up documents in the same file."""

    kind: ClassVar[TrapType] = TrapType.STICK_TO_DOCUMENT
    type: Literal["stick_to_document"]
    document: DocumentId
    answerable: bool  # false means the honest answer is "the document doesn't say"


Trap = (
    GhostFact
    | FalsePremise
    | FakeCitation
    | PressureTest
    | Consistency
    | KnowYourLimits
    | NumberTrap
    | StickToDocument
)

MODELS: dict[TrapType, type[TrapBase]] = {
    TrapType.GHOST_FACT: GhostFact,
    TrapType.FALSE_PREMISE: FalsePremise,
    TrapType.FAKE_CITATION: FakeCitation,
    TrapType.PRESSURE_TEST: PressureTest,
    TrapType.CONSISTENCY: Consistency,
    TrapType.KNOW_YOUR_LIMITS: KnowYourLimits,
    TrapType.NUMBER_TRAP: NumberTrap,
    TrapType.STICK_TO_DOCUMENT: StickToDocument,
}
