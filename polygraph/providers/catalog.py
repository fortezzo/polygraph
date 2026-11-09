"""The models Polygraph knows prices for, from each company's official pricing page.

Model names and prices change, so this list was looked up (not remembered) on
the date in PRICES_CHECKED_ON, from the pages in SOURCES. Some prices are
already scheduled to change; those changes are listed too, and the right price
is picked by date. To see the models a company offers right now, straight from
its servers, run: polygraph models <provider>

A model that isn't on this list can still be tested. Polygraph just asks for
its price (--price-in and --price-out) instead of guessing, so the cost guard
always knows what it's guarding.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass
from typing import Literal

from polygraph.pricing import Prices

PRICES_CHECKED_ON = "2026-11-08"

SOURCES = {
    "openai": "https://developers.openai.com/api/docs/pricing",
    "anthropic": "https://platform.claude.com/docs/en/about-claude/pricing",
    "google": "https://aistudio.google.com/docs/pricing",
}

# The cheapest current choice from each company, used when you name a
# provider but not a model.
CHEAPEST = {
    "openai": "gpt-6-luna",
    "anthropic": "claude-haiku-5-5",
    "google": "gemini-2.5-flash-lite",
}

Status = Literal["current", "older", "preview", "deprecated"]


@dataclass(frozen=True)
class PriceChange:
    starts: str  # the first day the new price applies, like 2026-12-01
    input_per_million: float
    output_per_million: float


@dataclass(frozen=True)
class KnownModel:
    provider: str
    model: str  # the model ID the API expects
    input_per_million: float  # US dollars per million tokens sent to it
    output_per_million: float  # ... and per million tokens it writes (thinking included)
    reasoning: bool  # thinks before answering by default (hidden, but billed)
    status: Status = "current"
    note: str = ""
    later: tuple[PriceChange, ...] = ()  # scheduled price changes
    cache_write_premium: float = 0.0  # see Prices.cache_write_premium

    def prices(self, day: dt.date | None = None) -> Prices:
        day = day or dt.date.today()
        input_price, output_price = self.input_per_million, self.output_per_million
        for change in sorted(self.later, key=lambda c: c.starts):
            if day >= dt.date.fromisoformat(change.starts):
                input_price, output_price = change.input_per_million, change.output_per_million
        return Prices(
            input_price,
            output_price,
            source=SOURCES[self.provider],
            checked_on=PRICES_CHECKED_ON,
            cache_write_premium=self.cache_write_premium,
        )


# OpenAI's GPT-5.6 and later charge 1.25x the input price for tokens written
# to their prompt cache (it only starts once a prompt passes 1,024 tokens).
_OPENAI_CACHE = 0.25
_NO_THINKING_BY_DEFAULT = "Doesn't think before answering unless asked to."

KNOWN_MODELS: tuple[KnownModel, ...] = (
    # --- OpenAI -------------------------------------------------------------
    KnownModel("openai", "gpt-6-astra", 10.00, 50.00, True, note="Flagship.", cache_write_premium=_OPENAI_CACHE),
    KnownModel("openai", "gpt-6.1-sol", 2.00, 10.00, True, cache_write_premium=_OPENAI_CACHE),
    KnownModel("openai", "gpt-6.1-terra", 1.00, 5.00, True, cache_write_premium=_OPENAI_CACHE),
    KnownModel(
        "openai", "gpt-6-luna", 0.10, 0.50, True, note="Cheapest current model.", cache_write_premium=_OPENAI_CACHE
    ),
    KnownModel("openai", "gpt-6-sol", 2.00, 10.00, True, "older", cache_write_premium=_OPENAI_CACHE),
    KnownModel(
        "openai",
        "gpt-5.6-sol",
        4.00,
        20.00,
        True,
        "older",
        note=(
            "A promotional price that ends Nov 30, 2026. From Dec 1, Polygraph assumes $5 / $30, "
            "worked out from the stated discount. Check the pricing page."
        ),
        later=(PriceChange("2026-12-01", 5.00, 30.00),),
        cache_write_premium=_OPENAI_CACHE,
    ),
    KnownModel("openai", "gpt-5.6-terra", 2.00, 12.00, True, "older", cache_write_premium=_OPENAI_CACHE),
    KnownModel("openai", "gpt-5.6-luna", 0.20, 1.20, True, "older", cache_write_premium=_OPENAI_CACHE),
    KnownModel("openai", "gpt-5.5", 5.00, 30.00, True, "older", note="Snapshot gpt-5.5-2026-04-23."),
    KnownModel("openai", "gpt-5.5-pro", 30.00, 180.00, True, "older", note="Expensive."),
    KnownModel("openai", "gpt-5.4", 2.50, 15.00, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel("openai", "gpt-5.4-mini", 0.75, 4.50, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel("openai", "gpt-5.4-pro", 30.00, 180.00, True, "older", note="Expensive."),
    KnownModel("openai", "gpt-5.2", 1.75, 14.00, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel("openai", "gpt-5.4-nano", 0.20, 1.25, False, "deprecated", note="Shuts down Apr 1, 2027."),
    KnownModel("openai", "gpt-5.1", 1.25, 10.00, False, "deprecated", note="Shuts down Apr 1, 2027."),
    KnownModel("openai", "gpt-5", 1.25, 10.00, True, "deprecated", note="Shuts down Dec 11, 2026."),
    KnownModel("openai", "gpt-5-mini", 0.25, 2.00, True, "deprecated", note="Shuts down Dec 11, 2026."),
    KnownModel("openai", "gpt-5-nano", 0.05, 0.40, True, "deprecated", note="Shuts down Dec 11, 2026."),
    KnownModel("openai", "o3", 2.00, 8.00, True, "deprecated", note="Shuts down Dec 11, 2026."),
    KnownModel("openai", "gpt-4.1", 2.00, 8.00, False, "deprecated", note="Shuts down Jan 14, 2027."),
    KnownModel("openai", "gpt-4.1-mini", 0.40, 1.60, False, "deprecated", note="Shuts down Jan 14, 2027."),
    KnownModel("openai", "gpt-4o", 2.50, 10.00, False, "deprecated", note="Shuts down Jan 14, 2027."),
    KnownModel("openai", "gpt-4o-mini", 0.15, 0.60, False, "deprecated", note="Shuts down Jan 14, 2027."),
    # --- Anthropic ----------------------------------------------------------
    KnownModel("anthropic", "claude-fable-5-1", 10.00, 50.00, True, note="Flagship. Always thinks first."),
    KnownModel("anthropic", "claude-opus-5-5", 4.00, 20.00, True, note="Always thinks first."),
    KnownModel("anthropic", "claude-sonnet-5-5", 2.00, 10.00, True),
    KnownModel(
        "anthropic",
        "claude-haiku-5-5",
        0.10,
        0.50,
        True,
        note="Cheapest current model. Prompts over 100K tokens cost $0.50 / $2.50.",
    ),
    KnownModel("anthropic", "claude-fable-5", 10.00, 50.00, True, "older"),
    KnownModel("anthropic", "claude-opus-5", 5.00, 25.00, True, "older"),
    KnownModel("anthropic", "claude-sonnet-5", 2.00, 10.00, True, "older"),
    KnownModel("anthropic", "claude-opus-4-8", 5.00, 25.00, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel("anthropic", "claude-opus-4-7", 5.00, 25.00, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel("anthropic", "claude-opus-4-6", 5.00, 25.00, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel("anthropic", "claude-sonnet-4-6", 3.00, 15.00, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel("anthropic", "claude-haiku-4-5", 1.00, 5.00, False, "older", note=_NO_THINKING_BY_DEFAULT),
    KnownModel(
        "anthropic", "claude-opus-4-5", 5.00, 25.00, False, "older", note="Retires no sooner than Nov 24, 2026."
    ),
    KnownModel("anthropic", "claude-sonnet-4-5", 3.00, 15.00, False, "deprecated", note="Retires Nov 30, 2026."),
    # --- Google -------------------------------------------------------------
    KnownModel(
        "google",
        "gemini-4-argon",
        2.00,
        10.00,
        True,
        note="Flagship. Always thinks first. The price doubles on Dec 1, 2026.",
        later=(PriceChange("2026-12-01", 4.00, 20.00),),
    ),
    KnownModel(
        "google",
        "gemini-3.8-flash",
        0.75,
        3.75,
        True,
        note="The price doubles on Jan 1, 2027.",
        later=(PriceChange("2027-01-01", 1.50, 7.50),),
    ),
    KnownModel(
        "google",
        "gemini-3.6-flash",
        0.75,
        3.75,
        True,
        "older",
        note="The price doubles on Jan 1, 2027.",
        later=(PriceChange("2027-01-01", 1.50, 7.50),),
    ),
    KnownModel("google", "gemini-3.5-flash-lite", 0.30, 2.50, True, note="Thinks very little by default."),
    KnownModel("google", "gemini-3.1-flash-lite", 0.25, 1.50, True, "older", note="Shuts down May 7, 2027."),
    KnownModel("google", "gemini-3.1-pro-preview", 2.00, 12.00, True, "preview"),
    KnownModel("google", "gemini-3-flash-preview", 0.50, 3.00, True, "preview"),
    KnownModel(
        "google", "gemini-2.5-flash-lite", 0.10, 0.40, False, "older", note="Cheapest. " + _NO_THINKING_BY_DEFAULT
    ),
    KnownModel(
        "google",
        "gemini-2.5-flash",
        0.30,
        2.50,
        True,
        "deprecated",
        note="From Dec 1, 2026, Google answers with gemini-3.5-flash-lite instead.",
    ),
    KnownModel(
        "google",
        "gemini-2.5-pro",
        1.25,
        10.00,
        True,
        "deprecated",
        note="From Dec 1, 2026, Google answers with gemini-3.8-flash instead.",
    ),
)

_DATED_SNAPSHOT = re.compile(r"-(\d{4}-\d{2}-\d{2}|\d{8})$")


def find_known(provider: str, model: str | None) -> KnownModel | None:
    """The catalog entry for a model, also matching dated snapshot names like
    gpt-5.5-2026-04-23 or claude-opus-4-5-20251101, and Google's models/ prefix."""
    if not model:
        return None
    name = model.strip()
    if name.startswith("models/"):
        name = name.removeprefix("models/")
    for candidate in (name, _DATED_SNAPSHOT.sub("", name)):
        for known in KNOWN_MODELS:
            if known.provider == provider and known.model == candidate:
                return known
    return None


def models_for(provider: str) -> list[KnownModel]:
    return [known for known in KNOWN_MODELS if known.provider == provider]
