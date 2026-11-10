"""polygraph run --reuse: take the answers from an earlier run file, word for word.

The answer cache keeps only the newest reply to each question, so asking again
(--fresh, or live mode's "ask every question again") replaces what an earlier
run got. In Session 8, a live test asked Llama 3.2 the 10 know-your-limits
traps again, so the cache no longer holds the Nov 8 answers that Christian's
hand labels were made on. To build a run on a specific earlier run, Polygraph
reads that run file and uses its replies first. Questions the earlier run never
asked (new traps) are asked as usual.

A reply is only reused when everything that shapes it is the same: the
provider, the model and its exact version, the settings, a custom bot's
instructions, the wording Polygraph adds (the confidence question and the
document template) and the conversation itself, word for word. Each reply
keeps the time it was first collected.
"""

from __future__ import annotations

from pathlib import Path

from polygraph.interrogator.cache import CachedReply
from polygraph.interrogator.calls import Caller
from polygraph.providers.base import Message, Reply
from polygraph.runfile import CallInfo, RunFile, Target


class ReuseError(Exception):
    """The earlier run can't be reused for this one, in plain English."""


def _same_text(a: str | None, b: str | None) -> bool:
    return (a or "").strip() == (b or "").strip()


def check_reusable(
    earlier: RunFile, target: Target, *, confidence_question: str, document_template: str
) -> list[str]:
    """Everything that would make the earlier run's answers wrong for this run.
    Empty when they can be reused."""
    old = earlier.run.target
    problems: list[str] = []
    if old.provider != target.provider or old.model != target.model:
        problems.append(f"it asked {old.model} via {old.provider_label}, not {target.model} via {target.provider_label}")
    if old.model_version and target.model_version and old.model_version != target.model_version:
        problems.append(
            f"it was answered by a different download of {target.model} ({old.model_version.rsplit(':', 1)[-1][:12]}, "
            f"not {target.model_version.rsplit(':', 1)[-1][:12]})"
        )
    for setting in ("max_output_tokens", "temperature"):
        if old.settings.get(setting) != target.settings.get(setting):
            problems.append(f"its {setting.replace('_', ' ')} was {old.settings.get(setting)}, not {target.settings.get(setting)}")
    if not _same_text(old.system_prompt, target.system_prompt):
        problems.append("its bot had different instructions (a different system prompt)")
    if earlier.run.prompts.confidence_question != confidence_question:
        problems.append("it asked a differently worded confidence question")
    if earlier.run.prompts.document_template != document_template:
        problems.append("it handed over documents with different wording")
    return problems


def _reply(text: str, call: CallInfo, model: str) -> Reply:
    return Reply(
        text=text,
        model=call.model or model,
        seconds=call.seconds or 0.0,
        input_tokens=call.input_tokens,
        output_tokens=call.output_tokens,
        reasoning_tokens=call.reasoning_tokens,
        finish_reason=call.finish_reason,
        model_version=call.model_version,
        thinking_level=call.thinking_level,
    )


def reusable_replies(earlier: RunFile, caller: Caller, *, confidence_question: str) -> dict[str, CachedReply]:
    """Every reply in the earlier run, by the key this run's caller would ask it
    under. Answers come with their confidence replies (asked in a side copy of
    the conversation, exactly as the interrogator does)."""
    model = earlier.run.target.model
    replies: dict[str, CachedReply] = {}
    for result in earlier.traps:
        for chat in result.conversations:
            history: list[Message] = []
            for turn in chat.turns:
                if turn.role == "user":
                    history.append(Message("user", turn.content))
                    continue
                if turn.call is None:
                    break  # an answer with no record of the call can't be reused safely
                replies[caller.key(list(history))] = CachedReply(
                    reply=_reply(turn.content, turn.call, model), first_collected_at=turn.call.first_collected_at
                )
                history.append(Message("assistant", turn.content))
                confidence = turn.confidence
                if confidence is not None and confidence.reply is not None and confidence.call is not None:
                    probe = [*history, Message("user", confidence_question)]
                    replies[caller.key(probe)] = CachedReply(
                        reply=_reply(confidence.reply, confidence.call, model),
                        first_collected_at=confidence.call.first_collected_at,
                    )
    return replies


def shown_name(path: Path) -> str:
    return Path(path).name
