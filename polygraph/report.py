"""The report card in the terminal (`polygraph report` and `polygraph judge`).

It looks like a case file: who was interrogated and who judged it, the Truth
Score with its margin of error, the grade, a bar for each trap type, the
overconfidence meter, the most confident lies and a one-line verdict. Every
verdict has an icon and a label as well as a color (PLAN.md section 8: never
rely on color alone).
"""

from __future__ import annotations

import datetime as dt
import random

from rich import box
from rich.console import Group, RenderableType
from rich.padding import Padding
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from polygraph.judges.judge import EXTRA_VOTES
from polygraph.judges.numbers import format_number
from polygraph.pricing import format_usd
from polygraph.runfile import RunFile, TrapResult
from polygraph.scoring import CAUGHT, CONFIDENT, answers_of, shown_score
from polygraph.traps.schema import TrapType

MANILA = "#c8a45c"  # the case-file folder
VERDICT_STYLE = {
    "HONEST": ("✓", "green"),
    "LIE": ("✗", "red"),
    "CAVED": ("↓", "#ffaf00"),  # amber
    "CONTRADICTED": ("≠", "magenta"),
    "DODGED": ("~", "#5fafff"),
}
GRADE_STYLE = {"A": "bold green", "B": "bold green", "C": "bold yellow", "D": "bold #ff8700", "F": "bold red"}
BAR_WIDTH = 20


def when(stamp: str | None) -> str:
    """Nov 8, 2026, 9:51 PM"""
    if not stamp:
        return "unknown"
    try:
        moment = dt.datetime.fromisoformat(stamp)
    except ValueError:
        return stamp
    hour = moment.hour % 12 or 12
    return f"{moment:%b} {moment.day}, {moment.year}, {hour}:{moment:%M} {'AM' if moment.hour < 12 else 'PM'}"


def verdict_text(verdict: str | None) -> Text:
    if verdict is None:
        return Text("… NOT JUDGED", style="dim")
    icon, style = VERDICT_STYLE[verdict]
    return Text(f"{icon} {verdict}", style=f"bold {style}")


def score_style(score: float | None) -> str:
    if score is None:
        return "dim"
    if score >= 80:
        return "green"
    if score >= 60:
        return "yellow"
    return "red"


def bar(score: float | None) -> Text:
    if score is None:
        return Text("·" * BAR_WIDTH, style="dim")
    filled = round(score / 100 * BAR_WIDTH)
    text = Text("█" * filled, style=score_style(score))
    text.append("░" * (BAR_WIDTH - filled), style="dim")
    return text


def _pm(value: float | None) -> str:
    return "" if value is None else f"± {shown_score(value)}"


def _subject(run_file: RunFile) -> str:
    target = run_file.run.target
    parts = [target.model]
    details = target.model_details or {}
    parts += [str(details[key]) for key in ("parameter_size", "quantization_level") if details.get(key)]
    text = " · ".join(parts) + f" · via {target.provider_label}"
    if run_file.run.judge is not None:
        text += f" · made by {run_file.run.judge.bot_company}"
    return text


def _judge_line(run_file: RunFile) -> str:
    judge = run_file.run.judge
    if judge is None:
        return "not judged yet"
    model = judge.model
    if judge.model_version and judge.model_version != judge.model:
        model += f" ({judge.model_version})"
    return f"{model} · {judge.provider_label} · rubric {judge.rubric_fingerprint}"


def _header(run_file: RunFile) -> Table:
    run, scores = run_file.run, run_file.scores
    table = Table.grid(padding=(0, 2))
    table.add_column(style=f"bold {MANILA}", no_wrap=True)
    table.add_column()
    table.add_row("SUBJECT", Text(_subject(run_file)))
    table.add_row("JUDGE", Text(_judge_line(run_file)))
    dates = f"interrogated {when(run.started_at)}"
    if run.judge is not None:
        dates += f" · judged {when(run.judge.finished_at or run.judge.started_at)}"
    table.add_row("DATE", dates)
    traps = f"{len(run_file.traps)} traps · trap set {run.trap_set.version}"
    if scores.traps_not_scored:
        traps += f" · {scores.traps_scored} scored, {scores.traps_not_scored} not judged"
    table.add_row("TRAPS", traps)
    return table


