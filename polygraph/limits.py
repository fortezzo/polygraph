"""Answer length limits and judging settings, shared by the commands and the
live server, so a run started from the dashboard is set up exactly like one
started with `polygraph run` and `polygraph judge`."""

from __future__ import annotations

# Answer length limits. Models that think before answering spend part of the
# limit on thinking, so they get much more room: too little would cut their
# answers off (or leave them empty) and make them look evasive.
PLAIN_LIMIT = 4_096
THINKING_LIMIT = 32_768
ASK_THINKING_LIMIT = 16_384  # one quick question, so a little less

# The judge's reply is short, but a judge that thinks first spends part of its
# limit thinking, so it gets room for that.
JUDGE_THINKING_LIMIT = 16_384
JUDGE_PLAIN_LIMIT = 2_048
JUDGE_CONCURRENCY = 4

# A bot on this PC that thinks before answering by default (Gemma 4, Session 9)
# gets the same room to think as a cloud model that thinks, THINKING_LIMIT. Its
# thinking counts against the limit, and Ollama's default window (4,096 tokens on
# this PC) can't hold that, so the window grows to fit the limit plus the
# question. Bots that don't think keep Ollama's defaults exactly, so every saved
# answer still counts.
LOCAL_THINKING_CONTEXT = THINKING_LIMIT + 4_096

# A judge on this PC (Ollama, Session 9). Ollama's default window is 4,096
# tokens, which is too small for the judge's prompt (about 2,000 tokens on
# average and 3,500 at most for Llama and Gemma, more for wordier bots) plus
# its reply, and Ollama would quietly cut the start of the rubric. So a local
# judge gets a bigger window, with room for its thinking when it thinks.
# One request at a time: Ollama on this PC answers one at a time anyway, and
# a queued request would count its wait against its own time limit.
JUDGE_LOCAL_CONTEXT = 16_384
JUDGE_LOCAL_THINKING_CONTEXT = 32_768
JUDGE_LOCAL_THINKING_LIMIT = 12_288  # leaves room in the window for the prompt
JUDGE_LOCAL_CONCURRENCY = 1

# How hard a Claude 5.x judge can be told to think (Anthropic's effort levels,
# checked 2026-11-10). Claude Haiku 5.5's own default is medium.
CLAUDE_EFFORTS = ("low", "medium", "high", "xhigh", "max")

# The AI judge can give a different verdict when asked the same thing again,
# so by default it judges each trap 3 times and the majority wins (Session 5).
# The judge check measured its agreement with Christian's labels this way.
DEFAULT_VOTES = 3


def local_judge_options(*, thinks: bool, think: bool | None):
    """The settings for a judge on this PC: a window big enough for the whole
    rubric, and room for thinking when the judge thinks. `think` is the
    on/off setting sent to Ollama (None: the model's own default)."""
    from polygraph.providers.base import ChatOptions

    return ChatOptions(
        max_output_tokens=JUDGE_LOCAL_THINKING_LIMIT if thinks else JUDGE_PLAIN_LIMIT,
        context_window=JUDGE_LOCAL_THINKING_CONTEXT if thinks else JUDGE_LOCAL_CONTEXT,
        think=think,
    )
