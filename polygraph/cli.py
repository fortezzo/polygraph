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
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

from polygraph import __version__
from polygraph.config import Settings, load_settings
from polygraph.interrogator import (
    DEFAULT_LIMIT_USD,
    Caller,
    CostGuard,
    Interrogator,
    ResponseCache,
)
from polygraph.pricing import FREE, Prices, format_usd
from polygraph.progress import RunDisplay, plan_table, summary_table
from polygraph.providers import (
    CHEAPEST,
    LABELS,
    PRICES_CHECKED_ON,
    PROVIDER_NAMES,
    ChatOptions,
    Message,
    Provider,
    ProviderError,
    SetupError,
    choose,
    find_known,
    make_provider,
    provider_name,
)
from polygraph.providers.catalog import SOURCES, models_for
from polygraph.runfile import Target
from polygraph.traps import (
    DEFAULT_FOLDER,
    TYPE_INFO,
    TrapLibraryError,
    check_library,
    find_type,
    load_library,
    pick_random,
)
from polygraph.traps.display import summary_table as traps_summary_table
from polygraph.traps.display import trap_panel

app = typer.Typer(
    help="Polygraph: a lie detector for AI chatbots.",
    no_args_is_help=True,
    add_completion=False,
    # If something ever crashes, don't print the program's variables:
    # one of them could hold an API key.
    pretty_exceptions_show_locals=False,
)
out = Console()  # answers and results
err = Console(stderr=True)  # status messages and errors, kept apart from answers

# Answer length limits. Models that think before answering spend part of the
# limit on thinking, so they get much more room: too little would cut their
# answers off (or leave them empty) and make them look evasive.
PLAIN_LIMIT = 4_096
THINKING_LIMIT = 32_768
ASK_THINKING_LIMIT = 16_384  # one quick question, so a little less


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


def _explain(problem: ProviderError | SetupError) -> None:
    err.print(Text(problem.message, style="bold red"))
    if problem.hint:
        err.print(Text(problem.hint))


def _interactive() -> bool:
    """True when someone is at the keyboard to answer a yes/no question."""
    return sys.stdin is not None and sys.stdin.isatty()


ModelOption = Annotated[
    Optional[str],
    typer.Option(
        "--model",
        "-m",
        help="Which model to use, like llama3.2, gpt-6-luna, claude-haiku-5-5 or gemini-2.5-flash-lite. "
        "Default: llama3.2, or POLYGRAPH_MODEL in .env.",
    ),
]
ProviderOption = Annotated[
    Optional[str],
    typer.Option(
        "--provider",
        "-p",
        help="ollama, openai, anthropic, google or compatible. Usually worked out from the model name.",
    ),
]
BaseUrlOption = Annotated[
    Optional[str],
    typer.Option(
        "--base-url",
        help="The address of an OpenAI-compatible service, like https://api.groq.com/openai/v1.",
    ),
]


# --- polygraph ask -------------------------------------------------------------


@app.command()
def ask(
    question: Annotated[str, typer.Argument(help="Your question, in quotes.")],
    model: ModelOption = None,
    provider: ProviderOption = None,
    base_url: BaseUrlOption = None,
) -> None:
    """Ask a model one question and print its answer."""
    if not question.strip():
        err.print(
            'Type a question in quotes, like: polygraph ask "What is the capital of Australia?"',
            markup=False,
        )
        raise typer.Exit(code=2)

    settings = load_settings()
    try:
        name, model_name = choose(model, provider, settings)
        bot = make_provider(name, settings, base_url)
    except SetupError as problem:
        _explain(problem)
        raise typer.Exit(code=1)
    known = find_known(name, model_name)
    options = ChatOptions(max_output_tokens=ASK_THINKING_LIMIT if known and known.reasoning else PLAIN_LIMIT)
    conversation = [Message(role="user", content=question)]

    try:
        with err.status(f"Asking {escape(model_name)}..."):
            reply = asyncio.run(bot.chat(conversation, model=model_name, options=options))
    except ProviderError as problem:
        _explain(problem)
        raise typer.Exit(code=1)

    # Text() prints the answer exactly as written. Rich would otherwise treat
    # anything in [square brackets] as formatting instructions.
    out.print(Text(reply.text.strip() or "(The model sent back an empty answer.)"))
    line = f"\nAnswered by {reply.model} via {bot.label} in {reply.seconds:.1f}s"
    if not bot.local and known is not None and reply.input_tokens is not None and reply.output_tokens is not None:
        cost = known.prices().cost(reply.input_tokens, reply.output_tokens, reply.cache_write_tokens or 0)
        line += f" · cost {format_usd(cost)}"
    out.print(Text(line, style="dim"))


# --- polygraph run -------------------------------------------------------------


