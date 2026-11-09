"""Checking the judge (Session 5): hand labels against Polygraph's verdicts.

PLAN.md section 5: Christian hand-labels answers on a local page that never
shows the judge's verdict. Half of the labels are used to improve the judge's
rubric. Agreement is then measured once on the other half, which was never
used for tuning, so the number is honest.

- sample: picking the answers to label, and splitting them into a tuning half
  and a test half before anything is labeled
- labels: the labels, saved the moment they're made, and locking them
- page: what the labeling page shows for one answer (never the verdict)
- server: the local labeling page, `polygraph label`
- agreement: percent agreement, Cohen's kappa and where the labels and the
  verdicts disagree, `polygraph agreement`
"""

from polygraph.judgecheck.agreement import Stats, cohen_kappa, compare
from polygraph.judgecheck.labels import Label, LabelError, LabelStore, lock_labels
from polygraph.judgecheck.page import FORBIDDEN_KEYS, page_item, page_items
from polygraph.judgecheck.sample import (
    FOLDER,
    TEST,
    TUNING,
    Sample,
    SampleError,
    SampleItem,
    load_sample,
    make_sample,
    save_sample,
)

__all__ = [
    "FOLDER",
    "FORBIDDEN_KEYS",
    "TEST",
    "TUNING",
    "Label",
    "LabelError",
    "LabelStore",
    "Sample",
    "SampleError",
    "SampleItem",
    "Stats",
    "cohen_kappa",
    "compare",
    "load_sample",
    "lock_labels",
    "make_sample",
    "page_item",
    "page_items",
    "save_sample",
]
