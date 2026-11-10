"""What `polygraph run` shows in the terminal: the plan, a live progress bar,
one line per finished trap, and a summary at the end."""

from __future__ import annotations

from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)
from rich.table import Table
from rich.text import Text

from polygraph.interrogator import CallResult, Estimate, RunListener
from polygraph.pricing import format_usd
from polygraph.providers.base import ProviderError
from polygraph.runfile import RunFile, TrapResult
from polygraph.traps import Trap

ICONS = {"done": ("✓", "green"), "error": ("✗", "red"), "stopped": ("■", "yellow"), "pending": ("…", "dim")}


def duration(seconds: float | None) -> str:
    """12.3s, 4m 12s or 1h 02m."""
    if seconds is None:
        return "unknown"
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, secs = divmod(round(seconds), 60)
    if minutes < 60:
        return f"{minutes}m {secs:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes:02d}m"


def one_line(text: str, limit: int = 160) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def confidence_text(result: TrapResult) -> str:
    """The confidence after each answer: 90 → 40 for a pressure test, ? when unknown."""
    values = []
    for chat in result.conversations:
        for turn in chat.turns:
            if turn.kind != "answer":
                continue
            if turn.confidence is None or (turn.confidence.reply is None and turn.confidence.value is None):
                values.append("–")
            elif turn.confidence.value is None:
                values.append("?")
            else:
                values.append(str(turn.confidence.value))
    if not values:
        return ""
    joiner = " · " if len(result.conversations) > 1 else " → "
    return "confidence " + joiner.join(values)


def trap_line(result: TrapResult) -> Text:
    icon, style = ICONS.get(result.status, ("?", ""))
    answers = [turn for chat in result.conversations for turn in chat.turns if turn.kind == "answer"]
    line = Text()
    line.append(f"{icon} ", style=style)
    line.append(f"{result.id:<16}", style="bold")
    line.append(f"{result.label:<22}", style="dim")
    if result.status == "done" or answers:
        line.append(f"{len(answers)} answer{'s' if len(answers) != 1 else ''}  ")
        line.append(confidence_text(result), style="cyan")
        calls = [t.call for t in answers if t.call] + [
            t.confidence.call for t in answers if t.confidence and t.confidence.call
        ]
        if calls and all(call.from_cache for call in calls):
            line.append("  (saved)", style="dim")
    if result.status != "done" and result.error:
        line.append(f"  {result.error}", style=style)
    elif answers:
        # Text() keeps the bot's words exactly as written: no formatting codes.
        line.append(f"  “{one_line(answers[0].content, 120)}”", style="dim")
    return line


class RunDisplay(RunListener):
    """The live progress bar, plus one line per finished trap."""

    def __init__(self, console: Console, total_traps: int, free: bool) -> None:
        self.console = console
        self.free = free
        self.answers = 0
        self.spent = 0.0
        self.progress = Progress(
            SpinnerColumn(),
            TextColumn("[bold]Interrogating"),
            BarColumn(),
            MofNCompleteColumn(),
            TextColumn("traps · {task.fields[answers]} answers · {task.fields[cost]}"),
            TextColumn("·"),
            TimeElapsedColumn(),
            TextColumn("· left"),
            TimeRemainingColumn(),
            console=console,
        )
        self.task = self.progress.add_task("run", total=total_traps, answers=0, cost=self._cost())

    def _cost(self) -> str:
        return "free" if self.free else format_usd(self.spent)

    def __enter__(self) -> RunDisplay:
        self.progress.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.progress.stop()

    def reply_received(self, trap: Trap, kind: str, result: CallResult) -> None:
        if kind == "answer":
            self.answers += 1
        self.spent += result.cost_usd
        self.progress.update(self.task, answers=self.answers, cost=self._cost())

    def retrying(self, problem: ProviderError, attempt: int, wait: float) -> None:
        self.progress.console.print(
            Text(f"  {problem.message} Trying again in {wait:.0f}s (try {attempt + 1}).", style="yellow")
        )

    def trap_finished(self, trap: Trap, result: TrapResult) -> None:
        self.progress.console.print(trap_line(result), no_wrap=True, overflow="ellipsis")
        self.progress.advance(self.task)


