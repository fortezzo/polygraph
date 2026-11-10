"""Pretend mode, for screenshots and tests only: a bot and a judge that replay
a recorded, judged run word for word instead of asking real models. Nothing
is asked over the internet, nothing costs anything, and nothing is saved in
runs/ or in the answer cache.

The bot streams each recorded answer at a steady pace, and the judge gives the
recorded verdicts, vote by vote, after a short pause. Their label says
"Pretend", so a pretend run can't be mistaken for a real one.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from polygraph.config import Settings
from polygraph.interrogator import CONFIDENCE_QUESTION
from polygraph.providers.base import STOP, ChatOptions, Message, ModelInfo, Provider, Reply, TextSink
from polygraph.runfile import RunFile

PRETEND_LABEL = "Pretend"  # the live screen adds "PRETEND: replaying a recorded run"


def recorded_library(run_file: RunFile, folder: Path) -> Path:
    """The traps the recorded run asked, written out as a trap folder, so a
    pretend run asks exactly those and every answer it replays is real. The
    library itself can grow after a run is recorded (Session 9 took it from 80
    traps to 200), and a pretend bot has no answer to a question it never saw."""
    from polygraph.traps.schema import TYPE_INFO, TrapType

    folder.mkdir(parents=True, exist_ok=True)
    by_type: dict[str, list[dict[str, Any]]] = {kind.value: [] for kind in TrapType}
    for result in run_file.traps:
        by_type.setdefault(result.type, []).append(result.trap)
    for kind, info in TYPE_INFO.items():
        data: dict[str, Any] = {"type": kind.value}
        if kind == TrapType.STICK_TO_DOCUMENT:
            data["documents"] = [
                {"id": doc_id, "title": doc.title, "fictional": True, "text": doc.text}
                for doc_id, doc in run_file.documents.items()
            ]
        data["traps"] = by_type[kind.value]
        text = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        (folder / info.file_name).write_text(text, encoding="utf-8")
    return folder


def _key(messages: list[Message] | list[tuple[str, str]]) -> str:
    pairs = [(m.role, m.content) if isinstance(m, Message) else m for m in messages]
    return json.dumps([pair for pair in pairs if pair[0] != "system"], ensure_ascii=False)


class ReplayBot(Provider):
    """Answers with the recorded bot's exact replies."""

    name = "pretend"
    label = PRETEND_LABEL
    local = True

    def __init__(self, run_file: RunFile, *, chars_per_step: int = 40, step_seconds: float = 0.05) -> None:
        self.run_file = run_file
        self.chars_per_step = chars_per_step
        self.step_seconds = step_seconds
        target = run_file.run.target
        self.model = target.model
        self.version = target.model_version
        self.details = dict(target.model_details)
        recorded_question = run_file.run.prompts.confidence_question
        self.replies: dict[str, str] = {}
        for result in run_file.traps:
            for chat in result.conversations:
                history: list[tuple[str, str]] = []
                for turn in chat.turns:
                    if turn.role == "user":
                        history.append(("user", turn.content))
                        continue
                    self.replies[_key(history)] = turn.content
                    if turn.confidence is not None and turn.confidence.reply is not None:
                        for wording in {recorded_question, CONFIDENCE_QUESTION}:
                            probe = [*history, ("assistant", turn.content), ("user", wording)]
                            self.replies[_key(probe)] = turn.confidence.reply
                    history.append(("assistant", turn.content))

    def _reply(self, messages: list[Message], model: str) -> Reply:
        text = self.replies.get(_key(messages), "I'm not sure.")
        return Reply(text=text, model=model, seconds=0.0, input_tokens=0, output_tokens=0, finish_reason=STOP, model_version=self.version)

    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        return self._reply(messages, model)

    async def chat_stream(
        self, messages: list[Message], model: str, options: ChatOptions | None = None, on_text: TextSink | None = None
    ) -> Reply:
        reply = self._reply(messages, model)
        for start in range(0, len(reply.text), self.chars_per_step):
            if self.step_seconds:
                await asyncio.sleep(self.step_seconds)
            if on_text is not None:
                on_text(reply.text[start : start + self.chars_per_step])
        return reply

    async def list_models(self) -> list[ModelInfo]:
        return [ModelInfo(name=self.model if ":" in self.model else f"{self.model}:latest", version=self.version, details=self.details)]

    async def describe_model(self, model: str) -> ModelInfo:
        return ModelInfo(name=model, version=self.version, details=self.details)


class ReplayJudge(Provider):
    """Gives the recorded judge's verdicts: vote 1, then 2, then 3 for each trap."""

    name = "pretend-judge"
    label = PRETEND_LABEL
    local = True

    def __init__(self, run_file: RunFile, *, seconds_per_vote: float = 0.4) -> None:
        self.seconds_per_vote = seconds_per_vote
        self.votes: dict[str, list[dict[str, Any]]] = {}
        for result in run_file.traps:
            judgement = result.judgement
            if judgement is not None and judgement.votes:
                self.votes[result.id] = [
                    {"verdict": v.verdict, "made_up_phrase": v.made_up_phrase, "reason": v.reason, "own_knowledge": v.own_knowledge}
                    for v in judgement.votes
                ]
            elif result.verdict is not None:
                self.votes[result.id] = [
                    {
                        "verdict": result.verdict,
                        "made_up_phrase": result.made_up_phrase,
                        "reason": result.reason,
                        "own_knowledge": bool(judgement and judgement.own_knowledge),
                    }
                ]
        self.asked: defaultdict[str, int] = defaultdict(int)

    async def chat(self, messages: list[Message], model: str, options: ChatOptions | None = None) -> Reply:
        if self.seconds_per_vote:
            await asyncio.sleep(self.seconds_per_vote)
        first = next((m.content for m in messages if m.role == "user"), "")
        found = re.match(r"TRAP ([a-z]+-\d+):", first)
        trap_id = found.group(1) if found else ""
        votes = self.votes.get(trap_id) or [{"verdict": "HONEST", "made_up_phrase": None, "reason": "No recorded verdict.", "own_knowledge": False}]
        if len([m for m in messages if m.role == "user"]) == 1:  # a fix request reuses the vote it fixes
            self.asked[trap_id] += 1
        vote = votes[(self.asked[trap_id] - 1) % len(votes)]
        return Reply(text=json.dumps(vote), model=model, seconds=0.0, input_tokens=0, output_tokens=0, finish_reason=STOP, model_version=model)

    async def describe_model(self, model: str) -> ModelInfo:
        return ModelInfo(name=model, details={"pretend": True})


def pretend_factory(run_file: RunFile, *, fast: bool = False):
    """Providers for pretend mode: the replayed bot for "ollama", the replayed
    judge for the three judge companies."""
    bot = ReplayBot(run_file, step_seconds=0.0 if fast else 0.05)
    judge = ReplayJudge(run_file, seconds_per_vote=0.0 if fast else 0.4)

    def factory(name: str, settings: Settings) -> Provider:
        return bot if name == "ollama" else judge

    return factory
