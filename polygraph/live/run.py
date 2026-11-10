"""A live run (Session 8): interrogate a bot one trap at a time, judge each
trap as soon as its answers are in, and record everything that happens as a
list of events the dashboard follows (and catches up on after a reload).

Each event has an `id` (counting from 1), a `type`, and `t`: seconds since
the run started. The types:
- run_started: the bot, the judge, the traps and the cost limit
- trap_started: a trap begins
- question: Polygraph sent the bot a message (the question, a push-back...)
- answer_chunk: the next few words of the answer the bot is writing
- answer_restart: a try failed partway, so the words so far don't count
- answer: the whole answer, from the bot or saved from an earlier run
- confidence: how sure the bot said it was, with its exact reply
- trap_answered: the trap's questions are done
- judging: what the judge is doing (looking up references, vote 2 of 3...)
- verdict: the trap's verdict, the made-up words and the judge's reason
- retrying: a service asked Polygraph to wait, so it waits and tries again
- error: a problem that stops the run, in plain English
- stopping: the Stop button was pressed
- run_finished: how it ended, the scores and the files

Everything is saved exactly as `polygraph run` and `polygraph judge` would
save it: the run file, then the judged copy next to it.
"""

from __future__ import annotations

import asyncio
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path
from typing import Any

from polygraph.config import Settings
from polygraph.interrogator import (
    CONFIDENCE_QUESTION,
    CallResult,
    CostGuard,
    Interrogator,
    ResponseCache,
    RetryPolicy,
    RunAborted,
    RunListener,
)
from polygraph.judges import AIJudge, JudgeListener, JudgeSetup, Lookup, ReferenceCache, RunJudge, judged_path
from polygraph.live.setup import Plan, PlanEstimate, bot_caller, judge_caller, problem_from
from polygraph.providers import ProviderError
from polygraph.runfile import RunFile, TrapResult, Turn, save_run
from polygraph.traps import StickToDocument, Trap

Exporter = Callable[[], Awaitable[bool]]

# What a retry is waiting for, in plain English, by the kind of problem.
WAITING_FOR = {
    "rate_limit": "{label} asked Polygraph to slow down.",
    "overloaded": "{label} is busy right now.",
    "timeout": "{label} took too long to answer.",
    "network": "The connection to {label} dropped.",
    "unreadable": "{label} sent back something Polygraph couldn't read.",
}


class _JudgeEvents(JudgeListener):
    def __init__(self, run: LiveRun) -> None:
        self.run = run

    def step(self, result: TrapResult, what: str) -> None:
        self.run.emit("judging", trap=result.id, step=what)


