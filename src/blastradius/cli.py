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
from blastradius.output import json_report, render_text
from blastradius.scanner import exit_code, scan_repository
from blastradius.worker import RUNTIME, NodeWorker, WorkerError

app = typer.Typer(help="Read-only repository health checks and JS/TS tree impact.", no_args_is_help=True, add_completion=False)


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
):
    """Scan a repository without executing, downloading, or changing its files."""
    options = ctx.obj or {}
    selected_format = format or options.get("format", Format.text)
    selected_threshold = fail_on or options.get("fail_on", Threshold.high)
    deterministic = deterministic_id or options.get("deterministic_id", False)
    try:
        report = scan_repository(path, mode=mode.value, deterministic=deterministic, max_files=max_files, max_bytes=max_bytes)
    except (OSError, ValueError, WorkerError, RecursionError) as error:
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
