"""Planning a live run from the dashboard's choices (Session 8): which bot,
which judge, which traps, what it will cost, and plain-English problems.

Everything is set up exactly like `polygraph run` followed by `polygraph
judge`: the same answer length limits, the same prices, the same cache, the
same judge rules (from a different company than the bot, 3 votes each) and
the same rubric. Only the dashboard's choices differ.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from polygraph.config import Settings
from polygraph.interrogator import (
    CONFIDENCE_QUESTION,
    DEFAULT_LIMIT_USD,
    Caller,
    CostGuard,
    Estimate,
    Interrogator,
    ResponseCache,
    plan_conversations,
)
from polygraph.interrogator.costs import (
    CHARS_PER_TOKEN,
    TYPICAL_ANSWER_TOKENS,
    typical_input_tokens,
    worst_case_input_tokens,
)
from polygraph.judges import DEFAULT_JUDGES, INSTRUCTIONS, JUDGE_PREFERENCE, PROVIDER_COMPANIES, AIJudge, company_of, same_company
from polygraph.judges.pipeline import TYPICAL_JUDGE_THINKING_TOKENS, TYPICAL_VERDICT_TOKENS
from polygraph.limits import DEFAULT_VOTES, JUDGE_PLAIN_LIMIT, JUDGE_THINKING_LIMIT, PLAIN_LIMIT, THINKING_LIMIT
from polygraph.pricing import FREE, Prices
from polygraph.providers import KNOWN_MODELS, ChatOptions, Provider, ProviderError, SetupError, find_known, make_provider
from polygraph.providers.factory import LABELS
from polygraph.runfile import CallInfo, Conversation, DocumentCopy, Target, TrapResult, Turn
from polygraph.traps import TYPE_INFO, Library, Trap, TrapLibraryError, TrapType, load_library

# The most a run started from the dashboard may be allowed to spend.
MAX_LIMIT_USD = 50.0
# Providers the dashboard can test. OpenAI-compatible services need a web
# address and prices, so they stay with `polygraph run` for now.
DASHBOARD_PROVIDERS = ("ollama", "openai", "anthropic", "google")
KEY_SETTINGS = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY", "google": "GEMINI_API_KEY"}

ProviderFactory = Callable[[str, Settings], Provider]


class Problem(Exception):
    """Something the person has to know or fix, in plain English, for the dashboard."""

    def __init__(self, title: str, message: str, hint: str | None = None, *, kind: str = "setup", status: int = 400) -> None:
        super().__init__(message)
        self.title = title
        self.message = message
        self.hint = hint
        self.kind = kind
        self.status = status

    def as_dict(self) -> dict[str, Any]:
        return {"title": self.title, "message": self.message, "hint": self.hint, "kind": self.kind}


PROBLEM_TITLES = {
    "auth": "The API key didn't work",
    "quota": "Out of credit",
    "not_found": "Model not found",
    "network": "Can't connect",
    "timeout": "No answer in time",
    "rate_limit": "Too many requests",
    "overloaded": "The service is busy",
    "bad_request": "The question was refused",
    "unreadable": "An answer Polygraph couldn't read",
}


def problem_from(error: ProviderError | SetupError, who: str | None = None) -> Problem:
    """A provider's error, as a Problem the dashboard can show. Provider
    messages are already worded for people and never contain a key."""
    if isinstance(error, SetupError):
        title = "An API key is needed" if "API key" in error.message else "Something has to be set up first"
        return Problem(title, error.message, error.hint, kind="setup")
    title = PROBLEM_TITLES.get(error.kind, "Something went wrong")
    if error.kind == "network" and "Ollama" in error.message:
        title = "Ollama isn't running"
    if error.kind == "network" and not error.hint:
        error.hint = "Check your internet connection, then try again."
    if who:
        title = f"{title} ({who})"
    return Problem(title, error.message, error.hint, kind=error.kind)


class OwnBot(BaseModel):
    """Test your own bot: a model plus its owner's instructions (a system prompt)."""

    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=60)
    instructions: str = Field(min_length=1, max_length=20_000)


