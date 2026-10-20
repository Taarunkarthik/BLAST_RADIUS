"""Append-only local audit log (JSON Lines).

The audit log records meaningful CLI and harness actions - never file contents,
database URLs, or session tokens. Writes are best effort: a broken or unwritable
log must never change the result of a scan.

Path resolution order:

1. an explicit ``--audit-log PATH`` value,
2. ``BLASTRADIUS_AUDIT_LOG`` (an empty value disables the log),
3. ``~/.blastradius/audit.log``.

Under pytest the default path is never used, so the test suite cannot write to
the developer's real home directory; tests opt in with an explicit path or the
environment variable.
"""

import getpass
import json
import os
import re
import threading
from datetime import UTC, datetime
from pathlib import Path

from blastradius import __version__

AUDIT_LOG_ENV = "BLASTRADIUS_AUDIT_LOG"
DEFAULT_DIRECTORY = ".blastradius"
DEFAULT_FILENAME = "audit.log"
ROTATE_BYTES = 10 * 1024 * 1024

FIELD_ORDER = (
    "ts",
    "event",
    "tool_version",
    "action",
    "project_root",
    "mode",
    "report_id",
    "duration_ms",
    "findings",
    "exit_code",
    "outcome",
    "error",
    "user",
    "peer",
    "base",
    "head",
    "port",
)

# Keys that must never reach the log even if a caller passes them by mistake.
SENSITIVE_KEY_PARTS = ("token", "password", "secret", "database_url", "db_url", "content")
_URL_PATTERN = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.\-]*://[^\s\"']+")

_lock = threading.Lock()
_enabled = True
_configured = False
_path: Path | None = None


def default_path() -> Path:
    return Path.home() / DEFAULT_DIRECTORY / DEFAULT_FILENAME


def resolve_path(override: str | os.PathLike[str] | None = None) -> Path | None:
    """Resolve the log path, honouring the documented precedence."""
    if override is not None:
        text = os.fspath(override).strip()
        return Path(text).expanduser() if text else None
    configured = os.environ.get(AUDIT_LOG_ENV)
    if configured is not None:
        text = configured.strip()
        return Path(text).expanduser() if text else None
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return None
    return default_path()


def configure(*, path: str | os.PathLike[str] | None = None, enabled: bool = True) -> None:
    """Set process-wide audit options for this invocation."""
    global _configured, _enabled, _path
    with _lock:
        _enabled = enabled
        _configured = True
        _path = resolve_path(path)


def current_path() -> Path | None:
    """Return the path this process will write to (``None`` when disabled)."""
    with _lock:
        if _configured:
            return None if not _enabled else _path
        return resolve_path()


def _username() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return ""


def _sanitize(value):
    if isinstance(value, str):
        return _URL_PATTERN.sub("[redacted-url]", value)
    if isinstance(value, dict):
        return {str(key): _sanitize(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(item) for item in value]
    return value


def _safe_fields(fields: dict) -> dict:
    clean = {}
    for key, value in fields.items():
        lowered = key.lower()
        if any(marker in lowered for marker in SENSITIVE_KEY_PARTS):
            continue
        clean[key] = _sanitize(value)
    return clean


def _entry(event: str, fields: dict) -> dict:
    entry: dict = {
        "ts": datetime.now(UTC).isoformat(),
        "event": event,
        "tool_version": __version__,
        "user": _username(),
    }
    entry.update(_safe_fields(fields))
    ordered = {key: entry[key] for key in FIELD_ORDER if key in entry}
    ordered.update({key: value for key, value in entry.items() if key not in ordered})
    return ordered


def _rotate(target: Path) -> None:
    try:
        if target.stat().st_size < ROTATE_BYTES:
            return
    except OSError:
        return
    os.replace(target, target.with_name(target.name + ".1"))


def record(event: str, **fields: object) -> None:
    """Append one JSON line. Never raises, even when the log is unwritable."""
    try:
        with _lock:
            if not _enabled:
                return
            target = _path if _configured else resolve_path()
            if target is None:
                return
            line = json.dumps(
                _entry(event, fields), ensure_ascii=True, separators=(",", ":"), default=str
            )
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
            except OSError:
                pass
            _rotate(target)
            flags = os.O_APPEND | os.O_CREAT | os.O_WRONLY | getattr(os, "O_BINARY", 0)
            descriptor = os.open(target, flags, 0o600)
            try:
                os.write(descriptor, (line + "\n").encode("utf-8"))
            finally:
                os.close(descriptor)
    except Exception:
        # Auditing is advisory; a failure must not affect the command result.
        return


def parse_timestamp(value: str) -> datetime:
    """Parse an ISO-8601 timestamp, treating a date-only value as UTC midnight."""
    text = value.strip()
    if not text:
        raise ValueError("--since needs an ISO-8601 timestamp.")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"Invalid --since timestamp: {value!r}. Use ISO-8601, for example 2026-01-31T12:00:00Z.") from error
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed


def _event_time(event: dict) -> datetime | None:
    raw = event.get("ts")
    if not isinstance(raw, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)


def read_events(
    *,
    path: str | os.PathLike[str] | None = None,
    since: str | datetime | None = None,
    action: str | None = None,
    limit: int = 50,
) -> list[dict]:
    """Read, filter, and return the newest ``limit`` matching events."""
    if isinstance(since, str):
        since_time: datetime | None = parse_timestamp(since)
    else:
        since_time = since
        if since_time is not None and since_time.tzinfo is None:
            since_time = since_time.replace(tzinfo=UTC)
    target = resolve_path(path) if path is not None else current_path()
    if target is None:
        return []
    try:
        lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    matched = []
    for line in lines:
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        if action is not None and action not in {event.get("event"), event.get("action")}:
            continue
        if since_time is not None:
            event_time = _event_time(event)
            if event_time is None or event_time < since_time:
                continue
        matched.append(event)
    if limit > 0:
        matched = matched[-limit:]
    return list(reversed(matched))