class LiveRun(RunListener):
    def __init__(
        self,
        plan: Plan,
        estimate: PlanEstimate,
        settings: Settings,
        *,
        runs_dir: Path,
        export: Exporter | None = None,
        chunk_seconds: float = 0.05,
        pretend: bool = False,
    ) -> None:
        self.id = secrets.token_hex(6)
        self.plan = plan
        self.estimate = estimate
        self.settings = settings
        self.runs_dir = runs_dir
        self.export = export
        self.chunk_seconds = chunk_seconds
        self.pretend = pretend  # replaying a recorded run (screenshots and tests), nothing real
        self.events: list[dict[str, Any]] = []
        self.state = "starting"  # then "running", then "done"
        self.guard = CostGuard(plan.choices.max_cost)
        self.interrogator: Interrogator | None = None
        self.judge: RunJudge | None = None
        self.run_path: Path | None = None
        self.judged_path: Path | None = None
        self.task: asyncio.Task | None = None
        self._run_task: asyncio.Task | None = None
        self._stop_by: str | None = None
        self._lookup: Lookup | None = None
        self._judge_ai: AIJudge | None = None
        self._wake = asyncio.Event()
        self._t0 = time.monotonic()
        self._text: list[str] = []
        self._text_where: tuple[str, int] | None = None
        self._flush: asyncio.TimerHandle | None = None

    # --- Following along --------------------------------------------------------------

    @property
    def done(self) -> bool:
        return self.state == "done"

    def emit(self, event_type: str, /, **data: Any) -> dict[str, Any]:
        clash = {"id", "type", "t"} & data.keys()
        if clash:
            raise ValueError(f"Event fields can't be called {', '.join(sorted(clash))}.")
        event = {"id": len(self.events) + 1, "type": event_type, "t": round(time.monotonic() - self._t0, 3), **data}
        self.events.append(event)
        self._wakeup()
        return event

    def _wakeup(self) -> None:
        self._wake.set()
        self._wake = asyncio.Event()

    async def follow(self, after: int = 0, keepalive: float = 15.0) -> AsyncIterator[dict[str, Any] | None]:
        """Every event after number `after`, then each new one as it happens,
        until the run is over. None now and then means nothing new happened
        (a chance to keep the connection open)."""
        index = max(0, after)
        while True:
            if index < len(self.events):
                index += 1
                yield self.events[index - 1]
                continue
            if self.done:
                return
            wake = self._wake
            try:
                await asyncio.wait_for(wake.wait(), keepalive)
            except TimeoutError:
                yield None

    def summary(self) -> dict[str, Any]:
        last = next((e for e in reversed(self.events) if e["type"] == "run_finished"), None)
        return {
            "id": self.id,
            "state": self.state,
            "events": len(self.events),
            "model": self.plan.bot.model,
            "name": self.plan.bot_name,
            "status": last["status"] if last else self.state,
        }

    # --- Running ----------------------------------------------------------------------

    def start(self) -> None:
        self.task = asyncio.create_task(self._main(), name=f"polygraph-live-{self.id}")

    def stop(self, by: str = "the Stop button") -> bool:
        """Stop right away. What's finished is saved and judged; the trap on
        its way is marked as not finished."""
        if self.done or self._stop_by is not None:
            return False
        self._stop_by = by
        if self.interrogator is not None:
            self.interrogator.stopped_by = by
        self.emit("stopping", by=by)
        if self._run_task is not None and not self._run_task.done():
            self._run_task.cancel()
        return True

    async def _main(self) -> None:
        plan = self.plan
        cache = ResponseCache(self.settings.cache_dir)
        references = ReferenceCache(self.settings.cache_dir)
        try:
            caller = bot_caller(plan, cache, self.guard, on_retry=self._retrying("bot", plan.bot.label))
            self._judge_ai = AIJudge(
                judge_caller(plan, cache, self.guard, on_retry=self._retrying("judge", plan.judge.label)),
                structured=plan.judge.provider_name == "openai",
            )
            self.interrogator = Interrogator(
                caller=caller,
                library=plan.library,
                traps=plan.traps,
                target=plan.target(),
                limit_usd=plan.choices.max_cost,
                prices=plan.bot.prices,
                thinks=plan.bot.thinks,
                concurrency=1,
                estimated_usd=self.estimate.typical_usd,
                listener=self,
                one_at_a_time=True,
                stream=True,
                after_trap=self._judge_trap,
                stopped_by=self._stop_by or "the Stop button",
            )
            self.state = "running"
            self.emit("run_started", **self._started_info())
            if self._stop_by is not None:  # stopped before it began
                self.emit("run_finished", **self._finished_info(None, None, False))
                return
            async with plan.judge.provider, Lookup(references, read_cache=True) as lookup:
                self._lookup = lookup
                self._run_task = asyncio.create_task(self.interrogator.run(save_folder=self.runs_dir))
                try:
                    await self._run_task
                except asyncio.CancelledError:
                    current = asyncio.current_task()
                    if self._stop_by is None or (current is not None and current.cancelling()):
                        raise
                self._send_text()
            await self._finish()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a bug: say so plainly, never hide it
            self.emit(
                "error",
                title="Something went wrong",
                message=f"Polygraph ran into an unexpected problem ({type(exc).__name__}: {exc}).",
                hint="What was finished has been saved. Try again; if it keeps happening, check the server's window.",
                kind="error",
            )
            run_file = self.interrogator.run_file if self.interrogator else None
            self.emit("run_finished", **self._finished_info(run_file, None, False))
        finally:
            if self._flush is not None:
                self._flush.cancel()
            cache.close()
            references.close()
            self.state = "done"
            self._wakeup()

    async def _judge_trap(self, trap: Trap, result: TrapResult) -> None:
        """Called after each trap's questions, before the next trap starts."""
        assert self.interrogator is not None and self._judge_ai is not None
        if self.judge is None:
            plan = self.plan
            self.judge = RunJudge(
                self.interrogator.run_file,  # type: ignore[arg-type]
                setup=JudgeSetup(
                    provider=plan.judge.provider_name,
                    provider_label=plan.judge.label,
                    model=plan.judge.model,
                    company=plan.judge.company,
                    bot_company=plan.bot.company,
                    bot_company_from=plan.bot_company_from,
                    model_details=plan.judge.details,
                ),
                judge=self._judge_ai,
                lookup=self._lookup,
                limit_usd=plan.choices.max_cost,
                prices=plan.judge.prices,
                thinks=plan.judge.thinks,
                listener=_JudgeEvents(self),
                votes=plan.votes,
            )
        if result.status == "done":
            self.emit("judging", trap=result.id, step="The judge is starting")
        try:
            judged = await self.judge.judge_trap(result)
        except RunAborted as aborted:
            # Like a judge whose key stopped working: the bot's answers can't be
            # judged, so asking it more questions would be pointless.
            problem = problem_from(aborted.problem, who="the judge")
            self.emit("error", **problem.as_dict())
            self.emit("verdict", trap=result.id, verdict=None, error=f"Not judged: {aborted.problem.message}", spent_usd=self._spent())
            self.interrogator.request_stop(f"The judge couldn't go on: {aborted.problem.message}")
            return
        if self.judge.stop_reason:
            self.interrogator.request_stop(self.judge.stop_reason)
        self.emit("verdict", **self._verdict_info(judged))

    async def _finish(self) -> None:
        assert self.interrogator is not None
        run_file = self.interrogator.run_file
        self.run_path = self.interrogator.saved_path
        if self.interrogator.aborted is not None:
            problem = problem_from(self.interrogator.aborted.problem)
            self.emit("error", **problem.as_dict())
        judged: RunFile | None = None
        if self.judge is not None and run_file is not None:
            self.judge.catch_up(run_file)
            self.judge.judged_from = self.run_path.name if self.run_path else None
            cancelled = run_file.run.status == "cancelled"
            judged = self.judge.finish(
                "cancelled" if cancelled else "finished",
                f"Judging stopped with the run ({self._stop_by})." if cancelled else None,
            )
            if self.run_path is not None:
                path = judged_path(self.run_path, self.plan.judge.model)
                save_run(judged, path.parent, path)
                self.judged_path = path
        exported = False
        if self.export is not None and self.judged_path is not None:
            try:
                exported = await self.export()
            except Exception:
                exported = False
        self.emit("run_finished", **self._finished_info(run_file, judged, exported))

    # --- What the interrogator tells us (RunListener) ----------------------------------

    def trap_started(self, trap: Trap) -> None:
        index = next(i for i, t in enumerate(self.plan.traps) if t.id == trap.id)
        document = None
        if isinstance(trap, StickToDocument):
            doc = self.plan.library.documents.get(trap.document)
            if doc is not None:
                document = {"id": trap.document, "title": doc.title, "text": doc.text}
        chats = 4 if trap.kind.value == "consistency" else 1
        self.emit(
            "trap_started",
            trap=trap.id,
            index=index,
            trap_type=trap.kind.value,
            label=trap.info.label,
            question=trap.question,
            chats=chats,
            document=document,
        )

    def question_asked(self, trap: Trap, chat: int, turn: Turn, wording: int | None) -> None:
        self._send_text()
        shown = turn.content
        if isinstance(trap, StickToDocument) and turn.kind == "question":
            shown = trap.question  # the document itself is shown as an exhibit
        self.emit("question", trap=trap.id, chat=chat, kind=turn.kind, text=shown, wording=wording)

    def answer_text(self, trap: Trap, chat: int, text: str) -> None:
        where = (trap.id, chat)
        if self._text_where != where:
            self._send_text()
            self._text_where = where
        self._text.append(text)
        if self._flush is None:
            self._flush = asyncio.get_running_loop().call_later(self.chunk_seconds, self._send_text)

    def answer_restarted(self, trap: Trap, chat: int) -> None:
        self._text, self._text_where = [], None
        if self._flush is not None:
            self._flush.cancel()
            self._flush = None
        self.emit("answer_restart", trap=trap.id, chat=chat)

    def answer_received(self, trap: Trap, chat: int, turn: Turn, result: CallResult) -> None:
        self._send_text()
        call = turn.call
        self.emit(
            "answer",
            trap=trap.id,
            chat=chat,
            text=turn.content,
            from_cache=result.from_cache,
            first_collected_at=result.first_collected_at,
            model_version=call.model_version if call else None,
            truncated=bool(call and call.truncated),
            seconds=call.seconds if call else None,
            spent_usd=self._spent(),
        )

    def confidence_received(self, trap: Trap, chat: int, answer: Turn) -> None:
        confidence = answer.confidence
        if confidence is None:
            return
        call = confidence.call
        self.emit(
            "confidence",
            trap=trap.id,
            chat=chat,
            value=confidence.value,
            reply=confidence.reply,
            error=confidence.error,
            from_cache=bool(call and call.from_cache),
            first_collected_at=call.first_collected_at if call else None,
        )

    def trap_finished(self, trap: Trap, result: TrapResult) -> None:
        self._send_text()
        self.emit(
            "trap_answered",
            trap=trap.id,
            status=result.status,
            error=result.error,
            seconds=result.seconds,
            spent_usd=self._spent(),
        )

    def _retrying(self, who: str, label: str) -> Callable[[ProviderError, int, float], None]:
        def tell(problem: ProviderError, attempt: int, wait: float) -> None:
            message = WAITING_FOR.get(problem.kind, "{label} had a problem: " + problem.message).format(label=label)
            self.emit(
                "retrying",
                who=who,
                kind=problem.kind,
                message=message,
                wait=round(wait, 1),
                attempt=attempt + 1,  # the try that comes next
                of=RetryPolicy().attempts,
            )

        return tell

    # --- Helpers ----------------------------------------------------------------------

    def _send_text(self) -> None:
        if self._flush is not None:
            self._flush.cancel()
            self._flush = None
        if self._text and self._text_where is not None:
            trap, chat = self._text_where
            self.emit("answer_chunk", trap=trap, chat=chat, text="".join(self._text))
        self._text = []

    def _spent(self) -> float:
        return round(self.guard.spent, 6)

    def _started_info(self) -> dict[str, Any]:
        plan = self.plan
        return {
            "run": self.id,
            "bot": {
                "provider": plan.bot.provider_name,
                "provider_label": plan.bot.label,
                "model": plan.bot.model,
                "maker": plan.bot.company,
                "local": plan.bot.provider.local,
                "name": plan.bot_name,
                "instructions": plan.instructions,
            },
            "judge": {
                "provider": plan.judge.provider_name,
                "provider_label": plan.judge.label,
                "model": plan.judge.model,
                "maker": plan.judge.company,
                "votes": plan.votes,
            },
            "traps": [
                {"trap": trap.id, "index": n, "trap_type": trap.kind.value, "label": trap.info.label}
                for n, trap in enumerate(plan.traps)
            ],
            "fresh": plan.fresh,
            "limit_usd": plan.choices.max_cost,
            "estimated_usd": round(self.estimate.typical_usd, 6),
            "confidence_question": CONFIDENCE_QUESTION,
            "pretend": self.pretend,
        }

    def _verdict_info(self, result: TrapResult) -> dict[str, Any]:
        judgement = result.judgement
        calls = [reply.call for reply in (judgement.replies if judgement else []) if reply.call is not None]
        source = result.trap.get("source") or {}
        return {
            "trap": result.id,
            "verdict": result.verdict,
            "made_up_phrase": result.made_up_phrase,
            "phrase_answer": judgement.phrase_answer if judgement else None,
            "reason": result.reason,
            "decided_by": judgement.decided_by if judgement else None,
            "votes": [vote.verdict for vote in judgement.votes] if judgement else [],
            "own_knowledge": bool(judgement and judgement.own_knowledge),
            "unsettled": bool(judgement and judgement.unsettled),
            "error": judgement.error if judgement else None,
            "hard_check": (
                {"kind": judgement.hard_check.kind, "outcome": judgement.hard_check.outcome, "summary": judgement.hard_check.summary}
                if judgement and judgement.hard_check
                else None
            ),
            "from_cache": bool(calls) and all(call.from_cache for call in calls),
            "first_collected_at": min((call.first_collected_at for call in calls), default=None),
            "truth": result.trap.get("truth"),
            "source": {"title": source.get("title"), "url": source.get("url")} if source else None,
            "spent_usd": self._spent(),
        }

    def _finished_info(self, run_file: RunFile | None, judged: RunFile | None, exported: bool) -> dict[str, Any]:
        run = run_file.run if run_file is not None else None
        info: dict[str, Any] = {
            "status": run.status if run else ("cancelled" if self._stop_by else "failed"),
            "stop_reason": run.stop_reason if run else (f"The run was stopped with {self._stop_by}." if self._stop_by else None),
            "run_id": run.id if run else None,
            "run_file": self.run_path.name if self.run_path else None,
            "judged_file": self.judged_path.name if self.judged_path else None,
            "exported": exported,
            "spent_usd": self._spent(),
            "duration_seconds": run.duration_seconds if run else None,
            "pretend": self.pretend,
            "scores": None,
            "judge_status": None,
            "judge_stop_reason": None,
        }
        if judged is not None and judged.run.judge is not None:
            info["judge_status"] = judged.run.judge.status
            info["judge_stop_reason"] = judged.run.judge.stop_reason
            scores = judged.scores
            info["scores"] = {
                "overall": scores.overall,
                "grade": scores.grade,
                "margin_of_error": scores.margin_of_error,
                "interval": scores.interval,
                "verdicts": dict(scores.verdicts),
                "by_type": dict(scores.by_type),
                "judged": judged.run.judge.counts.judged,
                "traps": len(judged.traps),
            }
        return info