@app.command()
def run(
    model: ModelOption = None,
    provider: ProviderOption = None,
    trap_types: Annotated[
        Optional[list[str]],
        typer.Option("--type", "-t", help="Only these trap types, like ghost or pressure. Repeat it for more."),
    ] = None,
    trap_ids: Annotated[
        Optional[list[str]],
        typer.Option("--trap", help="Only these traps, like ghost-001. Repeat it for more."),
    ] = None,
    max_cost: Annotated[
        float,
        typer.Option("--max-cost", min=0.0, help="The most this run may spend, in US dollars."),
    ] = DEFAULT_LIMIT_USD,
    yes: Annotated[
        bool,
        typer.Option("--yes", "-y", help="Start a paid run without asking first. Never raises the limit."),
    ] = False,
    estimate_only: Annotated[
        bool, typer.Option("--estimate", help="Show the plan and the estimated cost, then stop.")
    ] = False,
    fresh: Annotated[
        bool,
        typer.Option("--fresh", help="Ask every question again instead of reusing saved answers."),
    ] = False,
    concurrency: Annotated[
        Optional[int],
        typer.Option("--concurrency", "-c", min=1, max=32, help="Questions at a time. Default: 2 on this PC, 4 in the cloud."),
    ] = None,
    max_tokens: Annotated[
        Optional[int],
        typer.Option("--max-tokens", min=16, help="The longest answer allowed, in tokens."),
    ] = None,
    temperature: Annotated[
        Optional[float],
        typer.Option("--temperature", min=0.0, max=2.0, help="Default: the model's own setting."),
    ] = None,
    price_in: Annotated[
        Optional[float],
        typer.Option("--price-in", min=0.0, help="For a model Polygraph doesn't know: dollars per million input tokens."),
    ] = None,
    price_out: Annotated[
        Optional[float],
        typer.Option("--price-out", min=0.0, help="... and dollars per million output tokens."),
    ] = None,
    base_url: BaseUrlOption = None,
    folder: Annotated[Path, typer.Option("--folder", help="Which trap folder to use.", hidden=True)] = DEFAULT_FOLDER,
) -> None:
    """Interrogate a bot with the trap library and save everything to a run file in runs/."""
    settings = load_settings()

    # 1. The traps.
    try:
        library = load_library(folder)
    except TrapLibraryError as problem:
        err.print(Text(str(problem), style="bold red"))
        raise typer.Exit(code=1)
    traps = _select_traps(library, trap_types, trap_ids)

    # 2. The bot, and what it costs.
    try:
        name, model_name = choose(model, provider, settings)
        bot = make_provider(name, settings, base_url)
    except SetupError as problem:
        _explain(problem)
        raise typer.Exit(code=1)
    known = find_known(name, model_name)
    prices = _prices(bot, name, model_name, known, price_in, price_out)
    thinks = bool(known and known.reasoning)
    options = ChatOptions(
        max_output_tokens=max_tokens or (THINKING_LIMIT if thinks else PLAIN_LIMIT),
        temperature=temperature,
    )
    at_once = concurrency or (2 if bot.local else 4)

    # 3. Check the model exists and which exact version it is. This costs nothing.
    try:
        with err.status(f"Checking {escape(model_name)}..."):
            info = asyncio.run(bot.describe_model(model_name))
    except ProviderError as problem:
        _explain(problem)
        raise typer.Exit(code=1)

    cache = ResponseCache(settings.cache_dir)
    try:
        guard = CostGuard(max_cost)
        display = RunDisplay(out, total_traps=len(traps), free=prices.free)
        caller = Caller(
            bot,
            model_name,
            prices=prices,
            guard=guard,
            options=options,
            cache=cache,
            read_cache=not fresh,
            concurrency=at_once,
            version_pin=info.version,
            on_retry=display.retrying,
        )
        target = Target(
            provider=name,
            provider_label=bot.label,
            model=model_name,
            # Ollama says exactly which download it is before the run. Cloud
            # services say which version answered with every reply instead.
            model_version=info.version if name == "ollama" else None,
            model_details=info.details,
            endpoint=bot.endpoint,
            settings={
                "max_output_tokens": options.max_output_tokens,
                "temperature": options.temperature,
                "thinking": "the model's default",
            },
        )
        interrogator = Interrogator(
            caller=caller,
            library=library,
            traps=traps,
            target=target,
            limit_usd=max_cost,
            prices=prices,
            thinks=thinks,
            concurrency=at_once,
            listener=display,
        )
        estimate = interrogator.estimate()
        interrogator.estimated_usd = estimate.typical_usd
        if cache.notice:
            err.print(Text(cache.notice, style="yellow"))

        # 4. The plan, and the cost guard's say.
        out.print(
            Panel(
                plan_table(
                    model=model_name,
                    provider_label=bot.label,
                    local=bot.local,
                    exact=target.model_version,
                    details=info.details,
                    traps=len(traps),
                    traps_in_library=len(library.traps),
                    by_type={TYPE_INFO[k].label: v for k, v in _type_counts(traps).items()},
                    fingerprint=library.fingerprint,
                    estimate=estimate,
                    fresh=fresh,
                    limit=max_cost,
                    max_output_tokens=options.max_output_tokens,
                    thinks=thinks,
                    at_once=at_once,
                ),
                title="Interrogation plan",
                title_align="left",
            )
        )
        _cost_check(estimate, guard, interrogator, yes=yes, estimate_only=estimate_only)
        if estimate_only:
            return

        # 5. The run.
        runs_folder = settings.runs_dir
        try:
            with display:
                asyncio.run(interrogator.run(save_folder=runs_folder))
        except KeyboardInterrupt:
            out.print(Text("\nStopped with Ctrl+C. What was finished has been saved.", style="bold yellow"))
            if interrogator.run_file is not None:
                out.print(summary_table(interrogator.run_file, _shown_path(interrogator.saved_path)))
            raise typer.Exit(code=130)
    finally:
        cache.close()

    # 6. The summary.
    run_file = interrogator.run_file
    assert run_file is not None
    status = run_file.run.status
    out.print()
    if status == "finished":
        out.print(Text("Interrogation finished.", style="bold green"))
    elif status == "stopped":
        out.print(Text(f"Interrogation stopped early. {run_file.run.stop_reason}", style="bold yellow"))
    else:
        out.print(Text(f"Interrogation failed. {run_file.run.stop_reason}", style="bold red"))
    out.print(summary_table(run_file, _shown_path(interrogator.saved_path)))
    out.print(Text("Not judged yet: the verdicts and scores in the run file are empty for now.", style="dim"))
    if status == "failed":
        if interrogator.aborted is not None and interrogator.aborted.problem.hint:
            err.print(Text(interrogator.aborted.problem.hint))
        raise typer.Exit(code=1)
    if status == "stopped":
        out.print(Text("To allow more, run it again with a higher --max-cost.", style="yellow"))


