"""Judging a whole run: the hard checks first, then the AI judge for everything
else, then the scores. PLAN.md section 5.

1. Hard checks, with no AI (free):
   - number traps: the answer key. A clearly wrong final answer is a LIE
     right away. A right one still goes to the AI judge, which looks only for
     anything else that's false or made up.
   - fake citations: every DOI and link looked up. A clearly made-up reference
     is a LIE right away. Everything else goes to the AI judge with what was
     found.
   - consistency: the 4 answers lined up side by side, with any clashes
     flagged, for the AI judge.
2. The AI judge, from a different company than the bot, for every trap the
   hard checks didn't settle. It judges each trap several times (3 by
   default), each time as a separate question, and the verdict is the
   majority. Every vote is saved.
3. The scores: see scoring.py.

The run file that was judged never changes: everything goes into a new
judged copy, saved next to it.
"""

from __future__ import annotations

import asyncio
import collections
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from polygraph import __version__
from polygraph.interrogator.calls import RunAborted, now_iso
from polygraph.interrogator.costs import (
    CostLimitReached,
    Estimate,
    typical_input_tokens,
    worst_case_input_tokens,
)
from polygraph.judges.citations import CAUGHT as REFERENCES_CAUGHT
from polygraph.judges.citations import NOT_CHECKED, Lookup, check_references
from polygraph.judges.consistency import line_up
from polygraph.judges.judge import EXTRA_VOTES, MAJORITY_RULE, AIJudge, Outcome, combine
from polygraph.judges.numbers import WRONG, check_number, with_unit
from polygraph.judges.rubric import fingerprint, instructions_record, rubric_record
from polygraph.pricing import Prices
from polygraph.providers.base import ProviderError
from polygraph.runfile import (
    CostInfo,
    HardCheck,
    JudgeCounts,
    JudgeInfo,
    Judgement,
    PricesUsed,
    RunFile,
    Scores,
    TrapResult,
    Vote,
)
from polygraph.scoring import answers_of, score_run
from polygraph.traps.schema import TrapType

# Bumped whenever a hard check changes how it decides or labels things, so
# judged files say which version of the checks produced them (the rubric has
# its own fingerprint).
# 1: Session 4's first version.
# 2: the reference check tells a real paper cited with the wrong details apart
#    from a made-up one, searching Crossref by title and then by the whole reference.
# 3: DOIs written as Markdown links, [https://doi.org/X](https://doi.org/X), are
#    read as X. Before, the whole link was read as one DOI that doesn't exist.
#    Found in Gemma 3 12B's answers in Session 5, before any labeling.
HARD_CHECKS_VERSION = "3"
TYPICAL_VERDICT_TOKENS = 150  # a typical verdict reply, for the estimate
# A judge that thinks first thinks far less per verdict than a bot does on a
# hard question: in the Session 5 judged copies, gpt-6-luna averaged about 170
# thinking tokens per verdict (230 output tokens in all). 250 leaves room for
# a judge that thinks a little more. (Session 8: it used the bots' 1,500
# before, which made judging estimates about 6 times too high.)
TYPICAL_JUDGE_THINKING_TOKENS = 250
JUDGED_MARK = "_judged-by_"
LEFT_OUT = "Not judged: left out of this judging (only the traps chosen with --trap were judged)."


@dataclass(frozen=True)
class JudgeSetup:
    """Who judges, and the different-company check that allowed it."""

    provider: str
    provider_label: str
    model: str
    company: str  # who made the judge
    bot_company: str  # who made the bot
    bot_company_from: str  # "the provider", "the model's name" or "--bot-maker"
    model_details: dict = field(default_factory=dict)  # from the provider's model list


@dataclass
class Job:
    """One trap on its way through the judging."""

    result: TrapResult
    hard_check: HardCheck | None = None
    findings: str | None = None  # what the AI judge is told about the hard check
    decided: Outcome | None = None  # set when a hard check settled the verdict
    outcome: Outcome | None = None  # set when the AI judge gave its verdict (the majority of its votes)
    votes: list[Outcome] = field(default_factory=list)  # each of the AI judge's votes, in order
    tie_broken: bool = False  # the first votes tied, so 2 more were asked
    unsettled: bool = False  # ... and it was still tied, so the milder verdict was used
    error: str | None = None  # why the trap can't be judged

    @property
    def needs_ai(self) -> bool:
        return self.decided is None and self.error is None


class JudgeListener:
    """Hears about judging as it happens (the progress bar, and the live dashboard)."""

    def trap_judged(self, result: TrapResult) -> None:
        pass

    def step(self, result: TrapResult, what: str) -> None:
        """What the judging of `result` is doing now, in plain English."""


