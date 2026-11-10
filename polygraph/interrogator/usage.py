"""polygraph run --estimate-from: estimate a run's cost from an earlier run's
real token use, instead of Polygraph's typical numbers.

The typical numbers assume a model that thinks a lot on every question (1,500
thinking tokens an answer), so they run high on purpose. Once a similar model
has answered the same traps, its real token counts make a much closer guess:
in Session 9, gpt-6.1-terra's estimate was $3.71 and it really cost $0.46.

The estimate prices each trap's real input and output tokens, as the earlier
run recorded them, at the new model's prices. Every trap in this run has to be
in the earlier run too. The cost guard still sets aside the most each question
could cost, so a run never goes past its limit, whatever the estimate said.
"""

from __future__ import annotations

from dataclasses import dataclass

from polygraph.pricing import Prices
from polygraph.runfile import RunFile


class UsageError(Exception):
    """The earlier run can't be used for the estimate, in plain English."""


@dataclass(frozen=True)
class UsageEstimate:
    usd: float
    input_tokens: int
    output_tokens: int
    replies: int
    based_on: str  # the earlier run's model


def estimate_from(earlier: RunFile, trap_ids: list[str], prices: Prices, *, trap_set: str | None) -> UsageEstimate:
    """The cost of asking `trap_ids` again, at `prices`, if the new model uses
    as many tokens as the earlier run did on the same traps."""
    if trap_set is not None and earlier.run.trap_set.version != trap_set:
        raise UsageError(
            f"it asked a different version of the trap library ({earlier.run.trap_set.version}, not {trap_set})"
        )
    by_id = {result.id: result for result in earlier.traps}
    missing = [trap_id for trap_id in trap_ids if trap_id not in by_id or by_id[trap_id].status != "done"]
    if missing:
        raise UsageError(f"it has no finished answers for {len(missing)} of these traps (like {missing[0]})")
    input_tokens = output_tokens = replies = 0
    for trap_id in trap_ids:
        for chat in by_id[trap_id].conversations:
            for turn in chat.turns:
                calls = [turn.call, turn.confidence.call if turn.confidence is not None else None]
                for call in calls:
                    if call is None or call.input_tokens is None or call.output_tokens is None:
                        continue
                    input_tokens += call.input_tokens
                    output_tokens += call.output_tokens
                    replies += 1
    if replies == 0:
        raise UsageError("it has no token counts to go on")
    return UsageEstimate(
        usd=prices.cost(input_tokens, output_tokens),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        replies=replies,
        based_on=earlier.run.target.model,
    )
