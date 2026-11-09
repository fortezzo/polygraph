"""The labeling page's little web server, for `polygraph label`.

It uses Python's own web server, so nothing gets installed, and it only
listens on this PC (127.0.0.1). Other websites open in the same browser can't
read or change the labels:
- every request has to name this PC as its host (this blocks DNS rebinding)
- the page's requests carry a secret token that only the page knows, in a
  header other websites aren't allowed to send without permission, and it
  never gives that permission
- the page can't be shown inside another website's frame
"""

from __future__ import annotations

import http.server
import json
import secrets
import socket
import threading
from collections.abc import Callable
from importlib import resources
from typing import Any
from urllib.parse import urlsplit

from polygraph.judgecheck.labels import Label, LabelError, LabelStore
from polygraph.judgecheck.page import forbidden_keys_in

DEFAULT_PORT = 8411
BODY_LIMIT = 64 * 1024  # bytes
TOKEN_HEADER = "X-Polygraph-Token"
PING = {"polygraph": "label"}


def page_html() -> str:
    return resources.files("polygraph.judgecheck").joinpath("page.html").read_text(encoding="utf-8")


def _public(label: Label) -> dict[str, Any]:
    return {"verdict": label.verdict, "unsure": label.unsure, "note": label.note}


class _Server(http.server.ThreadingHTTPServer):
    # Never share the port with another program (on Windows, reusing an
    # address lets two servers grab the same port).
    allow_reuse_address = False
    daemon_threads = True

    def server_bind(self) -> None:
        exclusive = getattr(socket, "SO_EXCLUSIVEADDRUSE", None)
        if exclusive is not None:
            self.socket.setsockopt(socket.SOL_SOCKET, exclusive, 1)
        super().server_bind()


class LabelServer:
    def __init__(
        self,
        store: LabelStore,
        items: list[dict[str, Any]],
        *,
        port: int = DEFAULT_PORT,
        on_label: Callable[[int, int], None] | None = None,
    ) -> None:
        leaked = forbidden_keys_in(items)
        if leaked:
            raise RuntimeError(f"The page data has fields it must never show: {', '.join(sorted(leaked))}")
        self.store = store
        self.items = items
        self.token = secrets.token_urlsafe(24)
        self.on_label = on_label
        handler = _handler(self)
        try:
            self.httpd = _Server(("127.0.0.1", port), handler)
        except OSError:
            if port == 0:
                raise
            self.httpd = _Server(("127.0.0.1", 0), handler)  # that port is busy: take any free one
        self.port = self.httpd.server_address[1]
        self.allowed_hosts = {f"127.0.0.1:{self.port}", f"localhost:{self.port}"}
        self._thread: threading.Thread | None = None
        self._serving = False

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/"

    def state(self) -> dict[str, Any]:
        store = self.store
        lock = store.lock
        return {
            "items": self.items,
            "labels": {item_id: _public(label) for item_id, label in store.labels.items()},
            "labeled": store.labeled(),
            "total": len(self.items),
            "start": store.first_unlabeled(),
            "locked": lock.locked_at if lock else None,
            "labeler": store.data.labeler,
        }

    def serve_forever(self) -> None:
        self._serving = True
        self.httpd.serve_forever(poll_interval=0.25)

    def start_in_background(self) -> None:
        self._serving = True
        self._thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.25}, daemon=True)
        self._thread.start()

    def close(self) -> None:
        # Waiting for the server to stop only makes sense if it ever started:
        # otherwise the wait would never end.
        if self._serving:
            self.httpd.shutdown()
        self.httpd.server_close()


