"""The judge-check commands: `polygraph label` and `polygraph agreement`."""

from __future__ import annotations

import webbrowser
from pathlib import Path
from typing import Annotated, Any, Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from polygraph.judgecheck import agreement as agreement_module
from polygraph.judgecheck.agreement import (
    AgreementError,
    Pair,
    Stats,
    final,
    final_for_judge,
    judge_file_name,
    lean,
    load_final,
    load_judge_final,
    load_rounds,
    tuning,
    type_label,
)
from polygraph.runfile import load_run
from polygraph.judgecheck.display import report, rounds_table
from polygraph.judgecheck.files import shown
from polygraph.judgecheck.labels import LABELS_FILE, Label, LabelError, LabelStore, Version, lock_labels
from polygraph.judgecheck.page import page_items
from polygraph.judgecheck.sample import FOLDER, TEST, TUNING, SampleError, SampleItem, load_sample, make_sample, save_sample
from polygraph.judgecheck.server import DEFAULT_PORT, LabelServer, already_running
from polygraph.judges.pipeline import base_name
from polygraph.judges.rubric import ALLOWED
from polygraph.traps.schema import TrapType

out = Console()
err = Console(stderr=True)

FolderOption = Annotated[
    Path, typer.Option("--folder", help="Where the judge check's files are kept.", show_default=False)
]

label_app = typer.Typer(
    help="Hand-label answers to check the judge (PLAN.md section 5).",
    invoke_without_command=True,
    no_args_is_help=False,
    add_completion=False,
    pretty_exceptions_show_locals=False,
)


def _fail(message: str, hint: str | None = None, code: int = 1) -> None:
    err.print(Text(message, style="bold red"))
    if hint:
        err.print(Text(hint))
    raise typer.Exit(code=code)


def _load(folder: Path):
    try:
        sample = load_sample(folder)
        return sample, LabelStore(folder, sample)
    except (SampleError, LabelError) as problem:
        _fail(str(problem))
        raise  # unreachable: _fail always exits


# --- polygraph label ------------------------------------------------------------------------


@label_app.callback(invoke_without_command=True)
def label(
    ctx: typer.Context,
    port: Annotated[int, typer.Option("--port", min=0, max=65535, help="Which port the page uses on this PC.")] = DEFAULT_PORT,
    no_browser: Annotated[bool, typer.Option("--no-browser", help="Don't open the browser, just print the address.")] = False,
    folder: FolderOption = FOLDER,
) -> None:
    """Open the labeling page in your browser. It never shows the judge's verdict.

    Every pick is saved straight away: stop any time with Ctrl+C, and run
    polygraph label again to pick up where you left off.
    """
    if ctx.invoked_subcommand is not None:
        return
    sample, store = _load(folder)
    if port and already_running(port):
        url = f"http://127.0.0.1:{port}/"
        out.print(Text(f"The labeling page is already running, in another PowerShell tab. Opening it: {url}", style="bold"))
        if not no_browser:
            webbrowser.open(url, new=2)
        return
    try:
        items = page_items(sample)
    except SampleError as problem:
        _fail(str(problem))
        raise

    total = len(items)

    def progress(labeled: int, total_: int) -> None:
        if labeled == total_:
            out.print(Text(f"All {total_} answers are labeled. Tell Claude in the polygraph tab.", style="bold green"))
        elif labeled % 5 == 0:
            out.print(Text(f"{labeled} of {total_} labeled", style="dim"))

    server = LabelServer(store, items, port=port, on_label=progress)
    lines = Text()
    lines.append("The labeling page is open at ", style="bold")
    lines.append(server.url, style="bold cyan")
    lines.append(f"\n{store.labeled()} of {total} answers labeled so far. Every pick is saved straight away in ")
    lines.append(shown(store.path))
    lines.append(".\nTo stop: close the page, then press Ctrl+C here. To carry on later: polygraph label")
    if store.lock is not None:
        lines.append("\nYour labels are locked, so the page is read-only.", style="yellow")
    out.print(Panel(lines, title="Judge check", title_align="left"))
    if not no_browser:
        webbrowser.open(server.url, new=2)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
        labeled = LabelStore(folder, sample).labeled()
        out.print(Text(f"Stopped. {labeled} of {total} answers labeled, saved in {shown(store.path)}.", style="bold"))
        if labeled < total:
            out.print(Text("To carry on: polygraph label", style="dim"))


