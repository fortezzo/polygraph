"""Live mode (Session 8): runs started from the dashboard and watched as they happen.

- setup: the dashboard's choices, checked and turned into a plan with its cost
- run: a live run, one trap at a time, judged as it goes, told as events
- pretend: a bot and a judge that replay a recorded run (screenshots and tests)

The server that serves all this to the dashboard is polygraph/server.py.
"""

from polygraph.live.run import LiveRun
from polygraph.live.setup import Choices, OwnBot, Plan, PlanEstimate, Problem, estimate, estimate_dict, make_plan, options

__all__ = [
    "Choices",
    "LiveRun",
    "OwnBot",
    "Plan",
    "PlanEstimate",
    "Problem",
    "estimate",
    "estimate_dict",
    "make_plan",
    "options",
]