class Choices(BaseModel):
    """What the person picked on the New interrogation screen."""

    model_config = ConfigDict(extra="forbid")
    bot_provider: str = Field(min_length=1, max_length=40)
    bot_model: str = Field(min_length=1, max_length=200)
    judge_provider: str | None = Field(default=None, max_length=40)
    judge_model: str | None = Field(default=None, max_length=200)
    types: list[str] = Field(default_factory=list, max_length=8)  # empty: all 8
    # None: ask every question again for a model on this PC (free, and you get
    # to watch it answer); reuse saved answers for a cloud model (free).
    fresh: bool | None = None
    own_bot: OwnBot | None = None
    max_cost: float = Field(default=DEFAULT_LIMIT_USD, gt=0, le=MAX_LIMIT_USD)


@dataclass
class Side:
    """The bot, or the judge."""

    provider_name: str
    provider: Provider
    model: str
    label: str  # the provider's name, like "Ollama"
    company: str
    prices: Prices
    thinks: bool
    options: ChatOptions
    version: str | None
    details: dict[str, Any]


@dataclass
class Plan:
    choices: Choices
    library: Library
    traps: list[Trap]
    bot: Side
    bot_company_from: str
    judge: Side
    fresh: bool
    votes: int = DEFAULT_VOTES

    @property
    def instructions(self) -> str | None:
        own = self.choices.own_bot
        return own.instructions.strip() if own and own.instructions.strip() else None

    @property
    def bot_name(self) -> str | None:
        own = self.choices.own_bot
        return own.name.strip() if own else None

    def target(self) -> Target:
        return Target(
            provider=self.bot.provider_name,
            provider_label=self.bot.label,
            model=self.bot.model,
            model_version=self.bot.version if self.bot.provider_name == "ollama" else None,
            model_details=self.bot.details,
            endpoint=self.bot.provider.endpoint,
            system_prompt=self.instructions,
            name=self.bot_name,
            settings={
                "max_output_tokens": self.bot.options.max_output_tokens,
                "temperature": self.bot.options.temperature,
                "thinking": "the model's default",
            },
        )


@dataclass
class PlanEstimate:
    bot: Estimate
    judge: Estimate

    @property
    def typical_usd(self) -> float:
        return (self.bot.typical_usd or 0.0) + (self.judge.typical_usd or 0.0)

    @property
    def worst_single_call_usd(self) -> float:
        return max(self.bot.worst_single_call_usd, self.judge.worst_single_call_usd)

    def suggested_limit(self) -> float:
        """Like Estimate.suggested_limit(), for the bot and the judge together."""
        needed = self.typical_usd * 1.25 + self.worst_single_call_usd
        return max(DEFAULT_LIMIT_USD, math.ceil(needed * 2) / 2)


def select_traps(library: Library, types: list[str]) -> list[Trap]:
    if not types:
        return list(library.traps)
    known = {kind.value for kind in TYPE_INFO}
    unknown = sorted(set(types) - known)
    if unknown:
        raise Problem("Unknown trap type", f"Polygraph has no trap type called {', '.join(unknown)}.")
    wanted = set(types)
    return [trap for trap in library.traps if trap.kind.value in wanted]


def _prices(provider: Provider, provider_name: str, model: str, what: str) -> tuple[Prices, bool]:
    """(prices, thinks). A model whose price isn't known can't be guarded, so it's refused."""
    known = find_known(provider_name, model)
    thinks = bool(known and known.reasoning)
    if provider.local:
        return FREE, thinks
    if known is None:
        raise Problem(
            "Unknown price",
            f"Polygraph doesn't know what {model} costs, so the cost guard couldn't protect you.",
            f"Pick {what} from the list, or use polygraph run in the run tab with --price-in and --price-out.",
        )
    return known.prices(), thinks


def _provider(name: str, settings: Settings, factory: ProviderFactory) -> Provider:
    if name not in DASHBOARD_PROVIDERS:
        raise Problem(
            "Not available here",
            f"The dashboard can't test models from '{name}'.",
            "For OpenAI-compatible services, use polygraph run in the run tab.",
        )
    try:
        return factory(name, settings)
    except SetupError as problem:
        raise problem_from(problem) from problem