@label_app.command("pick")
def label_pick(
    first: Annotated[Path, typer.Argument(help="The first original run file (not a judged copy).", show_default=False)],
    second: Annotated[Path, typer.Argument(help="The second original run file.", show_default=False)],
    seed: Annotated[int, typer.Option("--seed", help="The random seed. Decide it before running this, and say so.")],
    size: Annotated[int, typer.Option("--size", min=2, help="How many answers to pick.")] = 100,
    exclude: Annotated[
        Optional[list[str]],
        typer.Option("--exclude", help="Leave out the FIRST run's answer to this trap. Repeat it for more."),
    ] = None,
    why: Annotated[str, typer.Option("--why", help="Why those answers are left out, for the record.")] = "",
    replace: Annotated[bool, typer.Option("--replace", help="Replace the pick, but only if nothing is labeled yet.")] = False,
    folder: FolderOption = FOLDER,
) -> None:
    """Pick the answers to label from two original run files, and split them in half. Done once, before labeling."""
    labels_path = Path(folder) / LABELS_FILE
    if replace and labels_path.exists():
        _fail("There are labels already, so the pick can't be replaced: they belong to it.")
    try:
        sample = make_sample(first, second, size=size, seed=seed, exclude_first=exclude or [], exclude_why=why)
        path = save_sample(sample, folder, replace=replace)
    except SampleError as problem:
        _fail(str(problem))
        raise

    table = Table(title=f"The pick: {sample.size} answers, seed {sample.seed}", title_justify="left")
    table.add_column("Trap type")
    for run in sample.runs:
        table.add_column(run.model, justify="right")
    table.add_column("Tuning half", justify="right")
    table.add_column("Test half", justify="right")
    table.add_column("Total", justify="right", style="bold")
    for kind in TrapType:
        items = [item for item in sample.items if item.type == kind.value]
        if not items:
            continue
        table.add_row(
            type_label(kind.value),
            *[str(sum(1 for i in items if i.run == run.key)) for run in sample.runs],
            str(sum(1 for i in items if i.half == TUNING)),
            str(sum(1 for i in items if i.half == TEST)),
            str(len(items)),
        )
    table.add_row(
        "Total",
        *[str(sum(1 for i in sample.items if i.run == run.key)) for run in sample.runs],
        str(len(sample.half(TUNING))),
        str(len(sample.half(TEST))),
        str(len(sample.items)),
        style="bold",
    )
    out.print(table)
    for line in sample.method:
        out.print(Text(f"- {line}"))
    out.print(Text(f"Saved: {shown(path)} (fingerprint {sample.fingerprint})", style="bold"))


@label_app.command("status")
def label_status(folder: FolderOption = FOLDER) -> None:
    """How many answers are labeled so far. It never shows the labels themselves."""
    sample, store = _load(folder)
    table = Table(title="Labeling progress", title_justify="left")
    table.add_column("Trap type")
    table.add_column("Labeled", justify="right")
    for kind in TrapType:
        items = [item for item in sample.items if item.type == kind.value]
        if items:
            done = sum(1 for i in items if (store.labels.get(i.id) or Label()).verdict)
            table.add_row(type_label(kind.value), f"{done} of {len(items)}")
    table.add_row("Total", f"{store.labeled()} of {len(sample.items)}", style="bold")
    out.print(table)
    unsure = sum(1 for label in store.labels.values() if label.verdict and label.unsure)
    notes = sum(1 for label in store.labels.values() if label.note.strip())
    out.print(Text(f"Marked not sure: {unsure} · with a note: {notes}"))
    lock = store.lock
    if lock is not None:
        out.print(Text(f"Locked on {lock.locked_at}.", style="bold"))
    elif store.labeled() == len(sample.items):
        out.print(Text("Every answer is labeled. Next: polygraph label lock", style="bold green"))
    else:
        out.print(Text(f"Next unlabeled: {store.first_unlabeled()}", style="dim"))


@label_app.command("lock")
def label_lock(folder: FolderOption = FOLDER) -> None:
    """Freeze the labels once every answer has one, before anything is compared with the judge."""
    _, store = _load(folder)
    try:
        lock = lock_labels(store)
    except LabelError as problem:
        _fail(problem.message)
        raise
    out.print(Text(f"Locked {lock.labels} labels on {lock.locked_at}.", style="bold green"))
    out.print(
        Text(
            f"Fingerprints: all {lock.fingerprints['all']} · tuning {lock.fingerprints[TUNING]} · test {lock.fingerprints[TEST]}"
        )
    )
    out.print(Text("The test half stays exactly like this. The final measurement checks it did.", style="dim"))


