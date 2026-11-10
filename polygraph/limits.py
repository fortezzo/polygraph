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

# The AI judge can give a different verdict when asked the same thing again,
# so by default it judges each trap 3 times and the majority wins (Session 5).
# The judge check measured its agreement with Christian's labels this way.
DEFAULT_VOTES = 3
