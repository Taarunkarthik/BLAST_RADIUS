import json
import os
import subprocess
import sys

import pytest
from typer.testing import CliRunner

from blastradius import audit
from blastradius.cli import app
from blastradius.scanner import scan_repository as real_scan_repository

runner = CliRunner()


@pytest.fixture(autouse=True)
def isolated_audit(tmp_path_factory, monkeypatch):
    """Keep CLI tests out of the real ~/.blastradius/audit.log."""
    directory = tmp_path_factory.mktemp("audit")
    monkeypatch.setenv("BLASTRADIUS_AUDIT_LOG", str(directory / "audit.log"))
    audit.configure(path=None, enabled=True)


def test_json_global_flags_and_stderr_logging(repository):
    root = repository({"broken.json": "{"})
    result = runner.invoke(app, ["--format", "json", "--deterministic-id", "--fail-on", "medium", "--logs", "scan", "--path", str(root)])
    assert result.exit_code == 1, result.output
    assert json.loads(result.stdout)["issues"][0]["type"] == "invalid_json"
    assert "checked broken.json" in result.stderr


def test_flags_after_subcommand_and_byte_identical_output(repository):
    root = repository({"broken.json": "{"})
    args = ["scan", "--path", str(root), "--format", "json", "--deterministic-id", "--fail-on", "none"]
    first, second = runner.invoke(app, args), runner.invoke(app, args)
    assert first.exit_code == 0
    assert first.stdout == second.stdout


def test_text_escapes_markup_and_includes_no_tree_impact(repository):
    root = repository({"[red].json": "{"})
    result = runner.invoke(app, ["scan", "--path", str(root), "--deterministic-id"])
    assert result.exit_code == 0
    assert "[red].json:1" in result.stdout
    assert "No Tree Impact" in result.stdout
    assert "No fixes were applied." in result.stdout


def test_runtime_error_is_machine_readable(tmp_path):
    result = runner.invoke(app, ["scan", "--path", str(tmp_path / "absent"), "--format", "json"])
    assert result.exit_code == 2
    assert json.loads(result.stdout)["error"]["type"] == "scan_error"


def test_partial_scan_has_distinct_exit_code(repository):
    root = repository({"a.json": "{}", "b.json": "{}"})
    result = runner.invoke(app, ["scan", "--path", str(root), "--max-files", "1", "--fail-on", "none", "--format", "json"])
    assert result.exit_code == 3
    assert json.loads(result.stdout)["scan"]["partial"]


def test_root_failure_is_visible_in_text(repository):
    root = repository({"main.ts": "import './missing';"})
    result = runner.invoke(app, ["scan", "--path", str(root), "--deterministic-id"])
    assert result.exit_code == 1
    assert "CRITICAL - root node" in result.stdout


def test_timeout_option_is_plumbed_through(tmp_path, monkeypatch):
    captured = {}

    def fake_scan(root, **kwargs):
        captured.update(kwargs)
        return real_scan_repository(root, **kwargs)

    monkeypatch.setattr("blastradius.cli.scan_repository", fake_scan)
    for args, expected in ((["--timeout", "7"], 7), ([], 60)):
        captured.clear()
        result = runner.invoke(app, ["scan", "--path", str(tmp_path), "--fail-on", "none", *args])
        assert result.exit_code == 0, result.output
        assert captured["worker_timeout"] == expected
    result = runner.invoke(app, ["scan", "--path", str(tmp_path), "--timeout", "0"])
    assert result.exit_code == 2


def test_deterministic_output_across_processes_and_hash_seeds(repository):
    root = repository({"broken.ts": "const = ; function () { const x = ;"})
    command = [sys.executable, "-m", "blastradius", "scan", "--path", str(root), "--format", "json", "--deterministic-id"]
    outputs = []
    for seed in ("1", "2"):
        completed = subprocess.run(command, capture_output=True, env={**os.environ, "PYTHONHASHSEED": seed}, check=False)
        assert completed.returncode == 1
        outputs.append(completed.stdout)
    assert len(json.loads(outputs[0])["issues"]) > 1
    assert outputs[0] == outputs[1]

