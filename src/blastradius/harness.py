"""Loopback-only browser harness, scoped to one explicitly selected directory."""

import secrets
import threading
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from pydantic import BaseModel, Field

from blastradius.comparison import compare_saved
from blastradius.scanner import scan_repository
from blastradius.storage import ScanStore, StoreError
from blastradius.worker import WorkerError

STATIC = Path(__file__).with_name("static")


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
    lock = threading.Lock()
    state = {"report": None, "path": root}

    @app.middleware("http")
    async def local_access(request: Request, call_next):
        host = request.headers.get("host", "")
        try:
            parsed = urlsplit("http://" + host)
            allowed = parsed.hostname in {"127.0.0.1", "localhost", "::1"} and parsed.username is None
        except ValueError:
            allowed = False
        peer = request.client.host if request.client else ""
        if not allowed or peer not in {"127.0.0.1", "::1", "::ffff:127.0.0.1"}:
            return JSONResponse({"detail": "The harness accepts loopback requests only."}, status_code=403)
        origin = request.headers.get("origin")
        if origin and origin != f"http://{host}":
            return JSONResponse({"detail": "Cross-origin requests are not allowed."}, status_code=403)
        if request.headers.get("sec-fetch-site") == "cross-site":
            return JSONResponse({"detail": "Cross-site requests are not allowed."}, status_code=403)
        if request.url.path.startswith("/api/") and not secrets.compare_digest(request.headers.get("x-blastradius-token", ""), token):
            return JSONResponse({"detail": "Missing or invalid local session token."}, status_code=403)
        if request.method == "POST":
            if request.headers.get("content-type", "").split(";", 1)[0] != "application/json":
                return JSONResponse({"detail": "JSON request body required."}, status_code=415)
            # Body is capped before Pydantic parsing, including chunked requests.
            received = bytearray()
            async for chunk in request.stream():
                received.extend(chunk)
                if len(received) > 8192:
                    return JSONResponse({"detail": "Request body is too large."}, status_code=413)
            request._body = bytes(received)
        response = await call_next(request)
        response.headers.update({
            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        })
        return response

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
            state.update(report=report, path=path)
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

    return app