def _handler(app: LabelServer) -> type[http.server.BaseHTTPRequestHandler]:
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "Polygraph"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - the base class's name
            pass  # keep the run tab quiet: progress is printed separately

        # --- Replies ------------------------------------------------------------------

        def _send(self, status: int, body: bytes, content_type: str, extra: dict[str, str] | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            for name, value in (extra or {}).items():
                self.send_header(name, value)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, data: Any) -> None:
            self._send(status, json.dumps(data, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

        def _error(self, status: int, message: str, code: str) -> None:
            self._json(status, {"ok": False, "error": message, "code": code})

        # --- Checks -------------------------------------------------------------------

        def _host_ok(self) -> bool:
            return self.headers.get("Host", "") in app.allowed_hosts

        def _token_ok(self) -> bool:
            sent = self.headers.get(TOKEN_HEADER, "")
            return secrets.compare_digest(sent.encode(), app.token.encode())

        # --- Requests -----------------------------------------------------------------

        def do_GET(self) -> None:  # noqa: N802 - the base class's name
            if not self._host_ok():
                return self._error(403, "This page only opens on this PC.", "host")
            path = urlsplit(self.path).path
            if path == "/":
                nonce = secrets.token_urlsafe(16)
                html = page_html().replace("{{TOKEN}}", app.token).replace("{{NONCE}}", nonce)
                policy = (
                    "default-src 'none'; "
                    f"script-src 'nonce-{nonce}'; "
                    f"style-src 'nonce-{nonce}'; "
                    "connect-src 'self'; img-src 'self' data:; "
                    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
                )
                return self._send(200, html.encode("utf-8"), "text/html; charset=utf-8", {"Content-Security-Policy": policy})
            if path == "/api/ping":
                return self._json(200, PING)
            if path == "/api/state":
                if not self._token_ok():
                    return self._error(403, "This request didn't come from the labeling page.", "token")
                try:
                    return self._json(200, app.state())
                except LabelError as problem:
                    return self._error(500, problem.message, problem.code)
            if path == "/favicon.ico":
                return self._send(204, b"", "image/x-icon")
            return self._error(404, "There's nothing here.", "not_found")

        do_HEAD = do_GET

        def do_POST(self) -> None:  # noqa: N802 - the base class's name
            if not self._host_ok():
                return self._error(403, "This page only opens on this PC.", "host")
            if urlsplit(self.path).path != "/api/label":
                return self._error(404, "There's nothing here.", "not_found")
            if not self._token_ok():
                return self._error(403, "This request didn't come from the labeling page.", "token")
            if not self.headers.get("Content-Type", "").lower().startswith("application/json"):
                return self._error(415, "Labels have to be sent as JSON.", "content_type")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = -1
            if length < 0 or length > BODY_LIMIT:
                return self._error(413, "That's too much to save at once.", "too_big")
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except (ValueError, UnicodeDecodeError):
                return self._error(400, "That couldn't be read.", "unreadable")
            if not isinstance(data, dict) or not isinstance(data.get("item"), str):
                return self._error(400, "Which answer is this label for?", "invalid")
            changes: dict[str, Any] = {}
            if "verdict" in data:
                if data["verdict"] is not None and not isinstance(data["verdict"], str):
                    return self._error(400, "That isn't a verdict.", "invalid")
                changes["verdict"] = data["verdict"]
            if "unsure" in data:
                if not isinstance(data["unsure"], bool):
                    return self._error(400, "'Not sure' has to be on or off.", "invalid")
                changes["unsure"] = data["unsure"]
            if "note" in data:
                if not isinstance(data["note"], str):
                    return self._error(400, "A note has to be text.", "invalid")
                changes["note"] = data["note"]
            seconds = data.get("seconds")
            if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
                changes["seconds"] = float(seconds)
            before = app.store.labeled()
            try:
                label = app.store.set(data["item"], **changes)
            except LabelError as problem:
                return self._error(409 if problem.code in ("locked", "test_half") else 400, problem.message, problem.code)
            labeled = app.store.labeled()
            if app.on_label is not None and labeled != before:
                app.on_label(labeled, len(app.items))
            return self._json(
                200,
                {
                    "ok": True,
                    "label": _public(label),
                    "labeled": labeled,
                    "total": len(app.items),
                    "saved_at": label.labeled_at or app.store.clock(),
                },
            )

    return Handler


def already_running(port: int = DEFAULT_PORT) -> bool:
    """True when a labeling page is already being served on `port`."""
    import httpx

    try:
        with httpx.Client(trust_env=False, timeout=1.0) as client:  # never through a proxy: this is this PC
            reply = client.get(f"http://127.0.0.1:{port}/api/ping")
        return reply.status_code == 200 and reply.json() == PING
    except (httpx.HTTPError, ValueError):
        return False
