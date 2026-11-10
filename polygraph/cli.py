"""The `polygraph` command."""

from __future__ import annotations

import asyncio
import datetime
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
    RunAborted,
)
from polygraph.judges import (
    DEFAULT_JUDGES,
    INSTRUCTIONS,
    JUDGE_PREFERENCE,
    PROVIDER_COMPANIES,
    AIJudge,
    JudgeSetup,
    Lookup,
    ReferenceCache,
    RunJudge,
    company_of,
    fingerprint,
    judged_copies,
    judged_path,
    known_company,
    same_company,
)
from polygraph.judges.pipeline import LEFT_OUT
from polygraph.judgecheck.commands import agreement as agreement_command
from polygraph.judgecheck.commands import label_app
from polygraph.pricing import FREE, Prices, format_usd
from polygraph.progress import JudgeDisplay, RunDisplay, plan_table, summary_table
from polygraph.report import pick_sample, report_card, trap_detail, verdict_list
from polygraph.scoring import score_run
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
    guess_provider,
    make_provider,
    provider_name,
)
from polygraph.providers.catalog import SOURCES, models_for
from polygraph.runfile import RunFile, Target, load_run, save_run
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
    if interrogator.saved_path is not None and status != "failed":
        out.print(Text(f"Next, judge it: polygraph judge {_shown_path(interrogator.saved_path)}", style="bold"))
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


