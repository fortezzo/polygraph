"""Prices and money formatting, shared by the model list and the cost guard."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Prices:
    """What a model costs, in US dollars per million tokens."""

    input_per_million: float
    output_per_million: float
    source: str | None = None  # where the prices came from
    checked_on: str | None = None  # when they were looked up
    # Some providers charge extra for tokens they store in their own prompt
    # cache: 0.25 means those tokens cost 1.25 times the input price.
    cache_write_premium: float = 0.0

    @property
    def free(self) -> bool:
        return self.input_per_million == 0 and self.output_per_million == 0

    def cost(self, input_tokens: int, output_tokens: int, cache_write_tokens: int = 0) -> float:
        dollars_per_million = (
            input_tokens * self.input_per_million
            + output_tokens * self.output_per_million
            + cache_write_tokens * self.input_per_million * self.cache_write_premium
        )
        return dollars_per_million / 1_000_000


FREE = Prices(0.0, 0.0, source="runs on this PC, so it's free")


def format_usd(amount: float | None) -> str:
    """$0.00 style, with more digits for tiny amounts so they don't show as $0.00."""
    if amount is None:
        return "unknown"
    if amount == 0:
        return "$0.00"
    if amount < 0.01:
        return f"${amount:.4f}"
    return f"${amount:.2f}"
