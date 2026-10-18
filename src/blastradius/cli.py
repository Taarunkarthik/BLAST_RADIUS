"""BlastRadius CLI entry point."""

import json
import shutil
import subprocess
import sys
from enum import StrEnum
from pathlib import Path
from typing import Annotated

import typer
from rich.console import Console

from blastradius import __version__
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


@app.callback()
def main(
    ctx: typer.Context,
    format: Annotated[Format, typer.Option(help="Report format.")] = Format.text,
    deterministic_id: Annotated[bool, typer.Option(help="Stable IDs and byte-identical reports.")] = False,
    fail_on: Annotated[Threshold, typer.Option(help="Minimum severity that fails a complete scan.")] = Threshold.high,
    logs: Annotated[bool, typer.Option(help="Write per-file coverage to stderr.")] = False,
    version: Annotated[bool, typer.Option("--version", callback=version_callback, is_eager=True, help="Show version.")] = False,
):
    ctx.obj = {"format": format, "deterministic_id": deterministic_id, "fail_on": fail_on, "logs": logs}


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
    save: Annotated[bool, typer.Option(help="Save to PostgreSQL; the scan root must be registered.")] = False,
    project: Annotated[str | None, typer.Option(help="Require this registered project ID when saving.")] = None,
):
    """Scan a repository without executing, downloading, or changing its files."""
    options = ctx.obj or {}
    selected_format = format or options.get("format", Format.text)
    selected_threshold = fail_on or options.get("fail_on", Threshold.high)
    deterministic = deterministic_id or options.get("deterministic_id", False)
    try:
        if project and not save:
            raise ValueError("--project requires --save.")
        store = ScanStore() if save else None
        if store:
            store.match_project(path, project)
        report = scan_repository(path, mode=mode.value, deterministic=deterministic, max_files=max_files, max_bytes=max_bytes)
        if store:
            report = {**report, "storage": store.save(report, path, project_id=project)}
    except (OSError, ValueError, WorkerError, StoreError, RecursionError) as error:
        if selected_format == Format.json:
            typer.echo(json.dumps({"schema_version": 1, "error": {"type": "scan_error", "message": str(error)}}))
        else:
            typer.echo(f"Scan failed: {error}", err=True)
        raise typer.Exit(2) from error
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
    raise typer.Exit(exit_code(report, selected_threshold.value))


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
    raise typer.Exit(comparison_exit_code(result, threshold.value))
