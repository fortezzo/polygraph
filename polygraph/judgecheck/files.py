"""Small helpers for the judge check's files in docs/judge-check/."""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

from polygraph.config import PROJECT_ROOT


def write_json(path: Path, data: Any) -> None:
    """Write a JSON file safely: to a temporary file first, then swapped in, so
    a crash can never leave a half-written file behind. On Windows, another
    program (an antivirus scan, a file indexer) can hold a file for a moment,
    so the swap is tried a few times."""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    handle, temporary = tempfile.mkstemp(dir=path.parent, prefix=".saving-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        for attempt in range(10):
            try:
                os.replace(temporary, path)
                return
            except PermissionError:
                if attempt == 9:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


def fingerprint(data: Any) -> str:
    """A short code that changes whenever `data` changes (12 hex characters of
    a SHA-256 of its canonical JSON)."""
    canonical = json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:12]


def file_fingerprint(path: Path) -> str:
    """A short code for a file's exact contents. Windows line endings count the
    same as Unix ones, so a fresh checkout on any computer gets the same code."""
    data = Path(path).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()[:12]


def shown(path: Path) -> str:
    """A path the way the files record it: relative to the project folder, with
    forward slashes, when it's inside the project; otherwise in full."""
    try:
        return Path(path).resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return str(Path(path).resolve())


def resolve(recorded: str) -> Path:
    """The real location of a path recorded by `shown`."""
    path = Path(recorded)
    return path if path.is_absolute() else PROJECT_ROOT / path