def _headline(run_file: RunFile) -> Table:
    scores = run_file.scores
    shown = shown_score(scores.overall)
    truth = Text(justify="center")
    truth.append("TRUTH SCORE\n", style=f"bold {MANILA}")
    truth.append(f"{shown if shown is not None else '–'}", style=f"bold {score_style(scores.overall)}")
    truth.append(" / 100", style="dim")
    if scores.margin_of_error is not None:
        truth.append(f"\n{_pm(scores.margin_of_error)}", style="bold")
        if scores.interval:
            low, high = (shown_score(v) for v in scores.interval)
            truth.append(f"  (95% range {low}–{high})", style="dim")
    grade = Text(justify="center")
    grade.append("GRADE\n", style=f"bold {MANILA}")
    grade.append(scores.grade or "–", style=GRADE_STYLE.get(scores.grade or "", "bold"))
    row = Table.grid(padding=(0, 3))
    row.add_column(justify="center")
    row.add_column(justify="center")
    row.add_row(
        Panel(truth, box=box.ROUNDED, border_style=MANILA, padding=(0, 3)),
        Panel(grade, box=box.HEAVY, border_style=GRADE_STYLE.get(scores.grade or "", "white").replace("bold ", ""), padding=(0, 3)),
    )
    return row


def _types(run_file: RunFile) -> Table:
    table = Table(box=box.SIMPLE_HEAD, pad_edge=False, header_style=f"bold {MANILA}", expand=False)
    table.add_column("TRAP TYPE", no_wrap=True)
    table.add_column("SCORE", justify="right", no_wrap=True)
    table.add_column("", no_wrap=True)
    table.add_column("VERDICTS", no_wrap=True)
    for entry in run_file.scores.types.values():
        shown = shown_score(entry.score)
        score = Text(f"{shown if shown is not None else '–':>3}", style=f"bold {score_style(entry.score)}")
        margin_text = _pm(entry.margin_of_error)
        score.append(f" {margin_text:<4}" if margin_text else "     ", style="dim")
        counts = Text()
        for verdict, (icon, style) in VERDICT_STYLE.items():
            count = entry.verdicts.get(verdict, 0)
            if count:
                counts.append(f"{icon}{count} ", style=style)
        if not entry.traps:
            counts.append("not judged", style="dim")
        table.add_row(entry.label, score, bar(entry.score), counts)
    return table


def _totals(run_file: RunFile) -> Text:
    line = Text()
    for verdict, (icon, style) in VERDICT_STYLE.items():
        count = run_file.scores.verdicts.get(verdict, 0)
        line.append(f"{icon} {verdict} {count}", style=f"bold {style}" if count else "dim")
        line.append("   ")
    return line


def _meter(run_file: RunFile) -> RenderableType | None:
    calibration = run_file.scores.calibration
    if calibration is None or not calibration.rated:
        return None
    lines: list[RenderableType] = [Text("OVERCONFIDENCE METER", style=f"bold {MANILA}")]
    said = Text()
    if calibration.mean_confidence_caught is not None:
        said.append("When it was caught, it said it was ")
        said.append(f"{shown_score(calibration.mean_confidence_caught)}% sure", style="bold red")
        said.append(" on average")
        if calibration.mean_confidence_honest is not None:
            said.append(f". When it was honest: {shown_score(calibration.mean_confidence_honest)}%")
        said.append(".")
        lines.append(said)
    if calibration.overconfidence is not None and calibration.mean_confidence is not None:
        gap = shown_score(calibration.overconfidence)
        overall = Text(
            f"Overall it claimed {shown_score(calibration.mean_confidence)}% confidence and was honest "
            f"{shown_score(calibration.honest_rate)}% of the time: "
        )
        if gap is not None and gap > 0:
            overall.append(f"overconfident by {gap} points.", style="bold red")
        elif gap is not None and gap < 0:
            overall.append(f"underconfident by {-gap} points.", style="bold yellow")
        else:
            overall.append("well calibrated.", style="bold green")
        lines.append(overall)
    if calibration.confident_and_caught:
        lines.append(Text(f"It was caught {calibration.confident_and_caught} times while saying it was at least {CONFIDENT}% sure."))

    bands = Table(box=None, pad_edge=False, padding=(0, 2), show_header=True, header_style="dim")
    bands.add_column("Said it was")
    bands.add_column("Traps", justify="right")
    bands.add_column("Honest", justify="right")
    for bucket in calibration.buckets:
        honest = "–" if bucket.honest_rate is None else f"{shown_score(bucket.honest_rate)}%"
        bands.add_row(f"{bucket.low}–{bucket.high}% sure", str(bucket.answers), honest)
    lines.append(bands)
    lines.append(Text("These are the bot's own claims, asked after each answer, not measurements.", style="dim"))
    if calibration.suspect:
        why = []
        if calibration.suspect_zero:
            why.append(f"it said 0 (\"sure I'm wrong\") right after answering {_times(calibration.suspect_zero)}")
        if calibration.suspect_echo:
            why.append(f"repeated a number from its own answer {_times(calibration.suspect_echo)}")
        note = f"{calibration.suspect} of the {calibration.rated} readings look misread: " + " and ".join(why) + "."
        clean = calibration.without_suspect
        if clean is not None and clean.rated and clean.mean_confidence_caught is not None:
            note += (
                f" Leaving those out, it said it was {shown_score(clean.mean_confidence_caught)}% sure on average "
                "when caught"
            )
            if clean.mean_confidence_honest is not None:
                note += f" and {shown_score(clean.mean_confidence_honest)}% when honest"
            note += "."
        lines.append(Text(note, style="dim"))
    if calibration.unknown:
        lines.append(Text(f"{calibration.unknown} confidence replies weren't a clear number, so they're left out.", style="dim"))
    return Group(*lines)


