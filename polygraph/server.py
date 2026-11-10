"""The live server (Session 8): runs interrogations for the dashboard and
streams them as they happen, with Server-Sent Events.

Safety:
- It only listens on this PC (127.0.0.1), because it can spend money with
  your API keys. Nothing on your Wi-Fi can reach it.
- It only answers the Polygraph dashboard. A request from any other web page
  (another tab, a malicious site) is turned away, and so is a request for any
  other host name, which blocks "DNS rebinding" tricks. Starting a run takes a
  JSON request, which a web page can't send to another site without asking.
- API keys never leave this PC. They're used to call the model companies, and
  they're never sent to the dashboard or written to a log. Error messages from
  the companies are scrubbed of anything that looks like a key.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import shutil
import socket
import subprocess
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import ConfigDict

from polygraph import __version__
from polygraph.config import PROJECT_ROOT, Secret, Settings, load_settings
from polygraph.interrogator import ResponseCache
from polygraph.live.run import LiveRun
from polygraph.live.setup import Choices, Problem, ProviderFactory, estimate, estimate_dict, make_plan, options
from polygraph.providers import make_provider
from polygraph.runfile import load_run
from polygraph.traps import DEFAULT_FOLDER, TrapLibraryError, load_library

DEFAULT_PORT = 8420
DASHBOARD_PORTS = (5173, 4173)  # the dashboard's own server, and its preview
EXPORT_SCRIPT = PROJECT_ROOT / "dashboard" / "scripts" / "export-runs.mjs"


class StartRequest(Choices):
    """Starting a run: the choices, plus the person's go-ahead."""

    model_config = ConfigDict(extra="forbid")
    confirm: bool = False


async def export_for_dashboard() -> bool:
    """Make the dashboard's copies of the judged runs again, so a finished
    live run shows up on the report card and the evidence wall."""
    node = shutil.which("node")
    if node is None or not EXPORT_SCRIPT.is_file():
        return False

    def run() -> bool:
        try:
            done = subprocess.run(
                [node, str(EXPORT_SCRIPT)],
                cwd=EXPORT_SCRIPT.parent.parent,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=120,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return False
        return done.returncode == 0

    return await asyncio.to_thread(run)


class RunManager:
    """Keeps the current live run (one at a time) and the last finished one."""

    def __init__(
        self,
        settings: Settings,
        *,
        folder: Path,
        runs_dir: Path,
        factory: ProviderFactory,
        export: Any,
        pretend: bool,
    ) -> None:
        self.settings = settings
        self.folder = folder
        self.runs_dir = runs_dir
        self.factory = factory
        self.export = export
        self.pretend = pretend
        self.runs: dict[str, LiveRun] = {}
        self.current: LiveRun | None = None

    @property
    def busy(self) -> bool:
        return self.current is not None and not self.current.done

    async def plan(self, choices: Choices):
        plan = await make_plan(choices, self.settings, folder=self.folder, factory=self.factory)
        cache = ResponseCache(self.settings.cache_dir)
        try:
            numbers = estimate(plan, cache)
        finally:
            cache.close()
        return plan, numbers

    async def start(self, request: StartRequest) -> LiveRun:
        if self.busy:
            raise Problem(
                "A run is already going",
                "Polygraph runs one interrogation at a time. Watch the one that's going, or stop it first.",
                kind="busy",
                status=409,
            )
        if not request.confirm:
            raise Problem("Not confirmed", "Confirm the plan and the cost to start the run.")
        choices = Choices(**request.model_dump(exclude={"confirm"}))
        plan, numbers = await self.plan(choices)
        if numbers.typical_usd > choices.max_cost:
            raise Problem(
                "Over the cost limit",
                f"This run should cost about ${numbers.typical_usd:.2f}, which is more than the ${choices.max_cost:.2f} limit.",
                f"To allow it, raise the limit to ${numbers.suggested_limit():.2f}.",
                kind="over_limit",
            )
        run = LiveRun(plan, numbers, self.settings, runs_dir=self.runs_dir, export=self.export, pretend=self.pretend)
        self.runs = {run.id: run}  # only the newest run is kept in memory
        self.current = run
        run.start()
        return run

    def get(self, run_id: str) -> LiveRun | None:
        return self.runs.get(run_id)

    async def close(self) -> None:
        """The server is stopping (Ctrl+C): stop the run, and let it save and judge what's finished."""
        run = self.current
        if run is None or run.done or run.task is None:
            return
        run.stop("Ctrl+C in the server's window")
        with contextlib.suppress(Exception, asyncio.CancelledError):
            await asyncio.wait_for(asyncio.shield(run.task), 30)


class OnlyTheDashboard:
    """Turns away anything that isn't the Polygraph dashboard on this PC."""

    def __init__(self, app: Any, *, hosts: set[str], origins: set[str]) -> None:
        self.app = app
        self.hosts = hosts
        self.origins = origins

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in scope.get("headers", [])}
        refusal = self._refusal(scope["method"], headers)
        if refusal is not None:
            await refusal(scope, receive, send)
            return

        async def with_headers(message: dict) -> None:
            if message["type"] == "http.response.start":
                extra = [(b"x-content-type-options", b"nosniff"), (b"referrer-policy", b"no-referrer")]
                if not any(key.lower() == b"cache-control" for key, _ in message.get("headers", [])):
                    extra.append((b"cache-control", b"no-store"))
                message = {**message, "headers": [*message.get("headers", []), *extra]}
            await send(message)

        await self.app(scope, receive, with_headers)

    def _refusal(self, method: str, headers: dict[str, str]) -> Response | None:
        def refuse(status: int, message: str) -> Response:
            return JSONResponse({"problem": {"title": "Not allowed", "message": message, "hint": None, "kind": "refused"}}, status)

        if headers.get("host", "") not in self.hosts:
            return refuse(403, "This server only answers the Polygraph dashboard on this PC.")
        origin = headers.get("origin")
        if origin is not None and origin not in self.origins:
            return refuse(403, "This server only answers the Polygraph dashboard, not other web pages.")
        if method not in ("GET", "HEAD", "POST"):
            return refuse(405, "That kind of request isn't allowed.")
        if method == "POST" and headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            return refuse(415, "Requests that change anything have to be JSON.")
        return None


