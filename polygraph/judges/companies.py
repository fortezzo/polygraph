"""Who made a model, so the judge never comes from the same company as the bot.

A judge from the company that made the bot could go easy on its own model, so
Polygraph refuses to run if they match (PLAN.md section 5).

- Models from a company's own API (OpenAI, Anthropic, Google) are made by that
  company.
- Open models that run in Ollama or on an OpenAI-compatible service are
  recognised by name: llama is Meta, gemma is Google, gpt-oss is OpenAI, and
  so on. Names like meta-llama/llama-3.3-70b also say who made them before the
  slash.
- If Polygraph can't tell, it refuses to guess: say who made the bot with
  --bot-maker.
"""

from __future__ import annotations

import re

# The company behind each cloud provider's own models.
PROVIDER_COMPANIES = {"openai": "OpenAI", "anthropic": "Anthropic", "google": "Google"}

# The judge Polygraph picks for each company when you don't choose one: each
# company's cheapest current model that thinks before answering.
DEFAULT_JUDGES = {"openai": "gpt-6-luna", "anthropic": "claude-haiku-5-5", "google": "gemini-3.5-flash-lite"}
# The order Polygraph tries them in when picking a judge by itself.
JUDGE_PREFERENCE = ("openai", "anthropic", "google")

# Model families, by the start of a word in the model's name. Longer names
# come first where one starts with another (gpt-oss before gpt).
FAMILIES: tuple[tuple[str, str], ...] = (
    ("gpt-oss", "OpenAI"),
    ("chatgpt", "OpenAI"),
    ("gpt", "OpenAI"),
    ("o1", "OpenAI"),
    ("o3", "OpenAI"),
    ("o4", "OpenAI"),
    ("claude", "Anthropic"),
    ("gemini", "Google"),
    ("gemma", "Google"),
    ("codegemma", "Google"),
    ("medgemma", "Google"),
    ("shieldgemma", "Google"),
    ("llama", "Meta"),
    ("codellama", "Meta"),
    ("llama-guard", "Meta"),
    ("qwen", "Alibaba"),
    ("qwq", "Alibaba"),
    ("codeqwen", "Alibaba"),
    ("mistral", "Mistral AI"),
    ("mixtral", "Mistral AI"),
    ("codestral", "Mistral AI"),
    ("ministral", "Mistral AI"),
    ("magistral", "Mistral AI"),
    ("devstral", "Mistral AI"),
    ("pixtral", "Mistral AI"),
    ("mathstral", "Mistral AI"),
    ("phi", "Microsoft"),
    ("deepseek", "DeepSeek"),
    ("granite", "IBM"),
    ("command-r", "Cohere"),
    ("command-a", "Cohere"),
    ("aya", "Cohere"),
    ("olmo", "Ai2"),
    ("tulu", "Ai2"),
    ("falcon", "TII"),
    ("smollm", "Hugging Face"),
    ("nemotron", "NVIDIA"),
    ("kimi", "Moonshot AI"),
    ("glm", "Zhipu AI"),
    ("grok", "xAI"),
    ("yi", "01.AI"),
    ("internlm", "Shanghai AI Laboratory"),
    ("exaone", "LG AI Research"),
    ("starcoder", "BigCode"),
)

# The part before the slash in names like meta-llama/llama-3.3-70b-instruct.
ORGANISATIONS = {
    "meta-llama": "Meta",
    "meta": "Meta",
    "facebook": "Meta",
    "openai": "OpenAI",
    "anthropic": "Anthropic",
    "google": "Google",
    "mistralai": "Mistral AI",
    "mistral": "Mistral AI",
    "qwen": "Alibaba",
    "alibaba": "Alibaba",
    "deepseek-ai": "DeepSeek",
    "deepseek": "DeepSeek",
    "microsoft": "Microsoft",
    "x-ai": "xAI",
    "xai": "xAI",
    "cohere": "Cohere",
    "coherelabs": "Cohere",
    "nvidia": "NVIDIA",
    "ibm-granite": "IBM",
    "ibm": "IBM",
    "allenai": "Ai2",
    "moonshotai": "Moonshot AI",
    "z-ai": "Zhipu AI",
    "zai-org": "Zhipu AI",
    "thudm": "Zhipu AI",
}

# Other ways people write the same company, so "Google DeepMind" and "Google"
# count as the same company, and so do "Open AI" and "OpenAI".
_ALIASES = {
    "googledeepmind": "google",
    "deepmind": "google",
    "alphabet": "google",
    "metaai": "meta",
    "metaplatforms": "meta",
    "facebook": "meta",
    "mistral": "mistralai",
    "alibabacloud": "alibaba",
    "qwen": "alibaba",
    "allenai": "ai2",
    "allenaiinstitute": "ai2",
    "x": "xai",
    "zhipu": "zhipuai",
    "anthropicpbc": "anthropic",
    "openaiinc": "openai",
}


def _key(company: str) -> str:
    squashed = re.sub(r"[^a-z0-9]+", "", company.casefold())
    return _ALIASES.get(squashed, squashed)


def same_company(a: str, b: str) -> bool:
    return _key(a) == _key(b)


def known_company(name: str) -> str | None:
    """A company name typed by someone (like "meta" or "google deepmind"),
    as Polygraph writes it, if it's one Polygraph knows."""
    wanted = _key(name)
    for company in {*PROVIDER_COMPANIES.values(), *(c for _, c in FAMILIES), *ORGANISATIONS.values()}:
        if _key(company) == wanted:
            return company
    return None


def _family(name: str) -> str | None:
    """The company of the family named first in `name`. A family has to start
    a word: "phi3" and "dolphin-phi" are Phi, but "dolphin" isn't. When two
    families appear (deepseek-r1-distill-llama), the first one wins."""
    text = name.strip().casefold()
    best: tuple[int, int, str] | None = None  # (position, -length, company)
    for family, company in FAMILIES:
        found = re.search(rf"(?<![a-z0-9]){re.escape(family)}", text)
        if found is not None:
            candidate = (found.start(), -len(family), company)
            if best is None or candidate < best:
                best = candidate
    return best[2] if best else None


def company_of(provider: str, model: str, details: dict | None = None) -> str | None:
    """Who made `model`, or None if Polygraph can't tell."""
    if provider in PROVIDER_COMPANIES:
        return PROVIDER_COMPANIES[provider]
    name = model.strip()
    if "/" in name:
        organisation = name.rsplit("/", 1)[0].split("/")[-1].casefold()
        if organisation in ORGANISATIONS:
            return ORGANISATIONS[organisation]
        name = name.rsplit("/", 1)[1]
    company = _family(name)
    if company is None and details:
        family = details.get("family")
        if isinstance(family, str):
            company = _family(family)
    return company