def _select_traps(library, trap_types: list[str] | None, trap_ids: list[str] | None) -> list:
    traps = list(library.traps)
    if trap_types:
        kinds = set()
        for raw in (part for value in trap_types for part in value.split(",")):
            if not raw.strip():
                continue
            kind = find_type(raw)
            if kind is None:
                names = ", ".join(info.id_prefix for info in TYPE_INFO.values())
                err.print(Text(f"'{raw.strip()}' isn't a trap type. Try one of: {names}", style="bold red"))
                raise typer.Exit(code=2)
            kinds.add(kind)
        traps = [trap for trap in traps if trap.kind in kinds]
    if trap_ids:
        wanted = [part.strip().lower() for value in trap_ids for part in value.split(",") if part.strip()]
        missing = [trap_id for trap_id in wanted if library.find(trap_id) is None]
        if missing:
            err.print(Text(f"There's no trap called {', '.join(missing)}. IDs look like ghost-001.", style="bold red"))
            raise typer.Exit(code=2)
        traps = [trap for trap in traps if trap.id in wanted]
    if not traps:
        err.print(Text("No traps match that choice.", style="bold red"))
        raise typer.Exit(code=2)
    return traps


def _type_counts(traps: list) -> dict:
    counts: dict = {}
    for trap in traps:
        counts[trap.kind] = counts.get(trap.kind, 0) + 1
    return counts


def _prices(
    bot: Provider, name: str, model: str, known, price_in: float | None, price_out: float | None
) -> Prices:
    if (price_in is None) != (price_out is None):
        err.print(Text("Give both --price-in and --price-out, or neither.", style="bold red"))
        raise typer.Exit(code=2)
    if price_in is not None and price_out is not None:
        return Prices(price_in, price_out, source="the prices you gave (--price-in and --price-out)")
    if bot.local:
        return FREE
    if known is not None:
        return known.prices()
    where = f" ({SOURCES[name]})" if name in SOURCES else ""
    err.print(Text(f"Polygraph doesn't know what {model} costs, so the cost guard can't protect you.", style="bold red"))
    err.print(
        Text(
            f"Look up its price per million tokens on the provider's pricing page{where}, then add "
            "--price-in and --price-out, like: --price-in 0.50 --price-out 1.50"
        )
    )
    raise typer.Exit(code=1)


