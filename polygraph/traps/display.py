"""How the trap library looks in the terminal.

Everything a trap contains is printed through rich.text.Text, so square
brackets in a question show up exactly as written instead of being read as
formatting codes.
"""

from __future__ import annotations

from rich import box
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from polygraph.traps.library import Library
from polygraph.traps.schema import (
    TYPE_INFO,
    Consistency,
    Document,
    GhostFact,
    NumberTrap,
    PressureTest,
    Source,
    StickToDocument,
    Trap,
    TrapType,
)


def summary_table(library: Library) -> Table:
    """How many traps there are of each type."""
    counts = library.counts()
    table = Table(box=box.SIMPLE_HEAD, show_footer=True, pad_edge=False)
    table.add_column("Trap type", footer="Total")
    table.add_column("Traps", justify="right", footer=str(sum(counts.values())))
    table.add_column("", style="dim")
    for kind, info in TYPE_INFO.items():
        note = ""
        if kind is TrapType.STICK_TO_DOCUMENT and library.documents:
            count = len(library.documents)
            note = f"{count} document{'s' if count != 1 else ''}"
        table.add_row(info.label, str(counts[kind]), note)
    if not library.ok:
        table.caption = "These counts only include the traps that passed."
    return table


def trap_panel(trap: Trap, library: Library) -> Panel:
    """One trap in a box, with every field labeled in plain English."""
    grid = Table.grid(padding=(0, 2))
    grid.add_column(style="bold", no_wrap=True)
    # "fold" wraps a long link onto the next line instead of cutting it off.
    grid.add_column(ratio=1, overflow="fold")

    def row(label: str, value: Text | str) -> None:
        grid.add_row(label, value if isinstance(value, Text) else Text(value))

    if isinstance(trap, Consistency):
        wordings = trap.wordings()
        row(f"Asked {len(wordings)} ways", _numbered(wordings))
    else:
        row("Question", trap.question)
    if isinstance(trap, StickToDocument):
        row("Document", _document(library.documents.get(trap.document), trap.document))
        row(
            "Answered in it?",
            "Yes" if trap.answerable else "No. The honest answer is that the document doesn't say.",
        )
    if trap.follow_ups:
        label = "Push-back" if isinstance(trap, PressureTest) else "Follow-up"
        row(label, _numbered(trap.follow_ups) if len(trap.follow_ups) > 1 else trap.follow_ups[0])
    if isinstance(trap, NumberTrap):
        row("Answer key", answer_key(trap))
    row("Truth", trap.truth)
    row("Honest if", trap.honest_looks_like)
    row("Caught if", trap.caught_if)
    row("Source", _source(trap.source))
    if isinstance(trap, GhostFact):
        row("Searched for", Text("\n".join(trap.searches)))
    row("Checked on", trap.verified_on)

    title = Text.assemble((trap.id, "bold"), " · ", trap.info.label)
    return Panel(grid, title=title, title_align="left", border_style="cyan", padding=(0, 1))


def answer_key(trap: NumberTrap) -> str:
    text = format_number(trap.answer_value)
    return f"{text} {trap.answer_unit}" if trap.answer_unit else text


def format_number(value: float) -> str:
    """5.0 -> '5', 299792458.0 -> '299,792,458', 9.9 -> '9.9',
    6.02214076e23 -> '6.02214076 × 10^23'."""
    if value.is_integer() and abs(value) < 1e15:
        return f"{int(value):,}"
    if abs(value) >= 1e15 or (value != 0 and abs(value) < 1e-4):
        mantissa, exponent = f"{value:.12e}".split("e")
        return f"{mantissa.rstrip('0').rstrip('.')} × 10^{int(exponent)}"
    return f"{value:,.12g}"


def _numbered(items: list[str]) -> Text:
    return Text("\n".join(f"{number}. {item}" for number, item in enumerate(items, start=1)))


def _document(document: Document | None, document_id: str) -> Text:
    if document is None:
        return Text(f"(no document called {document_id})", style="red")
    return Text.assemble((document.title, "bold"), "\n", document.text)


def _source(source: Source) -> Text:
    text = Text(source.title)
    if source.url:
        text.append("\n")
        text.append(source.url, style=f"underline link {source.url}")
    if source.note:
        text.append("\n")
        text.append(source.note, style="dim")
    return text
