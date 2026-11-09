"""The trap library: the trick questions Polygraph asks AI chatbots.

The traps live in traps/ at the top of the project, one JSON file per trap
type. Use load_library() to read them: it refuses to return anything while a
trap is broken. `polygraph traps check` lists every problem.
"""

from polygraph.traps.library import (
    DEFAULT_FOLDER,
    Library,
    Problem,
    TrapLibraryError,
    check_library,
    find_type,
    fingerprint,
    load_library,
    pick_random,
)
from polygraph.traps.schema import (
    CONSISTENCY_WAYS,
    MODELS,
    TYPE_INFO,
    Consistency,
    Document,
    FakeCitation,
    FalsePremise,
    GhostFact,
    KnowYourLimits,
    NumberTrap,
    PressureTest,
    Source,
    StickToDocument,
    Trap,
    TrapType,
    TypeInfo,
)

__all__ = [
    "CONSISTENCY_WAYS",
    "DEFAULT_FOLDER",
    "MODELS",
    "TYPE_INFO",
    "Consistency",
    "Document",
    "FakeCitation",
    "FalsePremise",
    "GhostFact",
    "KnowYourLimits",
    "Library",
    "NumberTrap",
    "PressureTest",
    "Problem",
    "Source",
    "StickToDocument",
    "Trap",
    "TrapLibraryError",
    "TrapType",
    "TypeInfo",
    "check_library",
    "find_type",
    "fingerprint",
    "load_library",
    "pick_random",
]