def _times(count: int) -> str:
    return "once" if count == 1 else ("twice" if count == 2 else f"{count} times")


def _top_lies(run_file: RunFile) -> RenderableType | None:
    calibration = run_file.scores.calibration
    if calibration is None or not calibration.most_confident_lies:
        return None
    by_id = {r.id: r for r in run_file.traps}
    grid = Table.grid(padding=(0, 2))
    grid.add_column(no_wrap=True, justify="right")
    grid.add_column()
    for lie in calibration.most_confident_lies:
        head = Text()
        head.append_text(verdict_text(lie.verdict))
        head.append(f"  {lie.trap}", style="bold")
        head.append(f" · {lie.label}", style="dim")
        body: list[RenderableType] = [head]
        if lie.made_up_phrase:
            body.append(Text(f"“{_one_line(lie.made_up_phrase, 150)}”", style="italic"))
        reason = by_id[lie.trap].reason if lie.trap in by_id else None
        if reason:
            body.append(Text(reason, style="dim"))
        if lie.trap in by_id and own_knowledge(by_id[lie.trap]):
            body.append(Text(OWN_KNOWLEDGE_NOTE, style=OWN_KNOWLEDGE_STYLE))
        if lie.trap in by_id and unsettled(by_id[lie.trap]):
            body.append(Text(UNSETTLED_NOTE, style=OWN_KNOWLEDGE_STYLE))
        grid.add_row(Text(f"{format_number(lie.confidence)}% sure", style="bold red"), Group(*body))
    return Group(Text("MOST CONFIDENT LIES", style=f"bold {MANILA}"), grid)


def verdict_line(run_file: RunFile) -> Text:
    """The case file's one-line verdict, from the numbers (no AI)."""
    scores = run_file.scores
    caught = sum(scores.verdicts.get(v, 0) for v in CAUGHT)
    ranked = sorted(
        ((entry.score, entry.label) for entry in scores.types.values() if entry.score is not None),
        key=lambda item: (item[0], item[1]),
    )
    text = Text()
    text.append("VERDICT  ", style=f"bold {MANILA}")
    if not scores.traps_scored:
        text.append("Nothing could be judged.")
        return text
    text.append(f"Caught on {caught} of {scores.traps_scored} traps.")
    if len(ranked) >= 3:
        (s1, w1), (s2, w2) = ranked[0], ranked[1]
        best_score, best = ranked[-1]
        text.append(f" Weakest at {w1} ({shown_score(s1)}) and {w2} ({shown_score(s2)}).")
        text.append(f" Strongest at {best} ({shown_score(best_score)}).")
    lies = scores.calibration.most_confident_lies if scores.calibration else []
    if lies:
        text.append(f" Most confident lie: {format_number(lies[0].confidence)}% sure.")
    return text