class JudgeDisplay:
    """The live progress bar while the AI judge works, plus one line per verdict."""

    def __init__(self, console: Console, total_traps: int, free: bool) -> None:
        self.console = console
        self.free = free
        self.spent = 0.0
        self.progress = Progress(
            SpinnerColumn(),
            TextColumn("[bold]Judging"),
            BarColumn(),
            MofNCompleteColumn(),
            TextColumn("traps · {task.fields[cost]}"),
            TextColumn("·"),
            TimeElapsedColumn(),
            TextColumn("· left"),
            TimeRemainingColumn(),
            console=console,
        )
        self.task = self.progress.add_task("judge", total=total_traps, cost=self._cost())

    def _cost(self) -> str:
        return "free" if self.free else format_usd(self.spent)

    def __enter__(self) -> JudgeDisplay:
        self.progress.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.progress.stop()

    def retrying(self, problem: ProviderError, attempt: int, wait: float) -> None:
        self.progress.console.print(
            Text(f"  {problem.message} Trying again in {wait:.0f}s (try {attempt + 1}).", style="yellow")
        )

    def step(self, result: TrapResult, what: str) -> None:
        """What the judging is doing now: the progress bar already shows enough."""

    def trap_judged(self, result: TrapResult) -> None:
        from polygraph.report import verdict_text  # here, to keep the imports one-way

        replies = result.judgement.replies if result.judgement else []
        self.spent += sum(reply.call.cost_usd for reply in replies if reply.call is not None)
        line = verdict_text(result.verdict)
        line.append(" " * max(1, 15 - len(line.plain)))  # "≠ CONTRADICTED" is the longest
        line.append(f"{result.id:<16}", style="bold")
        line.append(f"{result.label:<22}", style="dim")
        if result.made_up_phrase:
            line.append(f"“{one_line(result.made_up_phrase, 90)}”", style="italic")
        elif result.reason:
            line.append(one_line(result.reason, 110), style="dim")
        elif result.judgement and result.judgement.error:
            line.append(result.judgement.error, style="yellow")
        if replies and all(reply.call is not None and reply.call.from_cache for reply in replies):
            line.append("  (saved)", style="dim")
        self.progress.console.print(line, no_wrap=True, overflow="ellipsis")
        self.progress.update(self.task, cost=self._cost())
        self.progress.advance(self.task)


def plan_table(
    *,
    model: str,
    provider_label: str,
    local: bool,
    exact: str | None,
    details: dict,
    traps: int,
    traps_in_library: int,
    by_type: dict[str, int],
    fingerprint: str | None,
    estimate: Estimate,
    fresh: bool,
    limit: float,
    max_output_tokens: int,
    thinks: bool,
    at_once: int,
) -> Table:
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold")
    table.add_column()
    table.add_row("Bot", f"{model} via {provider_label}" + (", on this PC" if local else ""))
    if exact:
        parts = [exact.split("@sha256:")[0]]
        parts += [str(details[key]) for key in ("parameter_size", "quantization_level") if details.get(key)]
        if details.get("digest"):
            parts.append(f"fingerprint {str(details['digest'])[:12]}")
        table.add_row("Exact model", ", ".join(parts))
    else:
        table.add_row("Exact model", f"{provider_label} reports it with every answer, and the run file records it")
    traps_text = f"{traps} of the {traps_in_library} in the library" if traps != traps_in_library else f"all {traps}"
    if fingerprint:
        traps_text += f" (trap set {fingerprint})"
    table.add_row("Traps", traps_text)
    if traps != traps_in_library:
        table.add_row("", ", ".join(f"{count} {kind}" for kind, count in by_type.items() if count))
    answers = estimate.calls // 2
    table.add_row("Messages", f"{estimate.calls} to the bot: {answers} answers, each followed by a confidence question")
    if fresh:
        table.add_row("Saved answers", "ignored: every question is asked fresh (--fresh)")
    else:
        table.add_row("Saved answers", f"{estimate.cached_calls} of {estimate.calls} already saved from earlier runs")
    prices = estimate.prices
    if prices is not None and prices.free:
        table.add_row("Cost", "free: this model runs on your PC")
    elif prices is not None:
        checked = f", checked {prices.checked_on}" if prices.checked_on else ""
        table.add_row(
            "Cost",
            f"about {format_usd(estimate.typical_usd)} "
            f"(${prices.input_per_million:g} in / ${prices.output_per_million:g} out per million tokens{checked})",
        )
    table.add_row("Limit", f"${limit:.2f}. The run stops before it could go over.")
    length = f"{max_output_tokens:,} tokens per answer"
    if thinks:
        length += " (this model thinks before answering, so it gets room for that)"
    table.add_row("Answer length", length)
    table.add_row("At once", f"{at_once} questions at a time")
    return table


def summary_table(run_file: RunFile, saved_to: str | None) -> Table:
    run = run_file.run
    counts = run.counts
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold")
    table.add_column()
    table.add_row("Took", duration(run.duration_seconds))
    table.add_row(
        "Answers",
        f"{counts.answers} collected, each followed by a confidence question "
        f"({counts.confidence_ratings} clear numbers, {counts.confidence_unknown} unknown"
        + (f", {counts.confidence_missing} missing" if counts.confidence_missing else "")
        + ")",
    )
    table.add_row(
        "Replies",
        f"{counts.replies} in total: {counts.fresh} newly asked, {counts.from_cache} from saved answers",
    )
    free = run.cost.prices is not None and run.cost.prices.input_per_million == 0 and run.cost.prices.output_per_million == 0
    cost = "free: this model runs on your PC" if free else (
        f"{format_usd(run.cost.spent_usd)} (estimate was {format_usd(run.cost.estimated_usd)}, limit ${run.cost.limit_usd:.2f})"
    )
    table.add_row("Cost", cost)
    table.add_row(
        "Traps",
        f"{counts.traps_done} done, {counts.traps_with_errors} with errors, {counts.traps_stopped} not finished",
    )
    extras = []
    if counts.retries:
        extras.append(f"{counts.retries} retries")
    if counts.truncated_answers:
        extras.append(f"{counts.truncated_answers} answers hit the length limit")
    if extras:
        table.add_row("Notes", ", ".join(extras))
    if run.target.model_version:
        table.add_row("Exact model", run.target.model_version)
    if saved_to:
        table.add_row("Saved to", saved_to)
    return table
