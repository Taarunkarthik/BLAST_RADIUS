"""BlastRadius CLI entry point."""

import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from enum import StrEnum
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from blastradius import __version__, audit
from blastradius.comparison import compare_saved, comparison_exit_code
from blastradius.output import json_report, render_text
from blastradius.scanner import exit_code, scan_repository
from blastradius.storage import ScanStore, StoreError
from blastradius.worker import RUNTIME, NodeWorker, WorkerError

app = typer.Typer(help="Read-only repository health checks and JS/TS tree impact.", no_args_is_help=True, add_completion=False)
db_app = typer.Typer(help="Initialize the optional PostgreSQL store.", no_args_is_help=True)
project_app = typer.Typer(help="Register and list repository roots for saved scans.", no_args_is_help=True)
app.add_typer(db_app, name="db")
app.add_typer(project_app, name="project")


class Format(StrEnum):
    text = "text"
    json = "json"


class Mode(StrEnum):
    all = "all"
    structure = "structure"
    health = "health"


class Threshold(StrEnum):
    none = "none"
    low = "low"
    medium = "medium"
    high = "high"


def version_callback(value: bool):
    if value:
        typer.echo(f"BlastRadius {__version__}")
        raise typer.Exit()


def _elapsed_ms(started: float) -> int:
    return max(0, int((time.monotonic() - started) * 1000))


@app.callback()
def main(
    ctx: typer.Context,
    format: Annotated[Format, typer.Option(help="Report format.")] = Format.text,
    deterministic_id: Annotated[bool, typer.Option(help="Stable IDs and byte-identical reports.")] = False,
    fail_on: Annotated[Threshold, typer.Option(help="Minimum severity that fails a complete scan.")] = Threshold.high,
    logs: Annotated[bool, typer.Option(help="Write per-file coverage to stderr.")] = False,
    audit_log: Annotated[str | None, typer.Option("--audit-log", help="Append audit events to this JSONL file.")] = None,
    no_audit: Annotated[bool, typer.Option("--no-audit", help="Disable the local audit log.")] = False,
    version: Annotated[bool, typer.Option("--version", callback=version_callback, is_eager=True, help="Show version.")] = False,
):
    audit.configure(path=audit_log, enabled=not no_audit)
    ctx.obj = {
        "format": format,
        "deterministic_id": deterministic_id,
        "fail_on": fail_on,
        "logs": logs,
        "audit_log": audit_log,
        "no_audit": no_audit,
    }


@app.command()
def scan(
    ctx: typer.Context,
    path: Annotated[Path, typer.Option(help="Repository directory to scan.")] = Path("."),
    mode: Annotated[Mode, typer.Option(help="all, structure (JS/TS only), or health (no graph).")] = Mode.all,
    format: Annotated[Format | None, typer.Option(help="Override the global report format.")] = None,
    deterministic_id: Annotated[bool, typer.Option(help="Stable IDs and byte-identical reports.")] = False,
    fail_on: Annotated[Threshold | None, typer.Option(help="Override the global failure threshold.")] = None,
    logs: Annotated[bool, typer.Option(help="Write per-file coverage to stderr.")] = False,
    max_files: Annotated[int, typer.Option(min=1, help="Maximum eligible files to check; excess is reported.")] = 5000,
    max_bytes: Annotated[int, typer.Option(min=1, help="Maximum bytes per checked file.")] = 2_000_000,
    timeout: Annotated[int, typer.Option(min=1, help="Seconds to wait for a parser worker response.")] = 60,
    save: Annotated[bool, typer.Option(help="Save to PostgreSQL; the scan root must be registered.")] = False,
    project: Annotated[str | None, typer.Option(help="Require this registered project ID when saving.")] = None,
    audit_log: Annotated[str | None, typer.Option("--audit-log", help="Append audit events to this JSONL file.")] = None,
    no_audit: Annotated[bool, typer.Option("--no-audit", help="Disable the local audit log.")] = False,
):
    """Scan a repository without executing, downloading, or changing its files."""
    options = ctx.obj or {}
    selected_format = format or options.get("format", Format.text)
    selected_threshold = fail_on or options.get("fail_on", Threshold.high)
    deterministic = deterministic_id or options.get("deterministic_id", False)
    effective_audit_path = audit_log if audit_log is not None else options.get("audit_log")
    audit.configure(path=effective_audit_path, enabled=not (no_audit or options.get("no_audit", False)))
    started = time.monotonic()
    root = str(path.resolve())
    saved = False
    try:
        if project and not save:
            raise ValueError("--project requires --save.")
        store = ScanStore() if save else None
        if store:
            store.match_project(path, project)
        report = scan_repository(path, mode=mode.value, deterministic=deterministic, max_files=max_files, max_bytes=max_bytes, worker_timeout=timeout)
        if store:
            report = {**report, "storage": store.save(report, path, project_id=project)}
            saved = True
    except (OSError, ValueError, WorkerError, StoreError, RecursionError) as error:
        audit.record(
            "scan", action="scan", project_root=root, mode=mode.value,
            duration_ms=_elapsed_ms(started), exit_code=2, outcome="error", error=str(error),
        )
        if selected_format == Format.json:
            typer.echo(json.dumps({"schema_version": 1, "error": {"type": "scan_error", "message": str(error)}}))
        else:
            typer.echo(f"Scan failed: {error}", err=True)
        raise typer.Exit(2) from error
    code = exit_code(report, selected_threshold.value)
    if saved:
        audit.record(
            "save", action="save", project_root=root, mode=mode.value,
            report_id=report["scan"]["id"], duration_ms=_elapsed_ms(started),
            findings=report["summary"], exit_code=code, outcome="ok",
        )
    if logs or options.get("logs", False):
        for file in report["scan"]["checked_files"]:
            typer.echo(f"checked {file}", err=True)
        for file in report["scan"]["not_checked_files"]:
            typer.echo(f"not checked {file}", err=True)
        for item in report["scan"]["excluded_files"] + report["scan"]["skipped_files"]:
            typer.echo(f"excluded {item['file']}: {item['reason']}", err=True)
    if selected_format == Format.json:
        typer.echo(json_report(report), nl=False)
    else:
        render_text(report, Console(width=100, color_system=None if deterministic else "auto", markup=False, highlight=False))
        if "storage" in report:
            typer.echo(f"Saved scan: {report['storage']['id']} (project {report['storage']['project_id']})")
    audit.record(
        "scan", action="scan", project_root=root, mode=mode.value,
        report_id=report["scan"]["id"], duration_ms=_elapsed_ms(started),
        findings=report["summary"], exit_code=code,
        outcome="incomplete" if report["scan"]["partial"] else "ok",
    )
    raise typer.Exit(code)