def _footer(run_file: RunFile) -> Text:
    judge = run_file.run.judge
    if judge is None:
        return Text("")
    counts = judge.counts
    text = Text(style="dim")
    text.append(
        f"Judged: {counts.by_hard_check} trap{'s' if counts.by_hard_check != 1 else ''} by Polygraph's own checks "
        f"(no AI), {counts.by_ai_judge} by the AI judge"
    )
    if judge.votes > 1:
        text.append(f", {judge.votes} votes each, the majority wins ({counts.split_votes} not unanimous")
        if counts.unsettled:
            text.append(f", {counts.unsettled} still tied and marked {UNSETTLED_MARK}")
        text.append(")")
    if counts.own_knowledge:
        text.append(
            f"; {counts.own_knowledge} of its verdicts rest{'s' if counts.own_knowledge == 1 else ''} on its own "
            f"knowledge, marked {OWN_KNOWLEDGE_MARK} in --verdicts"
        )
    if counts.not_judged:
        text.append(f", {counts.not_judged} not judged")
    spent = judge.cost.spent_usd
    text.append(f" · judging cost {format_usd(spent)}")
    if counts.ai_calls and counts.from_cache == counts.ai_calls:
        text.append(" (every reply was saved from an earlier judging")
        prices = judge.cost.prices
        calls = [
            reply.call
            for result in run_file.traps
            if result.judgement
            for reply in result.judgement.replies
            if reply.call is not None
        ]
        if prices is not None and calls:
            first_time = sum(
                ((c.input_tokens or 0) * prices.input_per_million + (c.output_tokens or 0) * prices.output_per_million)
                / 1_000_000
                for c in calls
            )
            text.append(f", which cost about {format_usd(first_time)}")
        text.append(")")
    if judge.status != "finished":
        text.append(f" · judging {judge.status}: {judge.stop_reason}", style="yellow")
    return text


def report_card(run_file: RunFile, width: int | None = None) -> Panel:
    parts: list[RenderableType] = [_header(run_file), Text(""), _headline(run_file), _types(run_file), _totals(run_file)]
    meter = _meter(run_file)
    if meter is not None:
        parts += [Text(""), meter]
    lies = _top_lies(run_file)
    if lies is not None:
        parts += [Text(""), lies]
    parts += [Text(""), verdict_line(run_file), _footer(run_file)]
    return Panel(
        Group(*parts),
        title=Text(" POLYGRAPH · CASE FILE ", style=f"bold {MANILA}"),
        title_align="left",
        subtitle=Text(f" {run_file.run.id} ", style="dim"),
        subtitle_align="right",
        box=box.DOUBLE,
        border_style=MANILA,
        padding=(1, 2),
        width=width,
    )


# --- Listing verdicts ----------------------------------------------------------------------


def _one_line(text: str, limit: int) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _confidence(result: TrapResult) -> str:
    values = []
    for turn in answers_of(result):
        if turn.confidence is None or turn.confidence.value is None:
            values.append("?")
        else:
            values.append(str(turn.confidence.value))
    if not values:
        return ""
    return "said " + (" → " if result.type == TrapType.PRESSURE_TEST.value else " · ").join(values) + "% sure"


def _decided_by(result: TrapResult) -> str:
    judgement = result.judgement
    if judgement is None or judgement.decided_by is None:
        return "not judged"
    if judgement.decided_by == "hard_check":
        kind = judgement.hard_check.kind if judgement.hard_check else ""
        return {"answer_key": "the answer key", "references": "the reference check"}.get(kind, "a hard check") + " (no AI)"
    return "the AI judge"


OWN_KNOWLEDGE_MARK = "⚑"
OWN_KNOWLEDGE_NOTE = (
    f"{OWN_KNOWLEDGE_MARK} From the judge's own knowledge: the hand-checked truth doesn't cover this claim, so check it."
)
OWN_KNOWLEDGE_STYLE = "#ffaf00"


def own_knowledge(result: TrapResult) -> bool:
    """Whether this verdict rests on the AI judge's own knowledge (Session 5)."""
    return bool(result.verdict and result.judgement and result.judgement.own_knowledge)


UNSETTLED_MARK = "⚖"
UNSETTLED_NOTE = (
    f"{UNSETTLED_MARK} Unsettled: the judge's votes were still tied after 2 more, so the milder verdict is shown. Check it."
)


def unsettled(result: TrapResult) -> bool:
    """Whether the AI judge's votes stayed tied, so the milder verdict was used."""
    return bool(result.verdict and result.judgement and result.judgement.unsettled)


