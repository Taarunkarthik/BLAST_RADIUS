"""Loopback-only browser harness, scoped to one explicitly selected directory."""

import secrets
import threading
from pathlib import Path
from typing import Literal, TypedDict
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from blastradius.comparison import compare_saved
from blastradius.scanner import scan_repository
from blastradius.storage import ScanStore, StoreError
from blastradius.worker import WorkerError

STATIC = Path(__file__).with_name("static")

LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
LOOPBACK_PEERS = frozenset({"127.0.0.1", "::1", "::ffff:127.0.0.1"})
MAX_BODY_BYTES = 8192
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
    ),
}


async def _read_capped(receive: Receive) -> tuple[bytes, bool]:
    """Read a request body, stopping as soon as it exceeds the cap."""
    received = bytearray()
    while True:
        message = await receive()
        if message["type"] == "http.disconnect":
            break
        if message["type"] != "http.request":
            continue
        received.extend(message.get("body", b""))
        if len(received) > MAX_BODY_BYTES:
            return b"", True
        if not message.get("more_body", False):
            break
    return bytes(received), False


def _replay(body: bytes) -> Receive:
    """Serve a buffered body on the receive channel without touching private state."""
    delivered = False

    async def receive() -> Message:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive


def _with_security_headers(send: Send) -> Send:
    async def send_with_headers(message: Message) -> None:
        if message["type"] == "http.response.start":
            MutableHeaders(scope=message).update(SECURITY_HEADERS)
        await send(message)

    return send_with_headers


class LocalAccessMiddleware:
    """Enforce loopback-only access, JSON bodies and a capped request body.

    Implemented as raw ASGI middleware so the capped body is replayed on the
    ``receive`` channel instead of mutating Starlette's private ``Request._body``.
    """

    def __init__(self, app: ASGIApp, *, token: str) -> None:
        self.app = app
        self.token = token

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        blocked = self._blocked(scope, Headers(scope=scope))
        if blocked is not None:
            await blocked(scope, receive, send)
            return
        if scope["method"] == "POST":
            body, too_large = await _read_capped(receive)
            if too_large:
                await JSONResponse({"detail": "Request body is too large."}, status_code=413)(scope, receive, send)
                return
            receive = _replay(body)
        await self.app(scope, receive, _with_security_headers(send))

    def _blocked(self, scope: Scope, headers: Headers) -> JSONResponse | None:
        host = headers.get("host", "")
        try:
            parsed = urlsplit("http://" + host)
            allowed = parsed.hostname in LOOPBACK_HOSTS and parsed.username is None
        except ValueError:
            allowed = False
        client = scope.get("client")
        peer = client[0] if client else ""
        if not allowed or peer not in LOOPBACK_PEERS:
            return JSONResponse({"detail": "The harness accepts loopback requests only."}, status_code=403)
        origin = headers.get("origin")
        if origin and origin != f"http://{host}":
            return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)
        if headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Cross-site requests are not allowed."}, status_code=403)
        if scope["path"].startswith("/api/") and not secrets.compare_digest(headers.get("x-blastradius-token", ""), self.token):
            return JSONResponse({"detail": "Missing or invalid local session token."}, status_code=403)
        if scope["method"] == "POST" and headers.get("content-type", "").split(";", 1)[0] != "application/json":
            return JSONResponse({"detail": "JSON request body required."}, status_code=415)
        return None


class HarnessState(TypedDict):
    report: dict | None
    path: Path


class ScanRequest(BaseModel):
    path: str = Field(default=".", max_length=1024)
    mode: Literal["all", "structure", "health"] = "all"
    max_files: int = Field(default=5000, ge=1, le=20000)
    max_bytes: int = Field(default=2_000_000, ge=1, le=10_000_000)


class SaveRequest(BaseModel):
    report_id: str = Field(min_length=1, max_length=128)


class CompareRequest(BaseModel):
    base: str = Field(min_length=1, max_length=128)
    head: str = Field(min_length=1, max_length=128)


