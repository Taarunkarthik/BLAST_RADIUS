import json

from typer.testing import CliRunner

from blastradius.cli import app

runner = CliRunner()


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

