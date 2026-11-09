"""The answer cache: every reply a model gives is saved on this PC.

Asking the same model the exact same conversation with the same settings gets
the saved reply back instantly, for free. That's what makes re-running a run
cost nothing. Each saved reply remembers when it was first collected and the
exact model version that gave it, so a run file can say so.

The cache is one SQLite file (SQLite comes with Python) in .cache/, which git
ignores. Deleting the folder just means the next run asks the models again.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from dataclasses import asdict, dataclass
from pathlib import Path

from polygraph.providers.base import ChatOptions, Message, Reply

CACHE_FORMAT = 1
FILE_NAME = "responses.sqlite3"


@dataclass(frozen=True)
class CachedReply:
    reply: Reply
    first_collected_at: str  # when the model first gave this reply (ISO 8601)


def cache_key(
    identity: str,
    model: str,
    messages: list[Message],
    options: ChatOptions,
    version_pin: str | None = None,
) -> str:
    """A fingerprint of everything that shapes the answer. The API key isn't part of it."""
    payload = {
        "cache_format": CACHE_FORMAT,
        "provider": identity,
        "model": model,
        # For Ollama, the exact download: re-downloading a model that changed
        # must not reuse answers from the old one.
        "version": version_pin,
        "messages": [[m.role, m.content] for m in messages],
        "options": options.as_dict(),
    }
    canonical = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class ResponseCache:
    def __init__(self, folder: Path) -> None:
        self.folder = Path(folder)
        self.path = self.folder / FILE_NAME
        self._db: sqlite3.Connection | None = None
        self.notice: str | None = None  # set if a damaged cache file had to be set aside

    def _connection(self) -> sqlite3.Connection:
        if self._db is None:
            self.folder.mkdir(parents=True, exist_ok=True)
            try:
                self._db = self._open()
            except sqlite3.DatabaseError:
                # A damaged file (say, from a crash mid-write): keep it for
                # inspection and start a fresh one. Only saved answers are lost.
                stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
                aside = self.path.with_name(f"{FILE_NAME}.damaged-{stamp}")
                self.path.replace(aside)
                self.notice = f"The answer cache was damaged, so it was moved to {aside.name} and a new one started."
                self._db = self._open()
        return self._db

    def _open(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, isolation_level=None)  # every change saves right away
        try:
            db.execute(
                "CREATE TABLE IF NOT EXISTS replies ("
                " key TEXT PRIMARY KEY,"
                " provider TEXT NOT NULL,"
                " model TEXT NOT NULL,"
                " first_collected_at TEXT NOT NULL,"
                " reply TEXT NOT NULL)"
            )
            db.execute("SELECT COUNT(*) FROM replies").fetchone()
        except sqlite3.DatabaseError:
            db.close()
            raise
        return db

    def get(self, key: str) -> CachedReply | None:
        row = self._connection().execute(
            "SELECT reply, first_collected_at FROM replies WHERE key = ?", (key,)
        ).fetchone()
        if row is None:
            return None
        try:
            fields = json.loads(row[0])
            reply = Reply(**{name: fields.get(name) for name in Reply.__dataclass_fields__})
        except (ValueError, TypeError):
            return None  # an unreadable entry is treated as missing
        if not isinstance(reply.text, str):
            return None
        return CachedReply(reply=reply, first_collected_at=row[1])

    def put(self, key: str, *, provider: str, model: str, reply: Reply, first_collected_at: str) -> None:
        self._connection().execute(
            "INSERT OR REPLACE INTO replies (key, provider, model, first_collected_at, reply) VALUES (?, ?, ?, ?, ?)",
            (key, provider, model, first_collected_at, json.dumps(asdict(reply), ensure_ascii=False)),
        )

    def __len__(self) -> int:
        return self._connection().execute("SELECT COUNT(*) FROM replies").fetchone()[0]

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None