def default_judge(settings: Settings, bot_company: str) -> tuple[str, str]:
    """The judge Polygraph picks by itself: the cheapest thinking model from the
    first company you have a key for that didn't make the bot (as `polygraph judge` does)."""
    keys = {"openai": settings.openai_api_key, "anthropic": settings.anthropic_api_key, "google": settings.gemini_api_key}
    available = [provider for provider in JUDGE_PREFERENCE if keys[provider] is not None]
    for provider in available:
        if not same_company(PROVIDER_COMPANIES[provider], bot_company):
            return provider, DEFAULT_JUDGES[provider]
    others = [f"{DEFAULT_JUDGES[p]} ({PROVIDER_COMPANIES[p]})" for p in JUDGE_PREFERENCE if not same_company(PROVIDER_COMPANIES[p], bot_company)]
    if not available:
        raise Problem(
            "A judge needs an API key",
            "To judge a run, Polygraph needs an API key from OpenAI, Anthropic or Google.",
            "Make a key on one of their websites and set a spending limit there. Then, in the run tab, run notepad .env, "
            "paste the key after OPENAI_API_KEY=, ANTHROPIC_API_KEY= or GEMINI_API_KEY=, and save.",
        )
    raise Problem(
        "No judge from another company",
        f"This bot was made by {bot_company}, and the only judge you have a key for is made by {bot_company} too. "
        "A bot can't be judged by its own company.",
        f"Add a key for one of these to .env: {', '.join(others)}.",
    )


async def make_plan(
    choices: Choices,
    settings: Settings,
    *,
    folder: Path,
    factory: ProviderFactory = make_provider,
) -> Plan:
    """Check every choice and set the run up, or raise a Problem saying what's
    wrong. Checking the models costs nothing."""
    try:
        library = load_library(folder)
    except TrapLibraryError as problem:
        raise Problem("The trap library has a problem", str(problem).splitlines()[0], "Run polygraph traps check in the run tab.") from problem
    traps = select_traps(library, choices.types)
    if not traps:
        raise Problem("No traps picked", "Pick at least one trap type.")

    # The bot.
    bot_provider = _provider(choices.bot_provider, settings, factory)
    model = choices.bot_model.strip()
    bot_prices, bot_thinks = _prices(bot_provider, choices.bot_provider, model, "a model")
    try:
        info = await bot_provider.describe_model(model)
    except ProviderError as problem:
        raise problem_from(problem) from problem
    bot_company = company_of(choices.bot_provider, model, info.details)
    if bot_company is None:
        raise Problem(
            "Unknown maker",
            f"Polygraph can't tell which company made {model}, so it can't make sure the judge comes from a different company.",
            'Use polygraph run, then polygraph judge with --bot-maker (like --bot-maker "Mistral AI"), in the run tab.',
        )
    bot = Side(
        provider_name=choices.bot_provider,
        provider=bot_provider,
        model=model,
        label=bot_provider.label,
        company=bot_company,
        prices=bot_prices,
        thinks=bot_thinks,
        options=ChatOptions(max_output_tokens=THINKING_LIMIT if bot_thinks else PLAIN_LIMIT),
        version=info.version,
        details=dict(info.details),
    )

    # The judge: from a different company than the bot.
    if choices.judge_model and choices.judge_model.strip():
        judge_name = choices.judge_provider or ""
        judge_model = choices.judge_model.strip()
    else:
        judge_name, judge_model = default_judge(settings, bot_company)
    judge_provider = _provider(judge_name, settings, factory)
    judge_company = company_of(judge_name, judge_model)
    if judge_company is None or judge_name == "ollama":
        raise Problem("Pick another judge", f"{judge_model} can't be a judge here.", "Pick a judge from OpenAI, Anthropic or Google.")
    if same_company(judge_company, bot_company):
        raise Problem(
            "Pick a judge from another company",
            f"{model} and {judge_model} are both made by {bot_company}. A judge could go easy on its own company's model.",
            "Pick a judge made by a different company.",
        )
    judge_prices, judge_thinks = _prices(judge_provider, judge_name, judge_model, "a judge")
    try:
        judge_info = await judge_provider.describe_model(judge_model)
    except ProviderError as problem:
        raise problem_from(problem, who="the judge") from problem
    judge = Side(
        provider_name=judge_name,
        provider=judge_provider,
        model=judge_model,
        label=judge_provider.label,
        company=judge_company,
        prices=judge_prices,
        thinks=judge_thinks,
        options=ChatOptions(max_output_tokens=JUDGE_THINKING_LIMIT if judge_thinks else JUDGE_PLAIN_LIMIT),
        version=judge_info.version,
        details=dict(judge_info.details),
    )
    company_from = "the provider" if choices.bot_provider in PROVIDER_COMPANIES else "the model's name"
    fresh = bot_provider.local if choices.fresh is None else choices.fresh
    return Plan(choices=choices, library=library, traps=traps, bot=bot, bot_company_from=company_from, judge=judge, fresh=fresh)


