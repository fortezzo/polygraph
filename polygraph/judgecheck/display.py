"""How the judge check looks in the terminal."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from rich import box
from rich.console import Group, RenderableType
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from polygraph.judgecheck.agreement import NOT_JUDGED, VERDICTS, Pair, Stats, kappa_words, type_label
from polygraph.traps.schema import TrapType

SHORT = {
    "HONEST": "Honest",
    "LIE": "Lie",
    "CAVED": "Caved",
    "CONTRADICTED": "Contra.",
    "DODGED": "Dodged",
    NOT_JUDGED: "Not judged",
}
NAMES = {**SHORT, "CONTRADICTED": "Contradicted"}
STYLES = {"HONEST": "green", "LIE": "red", "CAVED": "#ffaf00", "CONTRADICTED": "magenta", "DODGED": "blue", NOT_JUDGED: "dim"}
DECIDERS = {"hard_check": "hard checks", "ai_judge": "AI judge", "not_judged": "not judged"}


def _pct(value: float | None) -> str:
    return "–" if value is None else f"{value:.0f}%"


def _range(pair: Sequence[float] | None, digits: int = 0, suffix: str = "%") -> str:
    if pair is None:
        return "–"
    return f"{pair[0]:.{digits}f}–{pair[1]:.{digits}f}{suffix}"


def _kappa(value: float | None) -> str:
    return "–" if value is None else f"{value:.2f}"


def headline(stats: Stats, rows: list[tuple[str, str]], title: str) -> Panel:
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold")
    table.add_column()
    for name, value in rows:
        table.add_row(name, value)
    table.add_row(
        "Agreement",
        f"{stats.agree} of {stats.n} ({_pct(stats.percent)}) · 95% range {_range(stats.percent_range)}",
    )
    table.add_row(
        "Cohen's kappa",
        f"{_kappa(stats.kappa)} ({kappa_words(stats.kappa)}) · 95% range {_range(stats.kappa_range, 2, '')}",
    )
    points = f"the same points on {stats.same_points} of {stats.n - stats.not_judged}"
    if stats.human_points is not None and stats.polygraph_points is not None:
        points += f" · average: yours {stats.human_points:.0f}, Polygraph's {stats.polygraph_points:.0f} (out of 100)"
    table.add_row("Points", points)
    if stats.not_judged:
        table.add_row("Not judged", f"{stats.not_judged} (counted as disagreements)")
    return Panel(table, title=title, title_align="left")


def grid(stats: Stats) -> Table:
    used = [code for code in (*VERDICTS, NOT_JUDGED) if any(stats.confusion[h].get(code) for h in VERDICTS)]
    rows = [code for code in VERDICTS if any(stats.confusion[code].values())]
    columns = sorted(set(used) | set(rows), key=lambda code: (*VERDICTS, NOT_JUDGED).index(code))
    table = Table(
        title="Your label (rows) against Polygraph's verdict (columns)",
        title_justify="left",
        box=box.SIMPLE_HEAVY,
        pad_edge=False,
    )
    table.add_column("You ↓  Polygraph →", style="bold")
    for code in columns:
        table.add_column(SHORT[code], justify="right", style=STYLES[code])
    table.add_column("Total", justify="right", style="bold")
    for human in rows:
        cells = []
        for code in columns:
            count = stats.confusion[human].get(code, 0)
            text = str(count) if count else "·"
            cells.append(Text(text, style="bold reverse" if code == human and count else ""))
        table.add_row(Text(NAMES[human], style=STYLES[human]), *cells, str(sum(stats.confusion[human].values())))
    totals = [str(sum(stats.confusion[h].get(code, 0) for h in VERDICTS)) for code in columns]
    table.add_row("Total", *totals, str(stats.n), style="bold")
    return table


def _counts(groups: dict[str, list[int]], names: dict[str, str] | None = None) -> str:
    parts = []
    for key, (agree, n) in groups.items():
        parts.append(f"{(names or {}).get(key, key)} {agree}/{n}")
    return " · ".join(parts) if parts else "–"


def breakdown(stats: Stats) -> Table:
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold")
    table.add_column()
    order = [kind.value for kind in TrapType]
    by_type = {type_label(kind): stats.by_type[kind] for kind in order if kind in stats.by_type}
    table.add_row("By trap type", _counts(by_type))
    table.add_row("Who decided", _counts(stats.by_decider, DECIDERS))
    table.add_row("By bot", _counts(stats.by_bot))
    table.add_row("Your sureness", _counts(stats.by_sureness))
    return table


def _one_line(text: str | None, limit: int) -> str:
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[: limit - 1].rstrip() + "…"


def disagreements(pairs: Sequence[Pair], title: str) -> RenderableType:
    if not pairs:
        return Text(f"{title}: none.", style="bold green")
    table = Table(title=f"{title} ({len(pairs)})", title_justify="left", box=box.SIMPLE, show_lines=False, expand=True)
    table.add_column("Answer", no_wrap=True)
    table.add_column("Trap", no_wrap=True)
    table.add_column("Bot", no_wrap=True)
    table.add_column("You", no_wrap=True)
    table.add_column("Polygraph", no_wrap=True)
    table.add_column("By", no_wrap=True)
    table.add_column("Polygraph's reason", ratio=1)
    for pair in pairs:
        yours = Text(NAMES[pair.human], style=STYLES[pair.human])
        if pair.label.unsure:
            yours.append(" (not sure)", style="dim")
        if pair.label.history:
            yours.append(" (changed)", style="dim")
        table.add_row(
            pair.item.id,
            pair.item.trap,
            pair.bot,
            yours,
            Text(NAMES[pair.polygraph], style=STYLES[pair.polygraph]),
            DECIDERS.get(pair.decided_by or "not_judged", "?"),
            _one_line(pair.reason, 160),
        )
    return table


def rounds_table(rounds: list[dict[str, Any]]) -> Table:
    table = Table(title="Tuning rounds (tuning half only)", title_justify="left", box=box.SIMPLE)
    table.add_column("Round", justify="right")
    table.add_column("When")
    table.add_column("Rubric")
    table.add_column("Checks")
    table.add_column("Agreement", justify="right")
    table.add_column("Kappa", justify="right")
    table.add_column("Labels changed", justify="right")
    table.add_column("Note")
    for entry in rounds:
        table.add_row(
            str(entry["round"]),
            str(entry["at"])[:16].replace("T", " "),
            entry["rubric"],
            str(entry["hard_checks"]),
            f"{entry['agree']}/{entry['answers']} ({_pct(entry['percent'])})",
            _kappa(entry["kappa"]),
            str(entry.get("labels_changed_since_lock", 0)),
            _one_line(entry.get("note"), 40),
        )
    return table


def report(stats: Stats, rows: list[tuple[str, str]], title: str, disagreement_title: str) -> Group:
    return Group(
        headline(stats, rows, title),
        grid(stats),
        breakdown(stats),
        Text(""),
        disagreements(stats.disagreements, disagreement_title),
    )