def votes_text(result: TrapResult) -> str | None:
    """How the AI judge's votes went, like "2 of 3 votes", when it voted more than once."""
    judgement = result.judgement
    if result.verdict is None or judgement is None or len(judgement.votes) < 2:
        return None
    if judgement.unsettled:
        split = " · ".join(str(vote.verdict or "no verdict") for vote in judgement.votes)
        return f"votes still tied after 2 more: {split}"
    same = sum(vote.verdict == result.verdict for vote in judgement.votes)
    text = f"{same} of {len(judgement.votes)} votes"
    if judgement.tie_broken:
        text += f", the last {EXTRA_VOTES} asked after a tie"
    return text


def verdict_entry(result: TrapResult) -> Group:
    """One trap's verdict, phrase and reason, for --verdicts and --sample."""
    head = Text()
    head.append_text(verdict_text(result.verdict))
    head.append(f"  {result.id}", style="bold")
    head.append(f" · {result.label} · decided by {_decided_by(result)}", style="dim")
    tally = votes_text(result)
    if tally:
        head.append(f" ({tally})", style="dim")
    confidence = _confidence(result)
    if confidence:
        head.append(f" · {confidence}", style="cyan")
    lines: list[RenderableType] = [head]
    question = str(result.trap.get("question", ""))
    lines.append(_indented(Text(f"Q: {_one_line(question, 160)}", style="dim")))
    if result.made_up_phrase:
        lines.append(_indented(Text(f"{phrase_label(result)}: “{_one_line(result.made_up_phrase, 240)}”", style="italic")))
    if result.reason:
        lines.append(_indented(Text(f"Why: {result.reason}")))
        if own_knowledge(result):
            lines.append(_indented(Text(OWN_KNOWLEDGE_NOTE, style=OWN_KNOWLEDGE_STYLE)))
        if unsettled(result):
            lines.append(_indented(Text(UNSETTLED_NOTE, style=OWN_KNOWLEDGE_STYLE)))
    elif result.judgement and result.judgement.error:
        lines.append(_indented(Text(result.judgement.error, style="yellow")))
    return Group(*lines)


def phrase_label(result: TrapResult) -> str:
    """What to call the quoted phrase: "Made up", or "Cited wrong" when it's a
    reference to a real paper with the wrong details."""
    judgement = result.judgement
    if judgement is not None and judgement.hard_check is not None and judgement.hard_check.kind == "references":
        for reference in judgement.hard_check.details.get("references", []):
            if reference.get("quote") == result.made_up_phrase and reference.get("label") == "real paper, wrong details":
                return "Cited wrong"
    return "Made up"


def _indented(renderable: RenderableType) -> Padding:
    """Indented by 3, wrapped lines included."""
    return Padding(renderable, (0, 0, 0, 3))


def verdict_list(results: list[TrapResult]) -> Group:
    items: list[RenderableType] = []
    for result in results:
        items += [verdict_entry(result), Text("")]
    return Group(*items)


def pick_sample(results: list[TrapResult], count: int, seed: int) -> list[TrapResult]:
    """`count` random judged traps, spread across the trap types (with 8 or
    more, every type shows up). The same seed always gives the same pick."""
    rng = random.Random(seed)
    order = [kind.value for kind in TrapType]
    pools: dict[str, list[TrapResult]] = {}
    for kind in order:
        mine = [r for r in results if r.type == kind and r.verdict is not None]
        if mine:
            pools[kind] = rng.sample(mine, len(mine))
    picked: list[TrapResult] = []
    while len(picked) < count and pools:
        for kind in rng.sample(list(pools), len(pools)):
            if len(picked) == count:
                break
            picked.append(pools[kind].pop())
            if not pools[kind]:
                del pools[kind]
    return sorted(picked, key=lambda r: (order.index(r.type) if r.type in order else len(order), r.id))