def bot_caller(plan: Plan, cache: ResponseCache | None, guard: CostGuard, **extra: Any) -> Caller:
    return Caller(
        plan.bot.provider,
        plan.bot.model,
        prices=plan.bot.prices,
        guard=guard,
        options=plan.bot.options,
        cache=cache,
        read_cache=not plan.fresh,
        concurrency=1,
        system_prompt=plan.instructions,
        version_pin=plan.bot.version,
        **extra,
    )


def judge_caller(plan: Plan, cache: ResponseCache | None, guard: CostGuard, **extra: Any) -> Caller:
    return Caller(
        plan.judge.provider,
        plan.judge.model,
        prices=plan.judge.prices,
        guard=guard,
        options=plan.judge.options,
        cache=cache,
        read_cache=True,
        concurrency=1,
        system_prompt=INSTRUCTIONS,
        **extra,
    )


def estimate(plan: Plan, cache: ResponseCache | None) -> PlanEstimate:
    """What the run should cost: the bot (counting saved answers as free) and
    the judge. The judge's part is a little high when answers are reused,
    because their verdicts are usually saved too."""
    guard = CostGuard(plan.choices.max_cost)
    caller = bot_caller(plan, cache, guard)
    interrogator = Interrogator(
        caller=caller,
        library=plan.library,
        traps=plan.traps,
        target=plan.target(),
        limit_usd=plan.choices.max_cost,
        prices=plan.bot.prices,
        thinks=plan.bot.thinks,
        concurrency=1,
    )
    return PlanEstimate(bot=interrogator.estimate(), judge=judging_estimate(plan, judge_caller(plan, None, guard)))


