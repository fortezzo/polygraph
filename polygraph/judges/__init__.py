"""Judging: the hard checks (no AI) first, then the AI judge for everything else.

- numbers: the answer-key check for number traps
- citations: the reference check for fake citations (Crossref, doi.org, links)
- consistency: the side-by-side comparison for consistency traps
- rubric: exactly what the AI judge is told, with its fingerprint
- judge: the AI judge, and the checks on its replies
- companies: who made a model, so the judge never shares a company with the bot
- pipeline: judging a whole run and saving the judged copy
"""

from polygraph.judges.citations import Lookup, ReferenceCache, check_references, find_references
from polygraph.judges.companies import (
    DEFAULT_JUDGES,
    JUDGE_PREFERENCE,
    PROVIDER_COMPANIES,
    company_of,
    known_company,
    same_company,
)
from polygraph.judges.consistency import line_up
from polygraph.judges.judge import AIJudge, Outcome, locate_phrase, parse_reply
from polygraph.judges.numbers import check_number
from polygraph.judges.pipeline import (
    HARD_CHECKS_VERSION,
    JudgeListener,
    JudgeSetup,
    RunJudge,
    base_name,
    fresh_copy,
    judged_copies,
    judged_path,
)
from polygraph.judges.rubric import ALLOWED, INSTRUCTIONS, build_prompt, fingerprint, rubric_record

__all__ = [
    "ALLOWED",
    "DEFAULT_JUDGES",
    "HARD_CHECKS_VERSION",
    "INSTRUCTIONS",
    "JUDGE_PREFERENCE",
    "PROVIDER_COMPANIES",
    "AIJudge",
    "JudgeListener",
    "JudgeSetup",
    "Lookup",
    "Outcome",
    "ReferenceCache",
    "RunJudge",
    "base_name",
    "build_prompt",
    "check_number",
    "check_references",
    "company_of",
    "find_references",
    "fingerprint",
    "fresh_copy",
    "judged_copies",
    "judged_path",
    "known_company",
    "line_up",
    "locate_phrase",
    "parse_reply",
    "rubric_record",
    "same_company",
]