@label_app.command("change")
def label_change(
    item: Annotated[str, typer.Argument(help="The answer, like item-012.", show_default=False)],
    verdict: Annotated[str, typer.Argument(help="Honest, Lie, Caved, Contradicted or Dodged.", show_default=False)],
    note: Annotated[Optional[str], typer.Option("--note", help="Why it changed, for the record.")] = None,
    folder: FolderOption = FOLDER,
) -> None:
    """Change a tuning-half label after talking it through. The old one is kept. Test-half labels can't change."""
    sample, store = _load(folder)
    code = verdict.strip().upper()
    found = sample.item(item.strip().lower())
    if found is None:
        _fail(f"There's no answer called {item}.")
        raise typer.Exit(1)
    if code not in ALLOWED[found.type]:
        _fail(f"{verdict} isn't a verdict for this trap. Use one of: {', '.join(v.title() for v in ALLOWED[found.type])}.")
    if store.lock is None:
        _fail("The labels aren't locked yet, so change it on the labeling page instead.")
    before = (store.labels.get(found.id) or Label()).verdict
    try:
        store.set(found.id, verdict=code, note=note, where="walkthrough")
    except LabelError as problem:
        _fail(problem.message)
        raise
    out.print(Text(f"{found.id}: {str(before).title()} → {code.title()}. The old label is kept in its history.", style="bold"))


# --- polygraph agreement ------------------------------------------------------------------


def _chosen(sample, paths: list[Path] | None) -> dict[str, Path] | None:
    if not paths:
        return None
    chosen: dict[str, Path] = {}
    for path in paths:
        matches = [run.key for run in sample.runs if base_name(Path(run.path)) == base_name(Path(path))]
        if not matches:
            _fail(f"{path} isn't a judged copy of either run in the pick.")
        chosen[matches[0]] = Path(path)
    return chosen


def _stats_from(record: dict[str, Any]) -> Stats:
    """A saved measurement, ready to show again exactly as it was saved."""
    pairs = []
    for row in record.get("disagreements", []):
        history = [Version()] if row.get("changed") else []
        pairs.append(
            Pair(
                item=SampleItem(id=row["item"], run="?", trap=row["trap"], type=row["type"], half=record.get("half", TEST)),
                bot=row["bot"],
                label=Label(verdict=row["yours"], unsure=row.get("unsure", False), note=row.get("note") or "", history=history),
                verdict=None if row["polygraph"] == agreement_module.NOT_JUDGED else row["polygraph"],
                decided_by=row.get("decided_by"),
                reason=row.get("reason"),
                phrase=row.get("made_up_phrase"),
                own_knowledge=row.get("own_knowledge"),
                votes=tuple(row.get("votes") or ()),
                unsettled=bool(row.get("unsettled")),
            )
        )
    return Stats(
        n=record["answers"],
        agree=record["agree"],
        percent=record["percent"],
        percent_range=tuple(record["percent_range"]) if record.get("percent_range") else None,
        kappa=record["kappa"],
        kappa_range=tuple(record["kappa_range"]) if record.get("kappa_range") else None,
        same_points=record["same_points"],
        human_points=record["your_points"],
        polygraph_points=record["polygraph_points"],
        confusion=record["confusion"],
        by_type=record.get("by_type", {}),
        by_decider=record.get("by_decider", {}),
        by_bot=record.get("by_bot", {}),
        by_sureness=record.get("by_sureness", {}),
        disagreements=pairs,
        not_judged=record.get("not_judged", 0),
        own_knowledge=list(record.get("own_knowledge") or [0, 0]),
        by_votes=record.get("by_votes", {}),
    )


def _judge_row(record: dict[str, Any]) -> str:
    votes = record.get("votes", 1)
    counted = f" · {votes} votes per trap, the majority wins" if votes > 1 else ""
    return f"{record['judge']} · rubric {record['rubric']} · hard checks {record['hard_checks']}{counted}"


def _first_vote_row(record: dict[str, Any]) -> tuple[str, str] | None:
    first = record.get("first_vote")
    if not first:
        return None
    kappa = "–" if first.get("kappa") is None else f"{first['kappa']:.2f}"
    return ("First vote alone", f"{first['agree']} of {first['answers']} ({first['percent']:.0f}%) · kappa {kappa}")