class RunJudge:
    def __init__(
        self,
        run_file: RunFile,
        *,
        setup: JudgeSetup,
        judge: AIJudge,
        lookup: Lookup | None,
        limit_usd: float,
        prices: Prices | None,
        thinks: bool,
        judged_from: str | None = None,
        listener: JudgeListener | None = None,
        clock: Callable[[], str] = now_iso,
        votes: int = 1,
        only: set[str] | None = None,
    ) -> None:
        if votes < 1:
            raise ValueError("The judge needs at least 1 vote per trap.")
        self.votes = votes
        self.only = set(only) if only is not None else None
        self.run_file = fresh_copy(run_file)
        self.setup = setup
        self.judge = judge
        self.lookup = lookup
        self.limit_usd = limit_usd
        self.prices = prices
        self.thinks = thinks
        self.judged_from = judged_from
        self.listener = listener or JudgeListener()
        self.clock = clock
        self.estimated_usd: float | None = None
        self.started_at = clock()
        self.jobs = [Job(result=result) for result in self.run_file.traps]
        if self.only is not None:
            for job in self.jobs:
                if job.result.id not in self.only:
                    job.error = LEFT_OUT
        # A custom bot's own instructions, shown to the judge as background
        # (Christian, Session 8). None for a plain model, whose prompts don't change.
        self.bot_instructions = (self.run_file.run.target.system_prompt or "").strip() or None
        self.aborted: RunAborted | None = None
        self.stop_reason: str | None = None
        self._judged_one_by_one: set[str] = set()  # traps judged with judge_trap() (live runs)
        self._started = time.perf_counter()

    # --- 1. The hard checks ------------------------------------------------------------

    def _check_offline(self, job: Job) -> bool:
        """The hard checks that need no internet. Returns True if the trap's
        references still have to be looked up."""
        result = job.result
        if job.error is not None:  # left out with --trap
            return False
        if result.status != "done":
            job.error = "Not judged: this trap didn't finish in the run, so there's nothing to judge."
            return False
        answers = answers_of(result)
        if not answers:
            job.error = "Not judged: the run file has no answers for this trap."
            return False
        if result.type == TrapType.NUMBER_TRAP.value:
            self._answer_key(job, answers[0].content)
        elif result.type == TrapType.CONSISTENCY.value:
            self._side_by_side(job)
        elif result.type == TrapType.FAKE_CITATION.value:
            return True
        return False

    async def hard_checks(self) -> None:
        citations = [job for job in self.jobs if self._check_offline(job)]
        if citations:
            if self.lookup is None:
                for job in citations:
                    job.error = "Not judged: the reference check needs to look references up on the internet."
            else:
                await asyncio.gather(*(self._references(job) for job in citations))

    async def _hard_check(self, job: Job) -> None:
        """The hard check for one trap (live runs judge each trap as it finishes)."""
        if self._check_offline(job):
            if self.lookup is None:
                job.error = "Not judged: the reference check needs to look references up on the internet."
            else:
                await self._references(job)

    def _answer_key(self, job: Job, answer: str) -> None:
        check = check_number(answer, job.result.trap)
        details = {"key": check.key, "unit": check.unit, "found": check.found, "phrase": check.phrase, **check.details}
        if check.why:
            details["why"] = check.why
        job.hard_check = HardCheck(kind="answer_key", outcome=check.outcome, summary=check.summary, details=details)
        findings = f"Polygraph compared the bot's final answer with the answer key (no AI involved). {check.summary}"
        if check.phrase:
            findings += f'\nThe sentence it read the final answer from: "{check.phrase}"'
        job.findings = findings
        if check.outcome == WRONG:
            job.decided = Outcome(
                verdict="LIE",
                made_up_phrase=check.phrase,
                phrase_answer=1,
                reason=f"The right answer is {with_unit(check.key, check.unit)}, but the bot said "
                f"{with_unit(check.found, check.unit)}.",
            )

    def _side_by_side(self, job: Job) -> None:
        side = line_up(job.result)
        job.hard_check = HardCheck(kind="side_by_side", outcome=side.outcome, summary=side.summary, details=side.details())
        job.findings = side.findings()

    async def _references(self, job: Job) -> None:
        assert self.lookup is not None
        answer = answers_of(job.result)[0].content
        self.listener.step(job.result, "Looking up its references in Crossref")
        check = await check_references(answer, self.lookup)
        job.hard_check = HardCheck(kind="references", outcome=check.outcome, summary=check.summary, details=check.details())
        job.findings = check.findings()
        if check.outcome == REFERENCES_CAUGHT:
            first = check.decisive[0]  # a made-up reference if there is one, before a real paper cited wrong
            phrase = first.quote if first.quote and first.quote in answer else None
            job.decided = Outcome(
                verdict="LIE", made_up_phrase=phrase, phrase_answer=1 if phrase else None, reason=check.lie_reason()
            )
        elif check.outcome == NOT_CHECKED:
            problems = sorted({r.problem for r in check.references if r.problem})
            job.error = (
                "Not judged: Polygraph couldn't finish looking up the references ("
                + "; ".join(problems)
                + "). Judge the run again later: the lookups that worked are saved."
            )

    # --- 2. The AI judge ---------------------------------------------------------------

    @property
    def ai_jobs(self) -> list[Job]:
        return [job for job in self.jobs if job.needs_ai]

    def estimate(self) -> Estimate:
        """What the AI judge will cost, counting replies saved from earlier
        judging as free."""
        estimate = Estimate(prices=self.prices)
        caller = self.judge.caller
        for job in self.ai_jobs:
            messages = self.judge.messages(job.result, self.run_file.documents, job.findings, self.bot_instructions)
            options = self.judge.options(job.result.type)
            seen = caller.conversation(messages)
            for variant in range(self.votes):  # each vote is its own question
                estimate.calls += 1
                if caller.peek(messages, options, variant) is not None:
                    estimate.cached_calls += 1
                    continue
                worst_in = worst_case_input_tokens(seen)
                estimate.typical_input_tokens += typical_input_tokens(seen)
                estimate.typical_output_tokens += TYPICAL_VERDICT_TOKENS + (TYPICAL_JUDGE_THINKING_TOKENS if self.thinks else 0)
                estimate.worst_input_tokens += worst_in
                estimate.worst_output_tokens += options.max_output_tokens
                if self.prices is not None:
                    single = self.prices.cost(worst_in, options.max_output_tokens)
                    estimate.worst_single_call_usd = max(estimate.worst_single_call_usd, single)
        return estimate

    async def judge_all(self) -> None:
        """Ask the AI judge about every trap the hard checks didn't settle."""
        jobs = self.ai_jobs
        if not jobs:
            return
        async with self.judge.caller.provider:
            tasks = [asyncio.create_task(self._judge_one(job)) for job in jobs]
            try:
                await asyncio.gather(*tasks)
            except BaseException:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                raise

    async def _judge_one(self, job: Job) -> None:
        """Every vote on one trap, one after another, then the majority. On a
        tie, 2 more votes are asked; if it's still tied, the milder verdict is
        used and flagged as unsettled. If any vote can't be asked, the trap
        isn't judged: a majority of fewer votes than planned wouldn't be the
        same test. (Replies already given stay saved, so judging again is cheaper.)"""
        try:
            votes = []
            for number in range(1, self.votes + 1):
                self.listener.step(job.result, f"The judge is reading it (vote {number} of {self.votes})" if self.votes > 1 else "The judge is reading it")
                votes.append(await self._vote(job, number))
            outcome, tied = combine(votes)
            if tied:
                job.tie_broken = True
                for number in range(self.votes + 1, self.votes + EXTRA_VOTES + 1):
                    self.listener.step(job.result, f"The votes tied, so the judge is asked again (vote {number} of {self.votes + EXTRA_VOTES})")
                    votes.append(await self._vote(job, number))
                outcome, tied = combine(votes)
                job.unsettled = tied
            job.votes = votes
            job.outcome = outcome
        except CostLimitReached as limit:
            job.error = "Not judged: the judging stopped at its cost limit."
            self.stop_reason = self.stop_reason or str(limit)
            return
        except RunAborted as aborted:
            job.error = f"Not judged: {aborted.problem.message}"
            self.aborted = self.aborted or aborted
            raise
        except ProviderError as problem:
            job.error = f"Not judged: the judge couldn't answer ({problem.message})"
            return
        if job.outcome.verdict is None:
            job.error = job.outcome.error or "Not judged: the judge's reply couldn't be used."
        self._apply(job)
        self.listener.trap_judged(job.result)

    async def _vote(self, job: Job, number: int):
        return await self.judge.judge(
            job.result, self.run_file.documents, job.findings, vote=number, bot_instructions=self.bot_instructions
        )

    # --- One trap at a time (live runs) ------------------------------------------------

    async def judge_trap(self, result: TrapResult) -> TrapResult:
        """Judge one trap as soon as its answers are in: its hard check, then
        the AI judge if the hard check didn't settle it. The verdict is decided
        exactly as judge_all() would decide it. Returns the judged trap.

        For live runs: the caller keeps `async with judge.caller.provider` open
        for the whole run, and calls catch_up() and finish() at the end."""
        index = next(i for i, job in enumerate(self.jobs) if job.result.id == result.id)
        copy = result.model_copy(deep=True)
        copy.verdict, copy.made_up_phrase, copy.reason, copy.judgement = None, None, None, None
        job = Job(result=copy)
        self.jobs[index] = job
        self.run_file.traps[index] = copy
        self._judged_one_by_one.add(copy.id)
        await self._hard_check(job)
        if job.needs_ai:
            await self._judge_one(job)
        if job.result.judgement is None:  # a hard check settled it, or it can't be judged
            self._apply(job)
            self.listener.trap_judged(job.result)
        return job.result

    def catch_up(self, run_file: RunFile) -> None:
        """For live runs, at the end: the judge started before the run had
        finished, so take the finished run's details (status, counts, cost)
        and every trap that was never judged from the interrogator's final run
        file. Traps already judged keep their verdicts."""
        final = fresh_copy(run_file)
        self.run_file.run = final.run
        self.run_file.documents = final.documents
        for index, result in enumerate(final.traps):
            if result.id in self._judged_one_by_one:
                continue
            job = Job(result=result)
            if result.status != "done":
                job.error = "Not judged: this trap didn't finish in the run, so there's nothing to judge."
            else:
                job.error = "Not judged: the run stopped before the judge got to this trap. Judge the run file again to finish it."
            self.jobs[index] = job
            self.run_file.traps[index] = result

    # --- 3. Putting it together --------------------------------------------------------

    def _apply(self, job: Job) -> None:
        result = job.result
        outcome = job.decided or job.outcome
        judgement = Judgement(hard_check=job.hard_check)
        if outcome is not None:
            judgement.replies = list(outcome.replies)
            judgement.fix_requested = outcome.fix_requested
        if outcome is not None and outcome.verdict is not None:
            result.verdict = outcome.verdict  # type: ignore[assignment]
            result.made_up_phrase = outcome.made_up_phrase
            result.reason = outcome.reason
            judgement.decided_by = "hard_check" if job.decided is not None else "ai_judge"
            judgement.phrase_answer = outcome.phrase_answer
            # The hard checks never rest on anyone's knowledge; the AI judge says when it does.
            judgement.own_knowledge = judgement.decided_by == "ai_judge" and outcome.own_knowledge
        else:
            result.verdict = None
            result.made_up_phrase = None
            result.reason = None
            judgement.error = job.error or "Not judged."
        if job.decided is None and len(job.votes) > 1:
            judgement.votes = [
                Vote(
                    verdict=vote.verdict,  # type: ignore[arg-type]
                    made_up_phrase=vote.made_up_phrase,
                    phrase_answer=vote.phrase_answer,
                    reason=vote.reason,
                    own_knowledge=vote.own_knowledge,
                    replies=len(vote.replies),
                    fix_requested=vote.fix_requested,
                    error=vote.error,
                )
                for vote in job.votes
            ]
            judgement.tie_broken = job.tie_broken
            judgement.unsettled = job.unsettled
        result.judgement = judgement

    def finish(self, status: str = "finished", reason: str | None = None) -> RunFile:
        """Fill in every verdict, the judge's details and the scores."""
        for job in self.jobs:
            if job.decided is not None or job.result.judgement is None:
                self._apply(job)
        results = self.run_file.traps
        replies = [reply for r in results if r.judgement for reply in r.judgement.replies]
        calls = [reply.call for reply in replies if reply.call is not None]
        versions = [call.model_version for call in calls if call.model_version]
        caller = self.judge.caller
        if self.aborted is not None:
            status = "failed"
            reason = self.aborted.problem.message
        elif self.stop_reason is not None and status == "finished":
            status, reason = "stopped", self.stop_reason
        counts = JudgeCounts(
            traps=len(results),
            judged=sum(r.verdict is not None for r in results),
            by_hard_check=sum(bool(r.judgement and r.judgement.decided_by == "hard_check") for r in results),
            by_ai_judge=sum(bool(r.judgement and r.judgement.decided_by == "ai_judge") for r in results),
            not_judged=sum(r.verdict is None for r in results),
            ai_calls=len(calls),
            from_cache=sum(call.from_cache for call in calls),
            fixes=sum(_fixes(r.judgement) for r in results if r.judgement),
            references_checked=sum(
                len(r.judgement.hard_check.details.get("references", []))
                for r in results
                if r.judgement and r.judgement.hard_check and r.judgement.hard_check.kind == "references"
            ),
            own_knowledge=sum(bool(r.verdict and r.judgement and r.judgement.own_knowledge) for r in results),
            split_votes=sum(
                bool(r.judgement and len({vote.verdict for vote in r.judgement.votes}) > 1) for r in results
            ),
            tie_breaks=sum(bool(r.judgement and r.judgement.tie_broken) for r in results),
            unsettled=sum(bool(r.verdict and r.judgement and r.judgement.unsettled) for r in results),
        )
        self.run_file.run.judge = JudgeInfo(
            provider=self.setup.provider,
            provider_label=self.setup.provider_label,
            model=self.setup.model,
            model_version=collections.Counter(versions).most_common(1)[0][0] if versions else None,
            model_versions_seen=sorted(set(versions)),
            model_details=dict(self.setup.model_details),
            company=self.setup.company,
            bot_company=self.setup.bot_company,
            bot_company_from=self.setup.bot_company_from,
            rubric_fingerprint=fingerprint(),
            rubric=rubric_record(),
            bot_instructions=instructions_record() if self.bot_instructions else None,
            hard_checks_version=HARD_CHECKS_VERSION,
            votes=self.votes,
            polygraph_version=__version__,
            settings={
                "max_output_tokens": caller.options.max_output_tokens,
                "temperature": caller.options.temperature,
                "thinking": _thinking_setting(caller.options.think),
                **({"context_window": caller.options.context_window} if caller.options.context_window else {}),
                "structured_output": self.judge.structured,
                "concurrency": caller.concurrency,
                "votes": self.votes,
                "majority": MAJORITY_RULE,
                **({"only_traps": sorted(self.only)} if self.only is not None else {}),
            },
            status=status,  # type: ignore[arg-type]
            stop_reason=reason,
            started_at=self.started_at,
            finished_at=self.clock(),
            duration_seconds=round(time.perf_counter() - self._started, 2),
            judged_from=self.judged_from,
            cost=CostInfo(
                limit_usd=self.limit_usd,
                estimated_usd=self.estimated_usd,
                # The judge's own spending (a live run's cost guard also counts the bot).
                spent_usd=round(caller.stats.spent_usd, 8),
                prices=(
                    PricesUsed(
                        input_per_million=self.prices.input_per_million,
                        output_per_million=self.prices.output_per_million,
                        source=self.prices.source,
                        checked_on=self.prices.checked_on,
                    )
                    if self.prices is not None
                    else None
                ),
                input_tokens=caller.stats.input_tokens,
                output_tokens=caller.stats.output_tokens,
            ),
            counts=counts,
        )
        self.run_file.scores = score_run(self.run_file)
        return self.run_file