def judging_estimate(plan: Plan, caller: Caller) -> Estimate:
    """The judge's cost before any answer exists: every trap judged by the AI
    judge (some will be settled by a hard check for free), each answer of a
    typical length, each vote its own question."""
    estimate = Estimate(prices=plan.judge.prices)
    judge = AIJudge(caller, structured=plan.judge.provider_name == "openai")
    documents = {doc_id: DocumentCopy(title=doc.title, text=doc.text) for doc_id, doc in plan.library.documents.items()}
    typical_answer = "word " * (TYPICAL_ANSWER_TOKENS * CHARS_PER_TOKEN // 5)
    out_typical = TYPICAL_VERDICT_TOKENS + (TYPICAL_JUDGE_THINKING_TOKENS if plan.judge.thinks else 0)
    out_most = plan.judge.options.max_output_tokens
    for trap in plan.traps:
        result = placeholder_result(trap, plan.library, typical_answer)
        answers = sum(1 for chat in result.conversations for turn in chat.turns if turn.kind == "answer")
        seen = caller.conversation(judge.messages(result, documents, None, plan.instructions))
        worst_in = worst_case_input_tokens(seen) + answers * plan.bot.options.max_output_tokens
        for _ in range(plan.votes):
            estimate.calls += 1
            estimate.typical_input_tokens += typical_input_tokens(seen)
            estimate.typical_output_tokens += out_typical
            estimate.worst_input_tokens += worst_in
            estimate.worst_output_tokens += out_most
        if plan.judge.prices is not None:
            estimate.worst_single_call_usd = max(estimate.worst_single_call_usd, plan.judge.prices.cost(worst_in, out_most))
    return estimate


def placeholder_result(trap: Trap, library: Library, answer_text: str) -> TrapResult:
    """A trap result with made-up answers of a given length, only for estimating."""
    conversations = []
    for plan in plan_conversations(trap, library.documents):
        turns: list[Turn] = []
        for kind, text in plan.turns:
            turns.append(Turn(role="user", kind=kind, content=text))
            turns.append(Turn(role="assistant", kind="answer", content=answer_text, call=CallInfo(first_collected_at="")))
        conversations.append(Conversation(wording=plan.wording, turns=turns))
    return TrapResult(
        id=trap.id,
        type=trap.kind.value,
        label=TYPE_INFO[trap.kind].label,
        status="done",
        trap=trap.model_dump(mode="json"),
        conversations=conversations,
    )


def estimate_dict(plan: Plan, numbers: PlanEstimate) -> dict[str, Any]:
    """The plan and its cost, for the New interrogation screen."""
    bot, judge = numbers.bot, numbers.judge
    typical = numbers.typical_usd
    limit = plan.choices.max_cost
    by_type: dict[str, int] = {}
    for trap in plan.traps:
        by_type[trap.kind.value] = by_type.get(trap.kind.value, 0) + 1
    return {
        "bot": {
            "provider": plan.bot.provider_name,
            "provider_label": plan.bot.label,
            "model": plan.bot.model,
            "maker": plan.bot.company,
            "local": plan.bot.provider.local,
            "name": plan.bot_name,
            "version": plan.bot.version,
            "size": plan.bot.details.get("parameter_size"),
        },
        "judge": {
            "provider": plan.judge.provider_name,
            "provider_label": plan.judge.label,
            "model": plan.judge.model,
            "maker": plan.judge.company,
            "votes": plan.votes,
        },
        "traps": len(plan.traps),
        "by_type": by_type,
        "fresh": plan.fresh,
        "questions": bot.calls,  # answers plus confidence questions
        "saved": bot.cached_calls,
        "judge_questions": judge.calls,
        "bot_usd": bot.typical_usd or 0.0,
        "judge_usd": judge.typical_usd or 0.0,
        "typical_usd": typical,
        "limit_usd": limit,
        "over_limit": typical > limit,
        "suggested_limit_usd": numbers.suggested_limit(),
        "free": typical == 0,
        "confidence_question": CONFIDENCE_QUESTION,
    }


async def options(settings: Settings, library: Library, factory: ProviderFactory = make_provider) -> dict[str, Any]:
    """Everything the New interrogation screen offers: models on this PC, cloud
    models (each marked whether its key is in .env), judges and trap types."""
    keys = {
        "openai": settings.openai_api_key is not None,
        "anthropic": settings.anthropic_api_key is not None,
        "google": settings.gemini_api_key is not None,
    }
    bots: list[dict[str, Any]] = []
    ollama: dict[str, Any] = {"ok": True, "problem": None}
    try:
        local = factory("ollama", settings)
        async with local:
            models = await local.list_models()
        for info in sorted(models, key=lambda m: m.name):
            name = info.name.removesuffix(":latest")
            bots.append(
                {
                    "provider": "ollama",
                    "model": name,
                    "maker": company_of("ollama", name, info.details),
                    "local": True,
                    "available": True,
                    "why_not": None,
                    "size": info.details.get("parameter_size"),
                    "price_in": 0.0,
                    "price_out": 0.0,
                }
            )
    except ProviderError as problem:
        ollama = {"ok": False, "problem": problem_from(problem).as_dict()}
    judges: list[dict[str, Any]] = []
    for known in KNOWN_MODELS:
        if known.status != "current":
            continue
        why_not = None if keys[known.provider] else f"Needs {KEY_SETTINGS[known.provider]} in .env"
        entry = {
            "provider": known.provider,
            "provider_label": LABELS[known.provider],
            "model": known.model,
            "maker": PROVIDER_COMPANIES[known.provider],
            "local": False,
            "available": why_not is None,
            "why_not": why_not,
            "price_in": known.prices().input_per_million,
            "price_out": known.prices().output_per_million,
            "thinks": known.reasoning,
            "note": known.note,
        }
        bots.append(entry)
        judges.append({**entry, "default": DEFAULT_JUDGES.get(known.provider) == known.model})
    counts: dict[str, int] = {}
    for trap in library.traps:
        counts[trap.kind.value] = counts.get(trap.kind.value, 0) + 1
    trap_types = [{"type": kind.value, "label": info.label, "count": counts.get(kind.value, 0)} for kind, info in TYPE_INFO.items()]
    return {
        "bots": bots,
        "judges": judges,
        "trap_types": trap_types,
        "ollama": ollama,
        "keys": keys,
        "limit_usd": DEFAULT_LIMIT_USD,
        "max_limit_usd": MAX_LIMIT_USD,
        "votes": DEFAULT_VOTES,
    }


__all__ = [
    "MAX_LIMIT_USD",
    "Choices",
    "OwnBot",
    "Plan",
    "PlanEstimate",
    "Problem",
    "Side",
    "TrapType",
    "default_judge",
    "estimate",
    "estimate_dict",
    "make_plan",
    "options",
    "problem_from",
]