def _show_final(record: dict[str, Any], folder: Path) -> None:
    stats = _stats_from(record)
    rows = [
        ("Half", f"test: {stats.n} answers, never used for tuning"),
        ("Judge", _judge_row(record)),
        ("Judged copies", ", ".join(record["judged_files"].values())),
        ("Your labels", f"exactly as locked on {record['labels']['locked_at']}"),
        ("Tuning", f"{record['tuning_rounds']} rounds on the tuning half"),
        ("Measured", f"{record['measured_at']}" + (f" · code at commit {record['git']['commit'][:10]}" if record.get("git", {}).get("commit") else "")),
    ]
    first = _first_vote_row(record)
    if first:
        rows.append(first)
    out.print(report(stats, rows, "Final agreement: the test half", "Where you and Polygraph disagreed on the test half"))
    baseline = record.get("baseline")
    if baseline:
        kappa = "can't be worked out" if baseline.get("kappa") is None else f"{baseline['kappa']:.2f}"
        votes = baseline.get("votes", 1)
        out.print(
            Text(
                f"Before any tuning (rubric {baseline['rubric']}, {votes} vote{'s' if votes != 1 else ''} per trap), "
                f"the same test half: {baseline['agree']} of {baseline['answers']} ({baseline['percent']:.0f}%), kappa {kappa}.",
                style="bold",
            )
        )
    out.print(Text(f"Saved in {shown(Path(folder) / agreement_module.FINAL_FILE)}", style="dim"))


_VERDICT_WORDS = {"HONEST": "Honest", "LIE": "Lie", "CAVED": "Caved", "CONTRADICTED": "Contradicted", "DODGED": "Dodged"}


def lean_words(found: dict[str, Any], judge: str) -> str:
    """Which way a judge leans compared with Christian, in one or two sentences."""

    def cells(name: str) -> str:
        parts = [
            f"{cell['count']} of your {_VERDICT_WORDS.get(cell['yours'], cell['yours'])}s it called "
            f"{_VERDICT_WORDS.get(cell['judge'], cell['judge'])}"
            for cell in found.get(name, [])
        ]
        return ", ".join(parts)

    direction = found.get("direction")
    if direction == "generous":
        text = f"{judge} leans generous: {cells('generous')}."
    elif direction == "harsh":
        text = f"{judge} leans harsh: {cells('harsh')}."
    else:
        text = f"{judge} doesn't lean either way on these answers."
        if found.get("generous_total"):
            text += f" Generous: {cells('generous')}."
    if direction == "generous" and found.get("harsh_total"):
        text += f" The other way: {cells('harsh')}."
    elif direction == "harsh" and found.get("generous_total"):
        text += f" The other way: {cells('generous')}."
    elif direction == "generous":
        text += " It never scored one of your answers lower than you did."
    elif direction == "harsh":
        text += " It never scored one of your answers higher than you did."
    if found.get("sideways_total"):
        text += f" Same points, different verdict: {cells('sideways')}."
    if found.get("not_judged_total"):
        text += f" Not judged: {found['not_judged_total']}."
    return text


def _show_judge_final(record: dict[str, Any], folder: Path) -> None:
    stats = _stats_from(record)
    settings = record.get("judge_settings") or {}
    setup = []
    if settings.get("thinking"):
        setup.append(f"thinking {settings['thinking']}")
    if settings.get("context_window"):
        setup.append(f"a {settings['context_window']:,}-token window")
    rows = [
        ("Half", f"test: {stats.n} answers, never used for tuning"),
        ("Judge", _judge_row(record) + (f" · {', '.join(setup)}" if setup else "")),
        ("Judged copies", ", ".join(record["judged_files"].values())),
        ("Your labels", f"exactly as locked on {record['labels']['locked_at']}"),
        ("Tuning", "none: the rubric exactly as frozen for the first judge"),
        ("Measured", f"{record['measured_at']}" + (f" · code at commit {record['git']['commit'][:10]}" if record.get("git", {}).get("commit") else "")),
    ]
    first = _first_vote_row(record)
    if first:
        rows.append(first)
    out.print(report(stats, rows, f"Final agreement: {record['judge']} on the test half", "Where you and this judge disagreed"))
    out.print(Text(lean_words(record["lean"], record["judge"]), style="bold"))
    versus = record.get("versus_first_judge") or {}
    if versus:
        both, ai = versus["all"], versus["ai_judge_both"]
        kappa = "–" if both.get("kappa") is None else f"{both['kappa']:.2f}"
        ai_kappa = "–" if ai.get("kappa") is None else f"{ai['kappa']:.2f}"
        out.print(
            Text(
                f"{versus['second_judge']} and {versus['first_judge']} gave the same verdict on {both['agree']} of "
                f"{both['answers']} ({both['percent']:.0f}%, kappa {kappa}). On the {ai['answers']} that both AI judges "
                f"decided (the hard checks settle the rest the same way for both): {ai['agree']} of {ai['answers']} "
                f"({ai['percent']:.0f}%, kappa {ai_kappa}).",
            )
        )
        out.print(Text(lean_words(record["first_judge_lean"], versus["first_judge"]), style="dim"))
    out.print(Text(f"Saved in {shown(Path(folder) / judge_file_name(record['judge']))}", style="dim"))