def problem_response(problem: Problem) -> JSONResponse:
    return JSONResponse({"problem": problem.as_dict()}, problem.status)


def _sse(event: dict[str, Any]) -> str:
    data = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
    return f"id: {event['id']}\nevent: {event['type']}\ndata: {data}\n\n"


def create_app(
    settings: Settings | None = None,
    *,
    port: int = DEFAULT_PORT,
    folder: Path = DEFAULT_FOLDER,
    runs_dir: Path | None = None,
    factory: ProviderFactory = make_provider,
    export: Any = export_for_dashboard,
    pretend: bool = False,
    extra_hosts: tuple[str, ...] = (),
) -> FastAPI:
    settings = settings or load_settings()
    manager = RunManager(
        settings,
        folder=folder,
        runs_dir=runs_dir or settings.runs_dir,
        factory=factory,
        export=export,
        pretend=pretend,
    )

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await manager.close()

    app = FastAPI(title="Polygraph", version=__version__, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.manager = manager
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}", *extra_hosts}
    origins = {f"http://{host}:{p}" for host in ("127.0.0.1", "localhost") for p in DASHBOARD_PORTS}
    origins |= {f"http://{host}" for host in hosts}
    app.add_middleware(OnlyTheDashboard, hosts=hosts, origins=origins)

    @app.exception_handler(Problem)
    async def _problem(_: Request, problem: Problem) -> JSONResponse:
        return problem_response(problem)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, error: RequestValidationError) -> JSONResponse:
        first = error.errors()[0] if error.errors() else {}
        where = ".".join(str(part) for part in first.get("loc", []) if part != "body")
        message = f"{where}: {first.get('msg', 'not valid')}" if where else str(first.get("msg", "Something in the form isn't valid."))
        return problem_response(Problem("Check the form", message, kind="invalid", status=422))

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        current = manager.current.summary() if manager.current else None
        return {"ok": True, "version": __version__, "pretend": pretend, "run": current}

    @app.get("/api/setup")
    async def setup() -> dict[str, Any]:
        try:
            library = load_library(folder)
        except TrapLibraryError as problem:
            raise Problem("The trap library has a problem", str(problem).splitlines()[0], "Run polygraph traps check in the run tab.") from problem
        listed = await options(settings, library, factory)
        current = manager.current.summary() if manager.current else None
        return {**listed, "run": current, "pretend": pretend}

    @app.post("/api/plan")
    async def plan(choices: Choices) -> dict[str, Any]:
        made, numbers = await manager.plan(choices)
        return estimate_dict(made, numbers)

    @app.post("/api/runs")
    async def start(request: StartRequest) -> dict[str, Any]:
        run = await manager.start(request)
        return {"run": run.summary()}

    @app.get("/api/runs/current")
    async def current() -> dict[str, Any]:
        return {"run": manager.current.summary() if manager.current else None}

    @app.post("/api/runs/{run_id}/stop")
    async def stop(run_id: str) -> dict[str, Any]:
        run = manager.get(run_id)
        if run is None:
            raise Problem("Run not found", "That run isn't on this server any more.", status=404)
        return {"stopped": run.stop()}

    @app.get("/api/runs/{run_id}/events")
    async def events(run_id: str, request: Request, after: int = 0) -> Response:
        run = manager.get(run_id)
        if run is None:
            raise Problem("Run not found", "That run isn't on this server. It may have been restarted.", status=404)
        last = request.headers.get("last-event-id", "")
        start_at = max(after, int(last) if last.isdigit() else 0)
        if run.done and start_at >= len(run.events):
            return Response(status_code=204)  # nothing more: tells the browser to stop reconnecting

        async def stream() -> AsyncIterator[str]:
            yield "retry: 3000\n\n"
            async for event in run.follow(start_at):
                yield ": still here\n\n" if event is None else _sse(event)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no"},
        )

    return app


def pretend_app(run_path: Path, *, port: int = DEFAULT_PORT, fast: bool = False, folder: Path | None = None) -> FastAPI:
    """A server whose bot and judge replay a recorded, judged run (screenshots
    and tests). It uses a throwaway folder (or `folder`) for the cache and the
    run files, never runs/ or the real cache."""
    from polygraph.live.pretend import pretend_factory

    run_file = load_run(run_path)
    real = load_settings()
    if folder is not None:
        folder.mkdir(parents=True, exist_ok=True)
        if folder.resolve() in (real.runs_dir.resolve(), real.cache_dir.resolve()):
            raise ValueError("Pretend runs never go in the real runs or cache folder.")
    scratch = folder or Path(tempfile.mkdtemp(prefix="polygraph-pretend-"))
    references = real.cache_dir / "references.sqlite3"
    if references.is_file():
        shutil.copy2(references, scratch / "references.sqlite3")  # saved Crossref lookups: no internet needed
    settings = dataclasses.replace(
        real,
        openai_api_key=Secret("pretend-not-a-real-key"),
        anthropic_api_key=None,
        gemini_api_key=None,
        cache_dir=scratch,
        runs_dir=scratch / "runs",
    )
    (scratch / "runs").mkdir(exist_ok=True)
    return create_app(settings, port=port, factory=pretend_factory(run_file, fast=fast), export=None, pretend=True)


def port_is_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True