@app.command()
def setup():
    """Install the pinned parser dependencies once (network access, never run by scan)."""
    npm = shutil.which("npm")
    if not npm:
        typer.echo("Node.js 20+ and npm are required for parser setup.", err=True)
        raise typer.Exit(2)
    try:
        completed = subprocess.run(
            [npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", str(RUNTIME)],
            cwd=RUNTIME, stdout=sys.stderr, stderr=sys.stderr, check=False,
        )
        if completed.returncode:
            raise WorkerError("Parser installation did not complete.")
        with NodeWorker() as worker:
            worker.request("ping")
    except (OSError, WorkerError) as error:
        typer.echo(str(error), err=True)
        raise typer.Exit(2) from error
    typer.echo("Parser runtime is ready. Scanning now works offline.")


def command_result(ctx: typer.Context, action, output_format=None):
    selected = output_format or (ctx.obj or {}).get("format", Format.text)
    try:
        result = action()
    except (StoreError, OSError, ValueError) as error:
        if selected == Format.json:
            typer.echo(json.dumps({"schema_version": 1, "error": {"type": "storage_error", "message": str(error)}}))
        else:
            typer.echo(str(error), err=True)
        raise typer.Exit(2) from error
    if selected == Format.json:
        typer.echo(json_report(result), nl=False)
    else:
        records = result if isinstance(result, list) else [result]
        if not records:
            typer.echo("No saved records.")
        for record in records:
            typer.echo(" | ".join(f"{key}: {value}" for key, value in record.items()))
    return result


@db_app.command("init")
def db_init(ctx: typer.Context):
    """Apply versioned migrations to BLASTRADIUS_DATABASE_URL."""
    command_result(ctx, lambda: ScanStore().initialize())


@project_app.command("add")
def project_add(ctx: typer.Context, path: Path = typer.Option(Path(".")), name: str | None = typer.Option(None)):
    """Register this exact scan root. Repeating registration returns the same ID."""
    command_result(ctx, lambda: ScanStore().add_project(path, name))


@project_app.command("list")
def project_list(ctx: typer.Context):
    """List registered project IDs and roots."""
    command_result(ctx, lambda: ScanStore().projects())


@app.command("scans")
def scan_history(ctx: typer.Context, project: str = typer.Option(...), limit: int = typer.Option(20, min=1, max=1000), format: Format | None = typer.Option(None)):
    """List saved scan IDs for comparison."""
    command_result(ctx, lambda: ScanStore().scans(project, limit), format)


@app.command("compare")
def compare(ctx: typer.Context, base: str, head: str, format: Format | None = typer.Option(None), fail_on: Threshold | None = typer.Option(None)):
    """Compare saved scan IDs from the same registered project (base -> head)."""
    selected = format or (ctx.obj or {}).get("format", Format.text)
    try:
        result = compare_saved(ScanStore(), base, head)
    except (StoreError, ValueError) as error:
        audit.record("compare", action="compare", base=base, head=head, exit_code=2, outcome="error", error=str(error))
        if selected == Format.json:
            typer.echo(json.dumps({"schema_version": 1, "error": {"type": "comparison_error", "message": str(error)}}))
        else:
            typer.echo(str(error), err=True)
        raise typer.Exit(2) from error
    if selected == Format.json:
        typer.echo(json_report(result), nl=False)
    else:
        typer.echo(f"BlastRadius comparison: {base} -> {head}")
        typer.echo(" | ".join(f"{key}: {value}" for key, value in result["summary"].items()))
        for label in ("added", "resolved", "changed", "unverified"):
            for item in result[label]:
                issue = item["head"] if label == "changed" else item
                typer.echo(f"{label.upper()} {issue['file']}:{issue['line']} {issue['type']} {issue['target']}")
        for warning in result["warnings"]:
            typer.echo(f"Coverage: {warning}")
    threshold = fail_on or (ctx.obj or {}).get("fail_on", Threshold.high)
    code = comparison_exit_code(result, threshold.value)
    audit.record(
        "compare", action="compare", base=base, head=head,
        exit_code=code, outcome="incomplete" if result["partial"] else "ok",
    )
    raise typer.Exit(code)


@app.command("harness")
def harness(path: Path = typer.Option(Path("."), help="Root directory the browser may scan."), port: int = typer.Option(8765, min=1024, max=65535)):
    """Serve the local browser interface on 127.0.0.1 only."""
    try:
        import uvicorn

        from blastradius.harness import create_app
        application = create_app(path)
    except ImportError as error:
        typer.echo("Install the browser extra: pip install 'blastradius[harness]'.", err=True)
        raise typer.Exit(2) from error
    except (OSError, ValueError) as error:
        typer.echo(f"Cannot start harness: {error}", err=True)
        raise typer.Exit(2) from error
    audit.record("harness_start", action="harness", project_root=str(path.resolve()), port=port, outcome="ok")
    typer.echo(f"BlastRadius: http://127.0.0.1:{port} (root: {path.resolve()})")
    uvicorn.run(application, host="127.0.0.1", port=port, access_log=False, log_level="warning")


def _short_root(value: object, width: int = 30) -> str:
    text = "" if value is None else str(value)
    return text if len(text) <= width else "..." + text[-(width - 3):]


def _findings_text(value: object) -> str:
    if not isinstance(value, dict):
        return "-"
    return "/".join(str(value.get(key, "-")) for key in ("issues", "high", "medium", "low"))


def _audit_table(events: list[dict]) -> str:
    headers = ("TIMESTAMP", "EVENT", "MODE", "ROOT", "FINDINGS", "MS", "EXIT", "OUTCOME")
    rows = [
        (
            str(event.get("ts", ""))[:19].replace("T", " "),
            str(event.get("event", "")),
            str(event.get("mode", "-")),
            _short_root(event.get("project_root")),
            _findings_text(event.get("findings")),
            str(event.get("duration_ms", "-")),
            str(event.get("exit_code", "-")),
            str(event.get("outcome", "-")),
        )
        for event in events
    ]
    widths = [max([len(header), *(len(row[index]) for row in rows)]) for index, header in enumerate(headers)]
    lines = ["  ".join(cell.ljust(widths[index]) for index, cell in enumerate(headers)).rstrip()]
    lines.extend("  ".join(cell.ljust(widths[index]) for index, cell in enumerate(row)).rstrip() for row in rows)
    return "\n".join(lines)


@app.command("audit")
def audit_command(
    ctx: typer.Context,
    since: Annotated[str | None, typer.Option(help="Only events at or after this ISO-8601 timestamp.")] = None,
    action: Annotated[str | None, typer.Option(help="Only events with this event or action name.")] = None,
    limit: Annotated[int, typer.Option(min=1, max=10000, help="Maximum number of events to show.")] = 50,
    format: Annotated[Format | None, typer.Option(help="Override the global report format.")] = None,
    audit_log: Annotated[str | None, typer.Option("--audit-log", help="Read this JSONL file instead.")] = None,
):
    """Show recent entries from the local audit log; no database is required."""
    selected = format or (ctx.obj or {}).get("format", Format.text)
    if audit_log is not None:
        audit.configure(path=audit_log, enabled=True)
    try:
        events = audit.read_events(since=since, action=action, limit=limit)
    except ValueError as error:
        if selected == Format.json:
            typer.echo(json.dumps({"schema_version": 1, "error": {"type": "audit_error", "message": str(error)}}))
        else:
            typer.echo(str(error), err=True)
        raise typer.Exit(2) from error
    target = audit.current_path()
    if selected == Format.json:
        typer.echo(json.dumps({
            "schema_version": 1,
            "audit_log": str(target) if target else None,
            "count": len(events),
            "events": events,
        }, indent=2, sort_keys=True))
        return
    if not events:
        if target is None:
            typer.echo("Audit log is disabled. Set BLASTRADIUS_AUDIT_LOG or pass --audit-log PATH.")
        else:
            typer.echo(f"No audit events found at {target}.")
        return
    typer.echo(_audit_table(events))


def _node_version(node: str) -> str | None:
    try:
        completed = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode:
        return None
    return (completed.stdout or completed.stderr).strip().lstrip("vV")


def _doctor_checks() -> list[tuple[str, str, str, str | None]]:
    checks: list[tuple[str, str, str, str | None]] = []

    version = platform.python_version()
    # Packaging already requires 3.11+, but doctor must still explain a broken venv.
    if sys.version_info[:2] >= (3, 11):  # noqa: UP036
        checks.append(("OK", "Python", version, None))
    else:
        checks.append(("FAIL", "Python", f"{version} (need 3.11+)", "Install Python 3.11 or newer from https://www.python.org/downloads/."))

    node = shutil.which("node")
    if not node:
        checks.append(("FAIL", "node", "not found on PATH", "Install Node.js 20+ from https://nodejs.org and reopen the terminal."))
    else:
        node_version = _node_version(node)
        if not node_version:
            checks.append(("FAIL", "node", f"could not run {node}", "Reinstall Node.js 20+ from https://nodejs.org."))
        else:
            try:
                major = int(node_version.split(".", 1)[0])
            except ValueError:
                major = 0
            if major >= 20:
                checks.append(("OK", "node", node_version, None))
            else:
                checks.append(("FAIL", "node", f"{node_version} (need 20+)", "Upgrade to Node.js 20+ from https://nodejs.org and reopen the terminal."))

    npm = shutil.which("npm")
    if npm:
        checks.append(("OK", "npm", npm, None))
    else:
        checks.append(("WARN", "npm", "not found on PATH", "Install npm (bundled with Node.js) and run: blastradius setup"))

    typescript = RUNTIME / "node_modules" / "typescript"
    if typescript.is_dir():
        checks.append(("OK", "parser dependencies", str(typescript), None))
    else:
        checks.append(("FAIL", "parser dependencies", f"missing at {typescript}", "Run: blastradius setup"))

    if importlib.util.find_spec("fastapi") and importlib.util.find_spec("uvicorn"):
        checks.append(("OK", "harness extra", "fastapi and uvicorn installed", None))
    else:
        checks.append(("WARN", "harness extra", "fastapi/uvicorn not installed", "Run: pip install 'blastradius[harness]'"))

    if importlib.util.find_spec("psycopg"):
        checks.append(("OK", "postgres extra", "psycopg installed", None))
    else:
        checks.append(("WARN", "postgres extra", "psycopg not installed", "Run: pip install 'blastradius[postgres]' (optional)"))

    if os.environ.get("BLASTRADIUS_DATABASE_URL"):
        checks.append(("OK", "database", "BLASTRADIUS_DATABASE_URL is set", None))
    else:
        checks.append(("WARN", "database", "BLASTRADIUS_DATABASE_URL is not set (optional)", "Set BLASTRADIUS_DATABASE_URL, then run: blastradius db init"))

    log_path = audit.resolve_path()
    if log_path is None:
        checks.append(("WARN", "audit log", "disabled", "Unset an empty BLASTRADIUS_AUDIT_LOG or pass --audit-log PATH."))
    else:
        try:
            log_path.parent.mkdir(parents=True, exist_ok=True)
            flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY | getattr(os, "O_BINARY", 0)
            descriptor = os.open(log_path, flags, 0o600)
            os.close(descriptor)
        except OSError as error:
            checks.append(("FAIL", "audit log", f"{log_path} is not writable ({type(error).__name__})", "Set BLASTRADIUS_AUDIT_LOG to a writable path or pass --no-audit."))
        else:
            checks.append(("OK", "audit log", str(log_path), None))
    return checks


@app.command()
def doctor():
    """Check the local toolchain and optional extras with exact fixes."""
    checks = _doctor_checks()
    failures = warnings = 0
    for status, name, detail, fix in checks:
        typer.echo(f"{status:<4} {name}: {detail}")
        if fix and status != "OK":
            typer.echo(f"     fix: {fix}")
        failures += status == "FAIL"
        warnings += status == "WARN"
    typer.echo(f"\n{len(checks)} checks: {failures} failed, {warnings} warnings.")
    raise typer.Exit(1 if failures else 0)