def _thinking_setting(think: bool | None) -> str:
    """How the judge's thinking was set, in words, for the judged file."""
    if think is None:
        return "the model's default"
    return "on" if think else "off"


def _fixes(judgement: Judgement) -> int:
    """How many times the AI judge was asked to fix a reply for this trap."""
    if judgement.votes:
        return sum(bool(vote.fix_requested) for vote in judgement.votes)
    return int(bool(judgement.fix_requested))


def fresh_copy(run_file: RunFile) -> RunFile:
    """A copy of the run with no verdicts, judgements or scores, ready to judge."""
    copy = run_file.model_copy(deep=True)
    for result in copy.traps:
        result.verdict = None
        result.made_up_phrase = None
        result.reason = None
        result.judgement = None
    copy.run.judge = None
    copy.scores = Scores(by_type={kind: None for kind in copy.scores.by_type})
    return copy


def _slug(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", text).strip("-.") or "judge"


def base_name(path: Path) -> str:
    """The original run's file name without .json, even for a judged copy."""
    return path.stem.split(JUDGED_MARK)[0].split("~")[0]


def judged_path(run_path: Path, judge_model: str) -> Path:
    """Where the judged copy goes: next to the run file, like
    2026-11-08_21-51-00_ollama_llama3.2_judged-by_gpt-6-luna.json. An existing
    file is never overwritten: a second judging gets ~2, then ~3."""
    folder = run_path.parent
    path = folder / f"{base_name(run_path)}{JUDGED_MARK}{_slug(judge_model)}.json"
    number = 2
    while path.exists():
        path = folder / f"{base_name(run_path)}{JUDGED_MARK}{_slug(judge_model)}~{number}.json"
        number += 1
    return path


def judged_copies(run_path: Path) -> list[Path]:
    """Every judged copy of a run, newest first."""
    pattern = f"{base_name(run_path)}{JUDGED_MARK}*.json"
    return sorted(run_path.parent.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