def create_app(root: Path, *, token: str | None = None) -> FastAPI:
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Harness root must be a directory.")
    token = token or secrets.token_urlsafe(32)
    app = FastAPI(title="BlastRadius", docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(LocalAccessMiddleware, token=token)
    lock = threading.Lock()
    state: HarnessState = {"report": None, "path": root}

    @app.get("/", response_class=HTMLResponse)
    def index():
        return STATIC.joinpath("index.html").read_text(encoding="utf-8").replace("__SESSION_TOKEN__", token)

    @app.get("/app.js")
    @app.get("/static/app.js")
    def javascript():
        return FileResponse(STATIC / "app.js", media_type="text/javascript")

    @app.get("/styles.css")
    @app.get("/static/styles.css")
    def stylesheet():
        return FileResponse(STATIC / "styles.css", media_type="text/css")

    # ES modules (lib/, views/) and per-view stylesheets (styles/) live in
    # subdirectories. StaticFiles resolves paths safely under STATIC and serves
    # correct media types; index.html stays on the token-injecting route above.
    app.mount("/static", StaticFiles(directory=STATIC, html=False), name="static")

    @app.get("/api/session")
    def session():
        import os
        return {"root": str(root), "name": root.name, "persistence": bool(os.environ.get("BLASTRADIUS_DATABASE_URL"))}

    def scoped_path(value):
        try:
            candidate = (root / value).resolve(strict=True)
            if not candidate.is_relative_to(root) or not candidate.is_dir():
                raise ValueError()
            return candidate
        except (OSError, ValueError) as error:
            raise HTTPException(400, "Choose an existing directory inside the harness root.") from error

    @app.post("/api/scan")
    def scan(body: ScanRequest):
        path = scoped_path(body.path)
        if not lock.acquire(blocking=False):
            raise HTTPException(409, "A scan or save is already running.")
        try:
            report = scan_repository(path, mode=body.mode, deterministic=True, max_files=body.max_files, max_bytes=body.max_bytes)
            state.update({"report": report, "path": path})
            return report
        except (OSError, ValueError, WorkerError, RecursionError) as error:
            raise HTTPException(422, f"Scan could not complete: {error}") from error
        finally:
            lock.release()

    @app.get("/api/report")
    def report():
        if state["report"] is None:
            raise HTTPException(404, "Run a scan to see a report.")
        return state["report"]

    @app.post("/api/save")
    def save(body: SaveRequest):
        if not lock.acquire(blocking=False):
            raise HTTPException(409, "A scan or save is already running.")
        try:
            if state["report"] is None or state["report"]["scan"]["id"] != body.report_id:
                raise HTTPException(409, "The displayed report is no longer the latest scan. Refresh before saving.")
            if state["path"] != root:
                raise HTTPException(422, "To save a subdirectory scan, start the harness with that directory as --path.")
            return ScanStore().save(state["report"], state["path"])
        except (StoreError, OSError, ValueError) as error:
            raise HTTPException(422, str(error)) from error
        finally:
            lock.release()

    @app.get("/api/history")
    def history():
        try:
            store = ScanStore()
            project = store.match_project(root)
            return {"project": project, "scans": store.scans(project["id"], 100)}
        except (StoreError, OSError, ValueError) as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/compare")
    def compare(body: CompareRequest):
        try:
            store = ScanStore()
            project = store.match_project(root)
            for scan_id in (body.base, body.head):
                if store.load(scan_id)["project_id"] != project["id"]:
                    raise HTTPException(403, "This saved scan belongs to a different harness root.")
            return compare_saved(store, body.base, body.head)
        except (StoreError, ValueError) as error:
            raise HTTPException(422, str(error)) from error

    # Serve the remaining static assets at the web root so index.html can use
    # document-relative URLs (which also resolve on disk for the repo's own HTML
    # link check). Registered last: the explicit routes and /api/* above win.
    app.mount("/", StaticFiles(directory=STATIC, html=False), name="static-root")

    return app
