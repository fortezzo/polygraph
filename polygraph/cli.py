"""The `polygraph` command."""

from __future__ import annotations

import asyncio
import random
import sys
from pathlib import Path
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.markup import escape
from rich.text import Text

from polygraph import __version__
from polygraph.config import load_settings
from polygraph.providers import Message, OllamaProvider, ProviderError
from polygraph.traps import DEFAULT_FOLDER, TYPE_INFO, check_library, find_type, pick_random
from polygraph.traps.display import summary_table, trap_panel

app = typer.Typer(
    help="Polygraph: a lie detector for AI chatbots.",
    no_args_is_help=True,
    add_completion=False,
    # If something ever crashes, don't print the program's variables:
    # one of them could hold an API key.
    pretty_exceptions_show_locals=False,
)
out = Console()  # answers
err = Console(stderr=True)  # status messages and errors, kept apart from answers


def _print_version(value: bool) -> None:
    if value:
        out.print(f"polygraph {__version__}")
        raise typer.Exit()


@app.callback()
def _root(
    version: Annotated[
        bool,
        typer.Option(
            "--version", help="Show the version and quit.", callback=_print_version, is_eager=True
        ),
    ] = False,
) -> None:
    """Polygraph: a lie detector for AI chatbots."""


@app.command()
def ask(
    question: Annotated[str, typer.Argument(help="Your question, in quotes.")],
    model: Annotated[
        Optional[str],
        typer.Option(
            "--model",
            "-m",
            help="Which Ollama model to ask. Default: llama3.2, or POLYGRAPH_MODEL in .env.",
        ),
    ] = None,
) -> None:
    """Ask a model one question and print its answer."""
    if not question.strip():
        err.print(
            'Type a question in quotes, like: polygraph ask "What is the capital of Australia?"',
            markup=False,
        )
        raise typer.Exit(code=2)

    settings = load_settings()
    model_name = (model or "").strip() or settings.model
    provider = OllamaProvider(host=settings.ollama_host)
    conversation = [Message(role="user", content=question)]

    try:
        with err.status(f"Asking {escape(model_name)}..."):
            reply = asyncio.run(provider.chat(conversation, model=model_name))
    except ProviderError as problem:
        err.print(Text(problem.message, style="bold red"))
        if problem.hint:
            err.print(Text(problem.hint))
        raise typer.Exit(code=1)

    # Text() prints the answer exactly as written. Rich would otherwise treat
    # anything in [square brackets] as formatting instructions.
    out.print(Text(reply.text.strip() or "(The model sent back an empty answer.)"))
    out.print(Text(f"\nAnswered by {reply.model} via Ollama in {reply.seconds:.1f}s", style="dim"))


# --- polygraph traps ---------------------------------------------------------

traps_app = typer.Typer(
    help="Check and browse the trap library (the trick questions in traps/).",
    no_args_is_help=True,
)
app.add_typer(traps_app, name="traps")

FolderOption = Annotated[
    Path,
    typer.Option("--folder", help="Which trap folder to use.", show_default="traps/ in this project"),
]


@traps_app.command("check")
def traps_check(folder: FolderOption = DEFAULT_FOLDER) -> None:
    """Check every trap against the rules and count them by type."""
    library = check_library(folder)
    out.print(Text(f"Trap library: {library.folder}", style="bold"))
    out.print(summary_table(library))

    if not library.ok:
        count = len(library.problems)
        err.print(
            Text(
                f"Found {count} problem{'s' if count != 1 else ''}. "
                "Polygraph won't use the traps until they're fixed:",
                style="bold red",
            )
        )
        for number, problem in enumerate(library.problems, start=1):
            err.print(Text(f"{number:>3}. {problem}"))
        raise typer.Exit(code=1)

    out.print(Text(f"Passed: all {len(library.traps)} traps follow the rules.", style="bold green"))
    out.print(Text(f"Library fingerprint: {library.fingerprint}", style="dim"))


@traps_app.command("show")
def traps_show(
    trap_ids: Annotated[
        Optional[list[str]],
        typer.Argument(
            help="IDs of the traps to show, like ghost-001.", metavar="[TRAP_ID]...", show_default=False
        ),
    ] = None,
    trap_type: Annotated[
        Optional[str],
        typer.Option("--type", "-t", help="Show one trap type, like ghost, consistency or document."),
    ] = None,
    count: Annotated[
        Optional[int],
        typer.Option("--random", "-r", min=1, help="Show this many random traps (10 if you don't say)."),
    ] = None,
    seed: Annotated[
        Optional[int],
        typer.Option("--seed", help="Show an earlier random pick again, using the number it printed."),
    ] = None,
    folder: FolderOption = DEFAULT_FOLDER,
) -> None:
    """Print traps in easy-to-read boxes.

    With no options, it shows 10 random traps, with at least one of each type.
    """
    library = check_library(folder)
    if not library.ok:
        err.print(
            Text(
                f"Heads up: the trap library has {len(library.problems)} problem(s), so only the "
                "traps that passed are shown. To see the problems, run: polygraph traps check",
                style="yellow",
            )
        )
    if not library.traps:
        err.print(Text("There are no traps to show.", style="bold red"))
        raise typer.Exit(code=1)

    if trap_ids:
        chosen = [library.find(trap_id) for trap_id in trap_ids]
        missing = [trap_id for trap_id, trap in zip(trap_ids, chosen) if trap is None]
        if missing:
            err.print(
                Text(f"There's no trap called {', '.join(missing)}. IDs look like ghost-001.", style="bold red")
            )
            raise typer.Exit(code=2)
        header = None
    else:
        pool = library.traps
        kind = None
        if trap_type:
            kind = find_type(trap_type)
            if kind is None:
                names = ", ".join(info.id_prefix for info in TYPE_INFO.values())
                err.print(Text(f"'{trap_type}' isn't a trap type. Try one of: {names}", style="bold red"))
                raise typer.Exit(code=2)
            pool = library.of_type(kind)

        if kind is not None and count is None and seed is None:
            chosen = pool
            header = f"All {len(pool)} traps of type: {TYPE_INFO[kind].label}"
        else:
            if seed is None:
                seed = random.SystemRandom().randrange(1000, 10000)
            chosen = pick_random(pool, count or 10, seed)
            again = "polygraph traps show"
            if trap_type:
                again += f" --type {trap_type}"
            if count:
                again += f" --random {count}"
            again += f" --seed {seed}"
            header = f"{len(chosen)} random traps (pick #{seed}). To see the same ones again: {again}"

    if header:
        out.print(Text(header, style="bold"))
    for trap in chosen:
        out.print(trap_panel(trap, library))


def main() -> None:
    """Entry point for the `polygraph` command."""
    _use_utf8_output()
    app(prog_name="polygraph")


def _use_utf8_output() -> None:
    """Answers often contain accented letters or emoji. When output is redirected
    on Windows, Python falls back to an old code page that can't print them and
    crashes, so switch to UTF-8."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8", errors="replace")