def _cost_check(estimate, guard: CostGuard, interrogator: Interrogator, *, yes: bool, estimate_only: bool) -> None:
    """The cost guard's say before anything is spent."""
    typical = estimate.typical_usd or 0.0
    if typical > guard.limit:
        suggestion = estimate.suggested_limit()
        out.print(
            Text(
                f"This run will probably cost about {format_usd(typical)}, which is more than the "
                f"${guard.limit:.2f} limit.",
                style="bold yellow",
            )
        )
        if estimate_only:
            out.print(Text(f"To allow it, run it with --max-cost {suggestion:g}"))
            return
        if _interactive() and not yes:
            if typer.confirm(f"Allow up to ${suggestion:.2f} for this run?", default=False):
                guard.limit = suggestion
                interrogator.limit_usd = suggestion
                out.print(Text(f"The limit for this run is now ${suggestion:.2f}.", style="yellow"))
                return
        out.print(Text(f"Nothing was spent. To allow it, run it again with --max-cost {suggestion:g}"))
        raise typer.Exit(code=1)
    if estimate_only or yes or typical == 0 or estimate.calls_to_send == 0:
        return
    if _interactive():
        if typer.confirm(f"Start? This should cost about {format_usd(typical)}.", default=False):
            return
        out.print(Text("Nothing was spent."))
        raise typer.Exit(code=0)
    out.print(Text("This run costs money. To start it without being asked, add --yes."))
    raise typer.Exit(code=1)


def _shown_path(path: Path | None) -> str | None:
    if path is None:
        return None
    try:
        return str(path.resolve().relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(path)


# --- polygraph models ----------------------------------------------------------


@app.command()
def models(
    provider: Annotated[
        Optional[str],
        typer.Argument(help="ollama, openai, anthropic, google or compatible. Leave it out to see them all."),
    ] = None,
    show_all: Annotated[bool, typer.Option("--all", help="Also show models that are shutting down.")] = False,
) -> None:
    """List models and what they cost, including the live list from each provider you have a key for."""
    settings = load_settings()
    if provider:
        name = provider_name(provider)
        if name is None:
            err.print(Text(f"'{provider}' isn't a provider Polygraph knows. Use one of: {', '.join(PROVIDER_NAMES)}", style="bold red"))
            raise typer.Exit(code=2)
        names = [name]
    else:
        names = list(PROVIDER_NAMES)
    for name in names:
        _show_models(name, settings, show_all=show_all, live=provider is not None or name == "ollama")


_HEADINGS = {
    "ollama": "Ollama (free, runs on this PC)",
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "compatible": "OpenAI-compatible services",
}


def _show_models(name: str, settings: Settings, *, show_all: bool, live: bool) -> None:
    out.print()
    out.print(Text(_HEADINGS[name], style="bold underline"))
    try:
        bot = make_provider(name, settings)
    except SetupError as problem:
        if name != "compatible":
            out.print(Text(f"No API key yet. {problem.hint}", style="dim"))
        else:
            out.print(Text("Not set up. Use --base-url with polygraph run, or set OPENAI_COMPATIBLE_BASE_URL in .env.", style="dim"))
        bot = None

    catalog = [m for m in models_for(name) if show_all or m.status != "deprecated"]
    if catalog:
        table = Table(box=None, pad_edge=False, header_style="bold")
        table.add_column("Model")
        table.add_column("$ in", justify="right")
        table.add_column("$ out", justify="right")
        table.add_column("Thinks", justify="center")
        table.add_column("Notes", style="dim")
        for known in catalog:
            prices = known.prices()
            note = known.note
            if known.model == CHEAPEST.get(name):
                note = (note + " Used when you don't pick a model.").strip()
            if known.status != "current":
                note = f"({known.status}) {note}".strip()
            table.add_row(
                known.model,
                f"{prices.input_per_million:g}",
                f"{prices.output_per_million:g}",
                "yes" if known.reasoning else "no",
                note,
            )
        out.print(table)
        out.print(
            Text(
                f"Prices are US dollars per million tokens, from {SOURCES[name]}, checked {PRICES_CHECKED_ON}.",
                style="dim",
            )
        )

    if bot is None or not live:
        if bot is not None and not live:
            out.print(Text(f"For the live list from {LABELS[name]}: polygraph models {name}", style="dim"))
        return
    try:
        with err.status(f"Asking {bot.label} for its model list..."):
            found = asyncio.run(bot.list_models())
    except ProviderError as problem:
        _explain(problem)
        return
    if not found:
        out.print(Text("No models found.", style="dim"))
        return
    title = "Downloaded models:" if name == "ollama" else f"Live list from {bot.label} ({len(found)} models):"
    out.print(Text(title, style="bold"))
    for info in found:
        line = Text(f"  {info.name}")
        extra = [str(info.details[k]) for k in ("parameter_size", "quantization_level") if info.details.get(k)]
        if extra:
            line.append(f"  ({', '.join(extra)})", style="dim")
        elif name in SOURCES and find_known(name, info.name) is None:
            line.append("  (price not known: use --price-in and --price-out)", style="dim")
        out.print(line)


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
    out.print(traps_summary_table(library))

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