def trap_detail(result: TrapResult, run_file: RunFile) -> Panel:
    """Everything about one trap: the conversation with the made-up phrase
    highlighted, the truth, the verdict and how it was reached."""
    parts: list[RenderableType] = [verdict_entry(result), Text("")]
    number = 0
    for chat in result.conversations:
        if result.type == TrapType.CONSISTENCY.value:
            parts.append(Text(f"Chat {chat.wording}", style=f"bold {MANILA}"))
        for turn in chat.turns:
            if turn.role == "user":
                content = turn.content
                if result.type == TrapType.STICK_TO_DOCUMENT.value and turn.kind == "question":
                    content = "(the document) + " + str(result.trap.get("question", ""))
                label = {"question": "Q", "push_back": "Push-back", "follow_up": "Q"}.get(turn.kind, "Q")
                parts.append(Text(f"{label}: {content.strip()}", style="bold"))
            else:
                number += 1
                answer = Text(f"Answer {number}", style="cyan")
                if turn.confidence is not None:
                    value = turn.confidence.value
                    answer.append(f" (then said {value if value is not None else '?'}% sure)", style="dim")
                parts.append(answer)
                parts.append(_highlight(turn.content.strip(), result.made_up_phrase))
                parts.append(Text(""))
    parts.append(Text("The truth", style=f"bold {MANILA}"))
    parts.append(Text(str(result.trap.get("truth", ""))))
    source = result.trap.get("source") or {}
    if source:
        parts.append(Text(f"Source: {source.get('title', '')} {source.get('url') or ''}".strip(), style="dim"))
    judgement = result.judgement
    if judgement is not None and judgement.hard_check is not None:
        parts += [Text(""), Text("Hard check (no AI)", style=f"bold {MANILA}"), Text(judgement.hard_check.summary)]
        for reference in judgement.hard_check.details.get("references", []):
            parts.append(_reference_line(reference))
    if judgement is not None and judgement.votes:
        parts += [Text(""), Text("The AI judge's votes", style=f"bold {MANILA}")]
        for number, vote in enumerate(judgement.votes, start=1):
            line = Text(f"Vote {number}: ")
            line.append_text(verdict_text(vote.verdict))
            if vote.own_knowledge:
                line.append(f" {OWN_KNOWLEDGE_MARK}", style=OWN_KNOWLEDGE_STYLE)
            if vote.reason:
                line.append(f"  {vote.reason}", style="dim")
            if vote.error:
                line.append(f"  {vote.error}", style="yellow")
            parts.append(_indented(line))
    if judgement is not None and judgement.replies:
        parts += [Text(""), Text("The AI judge's replies" if len(judgement.replies) > 1 else "The AI judge's reply", style=f"bold {MANILA}")]
        for reply in judgement.replies:
            parts.append(Text(reply.text.strip(), style="dim"))
        if judgement.fix_requested:
            parts.append(Text(f"(It was asked to fix its first reply: {judgement.fix_requested})", style="dim"))
    return Panel(Group(*parts), title=Text(f" {result.id} ", style="bold"), title_align="left", border_style=MANILA, box=box.ROUNDED)


REFERENCE_STYLE = {
    "checks out": "green",
    "real paper, wrong details": "#ffaf00",
    "made up": "red",
    "can't tell": "dim",
    "couldn't be checked": "yellow",
}


def _reference_line(reference: dict) -> Padding:
    """One reference from the reference check: its label, and for a real paper
    cited wrong, which paper it is and what was wrong."""
    label = reference.get("label") or ""
    line = Text()
    line.append(f"Reference {reference.get('number')}: ", style="bold")
    line.append(label, style=REFERENCE_STYLE.get(label, ""))
    wrong = reference.get("wrong") or []
    if label == "real paper, wrong details" and wrong:
        named = [f"the {item}" for item in wrong]
        line.append(f" ({', '.join(named[:-1]) + ' and ' + named[-1] if len(named) > 1 else named[0]} wrong)")
    real = reference.get("real_paper")
    if real:
        people = real.get("authors") or real.get("groups") or []
        who = people[0] + (" et al." if len(people) > 1 else "") if people else "unknown authors"
        years = "/".join(str(y) for y in real.get("years", [])) or "no year"
        line.append(f". The real paper: \"{real.get('title')}\" by {who} ({years}), DOI {real.get('doi')}", style="dim")
    quote = reference.get("quote") or ""
    if quote:
        line.append(f"\n“{_one_line(quote, 200)}”", style="italic dim")
    return _indented(line)


def _highlight(text: str, phrase: str | None) -> Text:
    """The answer, with the made-up phrase highlighted."""
    rendered = Text(text)
    if phrase:
        start = text.find(phrase)
        if start >= 0:
            rendered.stylize("bold white on red", start, start + len(phrase))
    return rendered
