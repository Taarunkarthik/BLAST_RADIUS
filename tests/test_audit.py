import json
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from typer.testing import CliRunner

from blastradius import audit
from blastradius.cli import app
from blastradius.harness import create_app

runner = CliRunner()


@pytest.fixture
def audit_log(tmp_path_factory):
    """A log path outside any scanned repository root."""
    return tmp_path_factory.mktemp("audit") / "audit.log"


@pytest.fixture(autouse=True)
def isolated_audit(audit_log, monkeypatch):
    """Every test in this file writes to its own temporary log."""
    monkeypatch.setenv("BLASTRADIUS_AUDIT_LOG", str(audit_log))
    audit.configure(path=None, enabled=True)
    yield
    audit.configure(path=None, enabled=True)


def events(path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_scan_writes_one_valid_jsonl_event(repository, audit_log, monkeypatch):
    monkeypatch.delenv("BLASTRADIUS_DATABASE_URL", raising=False)
    root = repository({"good.json": "{}"})

    result = runner.invoke(app, ["scan", "--path", str(root), "--fail-on", "none", "--format", "json"])

    assert result.exit_code == 0, result.output
    entries = events(audit_log)
    assert len(entries) == 1
    event = entries[0]
    assert event["event"] == "scan"
    assert event["action"] == "scan"
    assert event["tool_version"] == "0.1.0"
    assert event["project_root"] == str(root.resolve())
    assert event["mode"] == "all"
    assert event["report_id"] == json.loads(result.stdout)["scan"]["id"]
    assert set(event["findings"]) == {"issues", "high", "medium", "low"}
    assert event["exit_code"] == 0
    assert event["outcome"] == "ok"
    assert event["duration_ms"] >= 0
    assert event["user"]
    datetime.fromisoformat(event["ts"])


def test_scan_failure_is_recorded(repository, audit_log):
    root = repository({"broken.json": "{"})
    result = runner.invoke(app, ["scan", "--path", str(root), "--fail-on", "medium"])

    assert result.exit_code == 1
    event = events(audit_log)[-1]
    assert event["event"] == "scan"
    assert event["exit_code"] == 1
    assert event["findings"]["medium"] == 1


def test_partial_scan_is_incomplete(repository, audit_log):
    root = repository({"a.json": "{}", "b.json": "{}"})
    result = runner.invoke(
        app, ["scan", "--path", str(root), "--max-files", "1", "--fail-on", "none", "--format", "json"]
    )

    assert result.exit_code == 3
    assert events(audit_log)[-1]["outcome"] == "incomplete"


def test_no_audit_writes_nothing(repository, tmp_path, audit_log):
    root = repository({"good.json": "{}"})
    explicit = tmp_path / "explicit.log"

    result = runner.invoke(
        app, ["scan", "--path", str(root), "--audit-log", str(explicit), "--no-audit", "--fail-on", "none"]
    )

    assert result.exit_code == 0, result.output
    assert not explicit.exists()
    assert not audit_log.exists()


def test_empty_environment_value_disables_the_log(repository, monkeypatch):
    monkeypatch.setenv("BLASTRADIUS_AUDIT_LOG", "")
    root = repository({"good.json": "{}"})
    result = runner.invoke(app, ["scan", "--path", str(root), "--fail-on", "none"])
    assert result.exit_code == 0
    assert audit.current_path() is None


def test_unwritable_path_does_not_change_the_scan(repository, audit_log, monkeypatch):
    root = repository({"broken.json": "{"})
    blocker = audit_log.parent / "blocked"
    blocker.write_text("not a directory", encoding="utf-8")
    monkeypatch.setenv("BLASTRADIUS_AUDIT_LOG", str(blocker / "audit.log"))
    args = ["scan", "--path", str(root), "--format", "json", "--deterministic-id", "--fail-on", "medium"]

    unwritable = runner.invoke(app, args)
    without_audit = runner.invoke(app, [*args, "--no-audit"])

    assert unwritable.exit_code == 1, unwritable.output
    assert without_audit.exit_code == 1
    assert unwritable.stdout == without_audit.stdout
    assert not (blocker / "audit.log").exists()


def test_rotation_keeps_one_backup(audit_log, monkeypatch):
    monkeypatch.setattr(audit, "ROTATE_BYTES", 200)
    audit.configure(path=audit_log, enabled=True)
    audit_log.write_text("x" * 250 + "\n", encoding="utf-8")

    audit.record("scan", action="scan", outcome="ok")

    backup = audit_log.with_name(audit_log.name + ".1")
    assert backup.exists()
    assert backup.read_text(encoding="utf-8").startswith("x" * 10)
    lines = audit_log.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["event"] == "scan"


def test_audit_command_filters_action_and_formats_json(audit_log):
    audit.configure(path=audit_log, enabled=True)
    audit.record("scan", action="scan", outcome="ok", exit_code=0)
    audit.record("save", action="save", outcome="ok", exit_code=0)
    audit.record("scan", action="scan", outcome="error", exit_code=2)

    result = runner.invoke(app, ["audit", "--action", "scan", "--format", "json", "--limit", "10"])

    assert result.exit_code == 0, result.output
    payload = json.loads(result.stdout)
    assert payload["count"] == 2
    assert all(event["action"] == "scan" for event in payload["events"])
    # Newest first.
    assert payload["events"][0]["outcome"] == "error"


def test_audit_command_since_limit_and_text_table(audit_log):
    audit.configure(path=audit_log, enabled=True)
    audit.record("scan", action="scan", outcome="ok", ts=(datetime.now(UTC) - timedelta(days=1)).isoformat())
    cutoff = datetime.now(UTC)
    audit.record("scan", action="scan", outcome="ok")
    audit.record("scan", action="scan", outcome="ok")

    result = runner.invoke(app, ["audit", "--since", cutoff.isoformat(), "--limit", "1"])

    assert result.exit_code == 0, result.output
    assert "TIMESTAMP" in result.stdout
    assert result.stdout.count("scan") == 1


def test_audit_command_handles_a_missing_file(audit_log):
    assert not audit_log.exists()
    result = runner.invoke(app, ["audit", "--format", "json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["events"] == []


def test_audit_command_rejects_an_invalid_since(audit_log):
    result = runner.invoke(app, ["audit", "--since", "yesterday-ish", "--format", "json"])
    assert result.exit_code == 2
    assert json.loads(result.stdout)["error"]["type"] == "audit_error"


@pytest.mark.anyio
async def test_harness_scan_records_peer(repository, audit_log, monkeypatch):
    monkeypatch.delenv("BLASTRADIUS_DATABASE_URL", raising=False)
    root = repository({"main.ts": "import './missing';"})
    application = create_app(root, token="test-session")
    transport = httpx.ASGITransport(app=application, client=("127.0.0.1", 50000))
    async with httpx.AsyncClient(
        transport=transport, base_url="http://127.0.0.1", headers={"x-blastradius-token": "test-session"}
    ) as client:
        response = await client.post("/api/scan", json={"path": "."})
    assert response.status_code == 200, response.text

    entries = [event for event in events(audit_log) if event["event"] == "harness_scan"]
    assert len(entries) == 1
    event = entries[0]
    assert event["action"] == "scan"
    assert event["peer"] == "127.0.0.1"
    assert event["report_id"] == response.json()["scan"]["id"]
    assert event["mode"] == "all"
    assert event["duration_ms"] >= 0
    assert event["outcome"] == "ok"
