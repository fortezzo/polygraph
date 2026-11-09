"""The interrogator: runs the traps against a bot and records everything.

- interrogate: holds each trap's conversation the way PLAN.md describes
- calls: the cache, the cost guard, the concurrency limit and retries
- cache: every reply saved on this PC, so re-running costs nothing
- costs: estimates and the cost guard
- confidence: reading the bot's 0-100 confidence out of its reply
"""

from polygraph.interrogator.cache import ResponseCache, cache_key
from polygraph.interrogator.calls import Caller, CallResult, RetryPolicy, RunAborted, now_iso
from polygraph.interrogator.confidence import CONFIDENCE_QUESTION, parse_confidence
from polygraph.interrogator.costs import DEFAULT_LIMIT_USD, CostGuard, CostLimitReached, Estimate
from polygraph.interrogator.interrogate import (
    DOCUMENT_TEMPLATE,
    ConversationPlan,
    Interrogator,
    RunListener,
    document_message,
    plan_conversations,
)

__all__ = [
    "CONFIDENCE_QUESTION",
    "DEFAULT_LIMIT_USD",
    "DOCUMENT_TEMPLATE",
    "CallResult",
    "Caller",
    "ConversationPlan",
    "CostGuard",
    "CostLimitReached",
    "Estimate",
    "Interrogator",
    "ResponseCache",
    "RetryPolicy",
    "RunAborted",
    "RunListener",
    "cache_key",
    "document_message",
    "now_iso",
    "parse_confidence",
    "plan_conversations",
]
