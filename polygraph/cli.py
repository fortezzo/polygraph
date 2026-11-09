"""The `polygraph` command."""

from __future__ import annotations

import asyncio
import sys
from typing import Annotated, Optional

import typer
from rich.console import Console
from rich.markup import escape
from rich.text import Text

from polygraph import __version__
from polygraph.config import load_settings
from polygraph.providers import Message, OllamaProvider, ProviderError

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