def agreement(
    final_measurement: Annotated[
        bool,
        typer.Option("--final", help="Measure the test half. Done once, after the rubric is final and committed."),
    ] = False,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Don't ask before measuring the test half.")] = False,
    redo: Annotated[
        Optional[str],
        typer.Option("--redo", help="Measure the test half again, and say why. The earlier result is kept."),
    ] = None,
    note: Annotated[Optional[str], typer.Option("--note", help="What changed in this tuning round, for the log.")] = None,
    judged: Annotated[
        Optional[list[Path]],
        typer.Option("--judged", help="Compare these judged copies instead of the newest ones. Repeat it for each run."),
    ] = None,
    folder: FolderOption = FOLDER,
) -> None:
    """How often Polygraph's verdicts agree with your labels: percent agreement, Cohen's kappa and where you disagreed.

    Without --final it only looks at the tuning half, for improving the rubric.
    --final measures the test half, once.
    """
    sample, store = _load(folder)
    chosen = _chosen(sample, judged)
    if not final_measurement:
        try:
            stats, record, new = tuning(folder, sample, store, chosen=chosen, note=note)
        except (AgreementError, SampleError, LabelError) as problem:
            _fail(str(problem))
            raise
        changed = record.get("labels_changed_since_lock", 0)
        rows = [
            ("Half", f"tuning: {stats.n} answers. The test half stays hidden until the final measurement."),
            ("Judge", _judge_row(record)),
            ("Judged copies", ", ".join(record["judged_files"].values())),
            ("Your labels", "as locked" if not changed else f"{changed} changed since the lock (the old ones are kept)"),
            ("Round", f"{record['round']}" + (" (new)" if new else " (the same as before, so not logged again)")),
        ]
        first = _first_vote_row(record)
        if first:
            rows.append(first)
        out.print(report(stats, rows, "Agreement: the tuning half", "Where you and Polygraph disagreed"))
        out.print(rounds_table(load_rounds(folder)))
        return

    earlier = load_final(folder)
    other_judge = _other_judge(chosen, earlier)
    if other_judge is not None:
        measured = load_judge_final(folder, other_judge)
        if measured is not None:
            _show_judge_final(measured, folder)
            return
    elif earlier is not None and not redo:
        _show_final(earlier, folder)
        return
    state = agreement_module.git_state()
    if state.get("code_committed") is False:
        _fail(
            "The code has changes that aren't committed yet. Commit the final rubric first, so git's history "
            "shows it was fixed before the test half was opened."
        )
    if not yes:
        if not (err.is_terminal and out.is_terminal):
            _fail("Measuring the test half needs a yes. Run it again with --yes.")
        if not typer.confirm(
            "This opens the test half, once. Do it only when the rubric is final. Go ahead?", default=False
        ):
            raise typer.Exit(1)
    if other_judge is not None:
        try:
            _, record = final_for_judge(folder, sample, store, chosen=chosen or {}, git=lambda: state)
        except (AgreementError, SampleError, LabelError) as problem:
            _fail(str(problem))
            raise
        _show_judge_final(record, folder)
        return
    try:
        _, _, record = final(folder, sample, store, chosen=chosen, redo=redo, git=lambda: state)
    except (AgreementError, SampleError, LabelError) as problem:
        _fail(str(problem))
        raise
    _show_final(record, folder)


def _other_judge(chosen: dict[str, Path] | None, first: dict[str, Any] | None) -> str | None:
    """The judge of the chosen judged copies, when it isn't the judge final.json
    measured: that judge's measurement goes in its own file."""
    if not chosen or first is None:
        return None
    judges = set()
    for path in chosen.values():
        try:
            info = load_run(path).run.judge
        except (ValueError, OSError):
            continue
        if info is not None:
            judges.add(info.model)
    if len(judges) == 1:
        judge = judges.pop()
        return None if judge == first["judge"] else judge
    return None


__all__ = ["agreement", "label_app"]