def _cost_check(estimate, guard: CostGuard, job, *, yes: bool, estimate_only: bool, what: str = "This run") -> None:
    """The cost guard's say before anything is spent. `job` is the
    Interrogator or the RunJudge: anything with a limit_usd."""
    typical = estimate.typical_usd or 0.0
    if typical > guard.limit:
        suggestion = estimate.suggested_limit()
        out.print(
            Text(
                f"{what} will probably cost about {format_usd(typical)}, which is more than the "
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
                job.limit_usd = suggestion
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


# --- polygraph judge -----------------------------------------------------------

# The judge's reply is short, but a judge that thinks first spends part of its
# limit thinking, so it gets room for that.
JUDGE_THINKING_LIMIT = 16_384
JUDGE_PLAIN_LIMIT = 2_048
JUDGE_CONCURRENCY = 4
CARD_WIDTH = 104
# The AI judge can give a different verdict when asked the same thing again,
# so by default it judges each trap 3 times and the majority wins (Session 5).
# The judge check measured its agreement with Christian's labels this way.
DEFAULT_VOTES = 3

RunPathArgument = Annotated[
    Path,
    typer.Argument(help="A run file, like runs/2026-11-08_21-51-00_ollama_llama3.2.json", show_default=False),
]


def _load_run_file(path: Path) -> RunFile:
    if not path.is_file():
        err.print(Text(f"There's no run file at {path}.", style="bold red"))
        folder = path.parent if str(path.parent) not in ("", ".") else Path("runs")
        err.print(Text(f"To see the run files, run: dir {folder}"))
        raise typer.Exit(code=1)
    try:
        return load_run(path)
    except (ValueError, OSError) as problem:
        first = str(problem).splitlines()[0] if str(problem) else type(problem).__name__
        err.print(Text(f"{path} isn't a Polygraph run file Polygraph can read ({first}).", style="bold red"))
        raise typer.Exit(code=1)


def _bot_company(run_file: RunFile, bot_maker: str | None) -> tuple[str, str]:
    """Who made the bot, and how Polygraph knows."""
    target = run_file.run.target
    if bot_maker and bot_maker.strip():
        return known_company(bot_maker) or bot_maker.strip(), "--bot-maker"
    company = company_of(target.provider, target.model, target.model_details)
    if company is None:
        err.print(
            Text(
                f"Polygraph can't tell which company made {target.model}, so it can't make sure the judge "
                "comes from a different company.",
                style="bold red",
            )
        )
        err.print(Text('Say who made it with --bot-maker, like: --bot-maker "Mistral AI"'))
        raise typer.Exit(code=1)
    return company, "the provider" if target.provider in PROVIDER_COMPANIES else "the model's name"


def _other_judges(bot_company: str) -> str:
    names = [f"{DEFAULT_JUDGES[p]} ({PROVIDER_COMPANIES[p]})" for p in JUDGE_PREFERENCE if not same_company(PROVIDER_COMPANIES[p], bot_company)]
    return ", ".join(names[:-1]) + " or " + names[-1] if len(names) > 1 else (names[0] if names else "")


def _choose_judge(judge_model: str | None, settings: Settings, bot_company: str) -> tuple[str, str]:
    """(provider, model) for the judge: the one asked for, or the cheapest
    thinking model from the first company you have a key for that didn't make
    the bot."""
    if judge_model and judge_model.strip():
        return guess_provider(judge_model.strip()), judge_model.strip()
    keys = {"openai": settings.openai_api_key, "anthropic": settings.anthropic_api_key, "google": settings.gemini_api_key}
    available = [provider for provider in JUDGE_PREFERENCE if keys[provider] is not None]
    for provider in available:
        if not same_company(PROVIDER_COMPANIES[provider], bot_company):
            return provider, DEFAULT_JUDGES[provider]
    if not available:
        err.print(Text("To judge a run, Polygraph needs an API key from OpenAI, Anthropic or Google.", style="bold red"))
        err.print(
            Text(
                "Make a key on one of their websites and set a spending limit there. Then, in the run tab, run "
                "notepad .env, paste the key after OPENAI_API_KEY=, ANTHROPIC_API_KEY= or GEMINI_API_KEY=, and save."
            )
        )
    else:
        err.print(
            Text(
                f"The bot was made by {bot_company}, and the only judge you have a key for is made by "
                f"{bot_company} too. The judge has to come from a different company.",
                style="bold red",
            )
        )
        err.print(Text(f"Add a key for one of these to .env: {_other_judges(bot_company)}."))
    raise typer.Exit(code=1)


async def _hard_checks(job: RunJudge, references: ReferenceCache, fresh: bool) -> None:
    async with Lookup(references, read_cache=not fresh) as lookup:
        job.lookup = lookup
        try:
            await job.hard_checks()
        finally:
            job.lookup = None


def _judge_plan(job: RunJudge, run_path: Path, estimate, *, fresh: bool, limit: float, thinks: bool) -> Table:
    run_file, setup = job.run_file, job.setup
    table = Table.grid(padding=(0, 2))
    table.add_column(style="bold")
    table.add_column()
    table.add_row("Run", f"{_shown_path(run_path)} · {len(run_file.traps)} traps")
    bot_from = "you said so with --bot-maker" if setup.bot_company_from == "--bot-maker" else f"from {setup.bot_company_from}"
    table.add_row("Bot", f"{run_file.run.target.model} via {run_file.run.target.provider_label} · made by {setup.bot_company} ({bot_from})")
    table.add_row("Judge", f"{setup.model} via {setup.provider_label} · made by {setup.company}: a different company")
    lines = []
    for kind, label in (("answer_key", "number traps checked against the answer key"), ("references", "fake-citation traps: every reference looked up"), ("side_by_side", "consistency traps lined up side by side")):
        jobs = [j for j in job.jobs if j.hard_check is not None and j.hard_check.kind == kind]
        if not jobs:
            continue
        caught = sum(j.decided is not None for j in jobs)
        text = f"{len(jobs)} {label}"
        if kind == "references":
            refs = sum(len(j.hard_check.details.get("references", [])) for j in jobs)
            text += f" ({refs} references)"
        if kind != "side_by_side":
            text += f": {caught} caught with no AI"
        lines.append(text)
    errors = [j for j in job.jobs if j.error and j.error != LEFT_OUT]
    if errors:
        lines.append(f"{len(errors)} trap{'s' if len(errors) != 1 else ''} can't be judged (see the report)")
    table.add_row("Hard checks", "\n".join(lines) if lines else "none in this run")
    ai = len(job.ai_jobs)
    if job.only is not None:
        table.add_row("Only", f"{len(job.only)} trap{'s' if len(job.only) != 1 else ''} chosen with --trap; the rest stay unjudged")
    saved = "ignored (--fresh)" if fresh else f"{estimate.cached_calls} of {estimate.calls} already saved from earlier judging"
    asks = f"{ai} trap{'s' if ai != 1 else ''}" + (f" × {job.votes} votes = {ai * job.votes} replies" if job.votes > 1 else "")
    table.add_row("AI judge", f"{asks} · {saved}")
    if job.votes > 1:
        table.add_row(
            "Votes",
            f"{job.votes} per trap, each asked separately. The verdict is the majority. On a tie, 2 more are asked; "
            "if it's still tied, the milder verdict is used and flagged.",
        )
    prices = estimate.prices
    if prices is not None and not prices.free:
        checked = f", checked {prices.checked_on}" if prices.checked_on else ""
        table.add_row(
            "Cost",
            f"about {format_usd(estimate.typical_usd)} (${prices.input_per_million:g} in / "
            f"${prices.output_per_million:g} out per million tokens{checked})",
        )
    elif prices is not None:
        table.add_row("Cost", "free: the judge runs on your PC")
    table.add_row("Limit", f"${limit:.2f}. Judging stops before it could go over.")
    table.add_row("Rubric", f"fingerprint {fingerprint()}" + (" · the judge thinks before answering" if thinks else ""))
    return table


@app.command()
def judge(
    run_path: RunPathArgument,
    judge_model: Annotated[
        Optional[str],
        typer.Option(
            "--judge",
            "-j",
            help="The judge model, like gpt-6-luna, claude-haiku-5-5 or gemini-3.5-flash-lite. Default: the "
            "cheapest thinking model from the first company you have a key for that didn't make the bot.",
        ),
    ] = None,
    bot_maker: Annotated[
        Optional[str],
        typer.Option("--bot-maker", help="Who made the bot, when Polygraph can't tell from its name, like Meta or \"Mistral AI\"."),
    ] = None,
    max_cost: Annotated[
        float, typer.Option("--max-cost", min=0.0, help="The most judging may spend, in US dollars.")
    ] = DEFAULT_LIMIT_USD,
    yes: Annotated[bool, typer.Option("--yes", "-y", help="Start paid judging without asking first. Never raises the limit.")] = False,
    estimate_only: Annotated[
        bool, typer.Option("--estimate", help="Run the free hard checks, show the plan and the cost, then stop.")
    ] = False,
    fresh: Annotated[
        bool, typer.Option("--fresh", help="Ask the judge again and look references up again, instead of reusing saved results.")
    ] = False,
    price_in: Annotated[
        Optional[float],
        typer.Option("--price-in", min=0.0, help="For a judge Polygraph doesn't know: dollars per million input tokens."),
    ] = None,
    price_out: Annotated[
        Optional[float], typer.Option("--price-out", min=0.0, help="... and dollars per million output tokens.")
    ] = None,
    votes: Annotated[
        int,
        typer.Option(
            "--votes",
            min=1,
            max=9,
            help="How many times the AI judge judges each trap, each time as a separate question. The verdict is "
            "the majority, and every vote is saved. Use an odd number.",
        ),
    ] = DEFAULT_VOTES,
    trap_ids: Annotated[
        Optional[list[str]],
        typer.Option("--trap", help="Judge only these traps, like ghost-003. Repeat it, or separate IDs with commas."),
    ] = None,
    out_folder: Annotated[
        Optional[Path],
        typer.Option("--out", help="Save the judged copy in this folder instead of next to the run file.", show_default=False),
    ] = None,
) -> None:
    """Judge a run: the hard checks first, then the AI judge, then the scores and the report card.

    The run file never changes: the verdicts go into a judged copy next to it.
    """
    settings = load_settings()
    run_file = _load_run_file(run_path)
    if votes % 2 == 0:
        err.print(Text(f"Use an odd number of votes, like 1, 3 or 5, so a majority usually decides. You asked for {votes}.", style="bold red"))
        raise typer.Exit(code=2)
    only: set[str] | None = None
    if trap_ids:
        only = {part.strip().lower() for value in trap_ids for part in value.split(",") if part.strip()}
        missing = sorted(only - {result.id for result in run_file.traps})
        if missing:
            err.print(Text(f"There's no trap called {', '.join(missing)} in this run. IDs look like ghost-001.", style="bold red"))
            raise typer.Exit(code=2)

    # 1. Who made the bot, and a judge from a different company.
    bot_company, bot_company_from = _bot_company(run_file, bot_maker)
    name, model_name = _choose_judge(judge_model, settings, bot_company)
    try:
        provider = make_provider(name, settings)
    except SetupError as problem:
        _explain(problem)
        raise typer.Exit(code=1)
    judge_company = company_of(name, model_name)
    if judge_company is None:
        err.print(Text(f"Polygraph can't tell which company made the judge {model_name}, so it won't use it.", style="bold red"))
        err.print(Text(f"Pick a judge like {_other_judges(bot_company)} with --judge."))
        raise typer.Exit(code=1)
    if same_company(judge_company, bot_company):
        err.print(
            Text(
                f"The judge can't come from the same company as the bot: {run_file.run.target.model} and "
                f"{model_name} are both made by {bot_company}. A judge could go easy on its own company's model.",
                style="bold red",
            )
        )
        err.print(Text(f"Pick a judge from another company with --judge, like {_other_judges(bot_company)}."))
        raise typer.Exit(code=1)
    known = find_known(name, model_name)
    prices = _prices(provider, name, model_name, known, price_in, price_out)
    thinks = bool(known and known.reasoning)
    options = ChatOptions(max_output_tokens=JUDGE_THINKING_LIMIT if thinks else JUDGE_PLAIN_LIMIT)

    # Check the judge model exists, and note its details. This costs nothing.
    try:
        with err.status(f"Checking {escape(model_name)}..."):
            info = asyncio.run(provider.describe_model(model_name))
    except ProviderError as problem:
        _explain(problem)
        raise typer.Exit(code=1)
    model_details = dict(info.details)
    if isinstance(model_details.get("created"), int):
        created = datetime.datetime.fromtimestamp(model_details["created"], tz=datetime.timezone.utc)
        model_details["created_on"] = created.date().isoformat()

    cache = ResponseCache(settings.cache_dir)
    references = ReferenceCache(settings.cache_dir)
    try:
        guard = CostGuard(max_cost)
        display = JudgeDisplay(out, total_traps=0, free=prices.free)
        caller = Caller(
            provider,
            model_name,
            prices=prices,
            guard=guard,
            options=options,
            cache=cache,
            read_cache=not fresh,
            concurrency=JUDGE_CONCURRENCY,
            system_prompt=INSTRUCTIONS,
            on_retry=display.retrying,
        )
        job = RunJudge(
            run_file,
            setup=JudgeSetup(
                provider=name,
                provider_label=provider.label,
                model=model_name,
                company=judge_company,
                bot_company=bot_company,
                bot_company_from=bot_company_from,
                model_details=model_details,
            ),
            judge=AIJudge(caller, structured=name == "openai"),
            lookup=None,
            limit_usd=max_cost,
            prices=prices,
            thinks=thinks,
            judged_from=run_path.name,
            listener=display,
            votes=votes,
            only=only,
        )

        # 2. The hard checks: free, but the reference check uses the internet.
        with err.status("Hard checks: comparing answers with the answer keys and looking references up in Crossref..."):
            asyncio.run(_hard_checks(job, references, fresh))

        # 3. The plan, and the cost guard's say.
        estimate = job.estimate()
        job.estimated_usd = estimate.typical_usd
        out.print(
            Panel(
                _judge_plan(job, run_path, estimate, fresh=fresh, limit=max_cost, thinks=thinks),
                title="Judging plan",
                title_align="left",
            )
        )
        _cost_check(estimate, guard, job, yes=yes, estimate_only=estimate_only, what="Judging")
        if estimate_only:
            return

        # 4. The AI judge.
        display.progress.update(display.task, total=len(job.ai_jobs))
        status, reason = "finished", None
        try:
            with display:
                asyncio.run(job.judge_all())
        except KeyboardInterrupt:
            status, reason = "cancelled", "Judging was stopped with Ctrl+C."
        except RunAborted as aborted:
            _explain(aborted.problem)
            err.print(Text("Nothing was saved. Fix the problem above, then judge the run again.", style="yellow"))
            raise typer.Exit(code=1)
        judged = job.finish(status, reason)
    finally:
        cache.close()
        references.close()

    # 5. Save the judged copy, then the report card.
    if out_folder is not None:
        out_folder.mkdir(parents=True, exist_ok=True)
    path = judged_path(out_folder / run_path.name if out_folder is not None else run_path, model_name)
    save_run(judged, path.parent, path)
    out.print()
    out.print(report_card(judged, width=min(out.width, CARD_WIDTH)))
    if judged.run.judge is not None and judged.run.judge.status != "finished":
        out.print(Text(f"Judging {judged.run.judge.status}: {judged.run.judge.stop_reason}", style="bold yellow"))
        out.print(Text("Judging again finishes the rest. Everything already judged is saved and free.", style="yellow"))
    out.print(Text(f"Saved the judged copy: {_shown_path(path)}", style="bold"))
    out.print(Text(f"To see it again: polygraph report {_shown_path(path)}", style="dim"))
    out.print(Text(f"Every verdict with its reason: polygraph report {_shown_path(path)} --verdicts", style="dim"))
    if status == "cancelled":
        raise typer.Exit(code=130)


# --- polygraph report ----------------------------------------------------------


@app.command()
def report(
    run_path: RunPathArgument,
    verdicts: Annotated[
        bool, typer.Option("--verdicts", help="Also list every verdict with its made-up phrase and reason.")
    ] = False,
    trap_ids: Annotated[
        Optional[list[str]],
        typer.Option("--trap", help="Show one trap in full instead, like ghost-003. Repeat it for more."),
    ] = None,
    sample: Annotated[
        Optional[int],
        typer.Option("--sample", min=1, help="Also show this many random verdicts, at least one of each type."),
    ] = None,
    seed: Annotated[
        Optional[int], typer.Option("--seed", help="Show an earlier random sample again, using the number it printed.")
    ] = None,
) -> None:
    """Print a judged run's report card. Free and instant.

    Give it the judged copy, or the original run file: then it shows the
    newest judged copy of that run.
    """
    run_file = _load_run_file(run_path)
    if run_file.run.judge is None and not any(result.verdict for result in run_file.traps):
        copies = judged_copies(run_path)
        if not copies:
            err.print(Text("This run hasn't been judged yet.", style="bold red"))
            err.print(Text(f"To judge it: polygraph judge {_shown_path(run_path)}"))
            raise typer.Exit(code=1)
        run_path = copies[0]
        err.print(Text(f"Showing the judged copy: {_shown_path(run_path)}", style="dim"))
        run_file = _load_run_file(run_path)
    if run_file.scores.overall is None and any(result.verdict for result in run_file.traps):
        run_file.scores = score_run(run_file)

    if trap_ids:
        wanted = [part.strip().lower() for value in trap_ids for part in value.split(",") if part.strip()]
        by_id = {result.id: result for result in run_file.traps}
        missing = [trap_id for trap_id in wanted if trap_id not in by_id]
        if missing:
            err.print(Text(f"There's no trap called {', '.join(missing)} in this run. IDs look like ghost-001.", style="bold red"))
            raise typer.Exit(code=2)
        for trap_id in wanted:
            out.print(trap_detail(by_id[trap_id], run_file))
        return

    out.print(report_card(run_file, width=min(out.width, CARD_WIDTH)))
    if verdicts:
        out.print()
        out.print(Text("Every verdict", style="bold underline"))
        out.print(verdict_list(run_file.traps))
    if sample is not None or seed is not None:
        if seed is None:
            seed = random.SystemRandom().randrange(1000, 10000)
        picked = pick_sample(run_file.traps, sample or 10, seed)
        out.print()
        again = f"polygraph report {_shown_path(run_path)} --sample {sample or 10} --seed {seed}"
        out.print(Text(f"{len(picked)} random verdicts (pick #{seed}). To see the same ones again: {again}", style="bold"))
        out.print(verdict_list(picked))


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

# --- polygraph label and polygraph agreement (Session 5: checking the judge) ----

app.add_typer(label_app, name="label")
app.command("agreement")(agreement_command)

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
