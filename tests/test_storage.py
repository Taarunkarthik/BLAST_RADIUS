import json
import os
from copy import deepcopy

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from blastradius.cli import app
from blastradius.harness import create_app
from blastradius.scanner import scan_repository
from blastradius.storage import ScanStore, StoreError


def test_plain_scan_does_not_need_database(repository, monkeypatch):
    monkeypatch.delenv("BLASTRADIUS_DATABASE_URL", raising=False)
    root = repository({"good.json": "{}"})
    result = CliRunner().invoke(app, ["scan", "--path", str(root), "--format", "json"])
    assert result.exit_code == 0
    saved = CliRunner().invoke(app, ["scan", "--path", str(root), "--save", "--format", "json"])
    assert saved.exit_code == 2
    assert "BLASTRADIUS_DATABASE_URL" in json.loads(saved.stdout)["error"]["message"]


@pytest.fixture
def store():
    url = os.environ.get("BLASTRADIUS_TEST_DATABASE_URL")
    if not url:
        pytest.skip("PostgreSQL integration: set BLASTRADIUS_TEST_DATABASE_URL")
    value = ScanStore(url)
    value.initialize()
    return value


def test_postgres_registration_save_load_and_normalized_records(store, repository):
    root = repository({"main.ts": "import './missing';", "data.json": "{"})
    project = store.add_project(root, "Integration project")
    assert store.add_project(root)["id"] == project["id"]
    report = scan_repository(root, deterministic=True)
    saved = store.save(report, root)
    assert store.load(saved["id"])["report"] == report
    assert store.save(report, root) == saved
    assert len(store.scans(project["id"])) == 1
    with store._connection() as connection:
        assert connection.execute("SELECT count(*) AS n FROM issues WHERE scan_id=%s", (saved["id"],)).fetchone()["n"] == 2
        assert connection.execute("SELECT count(*) AS n FROM dependencies WHERE scan_id=%s", (saved["id"],)).fetchone()["n"] == 1
        assert connection.execute("SELECT count(*) AS n FROM impacts WHERE scan_id=%s", (saved["id"],)).fetchone()["n"] == 1
        assert connection.execute("SELECT has_tree_impact FROM issues WHERE scan_id=%s AND file='data.json'", (saved["id"],)).fetchone()["has_tree_impact"] is False


def test_postgres_match_and_immutable_scan_protection(store, repository):
    root = repository({"bad.json": "{"})
    with pytest.raises(StoreError, match="does not match"):
        store.save(scan_repository(root), root)
    project = store.add_project(root)
    with pytest.raises(StoreError, match="does not match"):
        store.match_project(root, "wrong-project")
    report = scan_repository(root, deterministic=True)
    saved = store.save(report, root, project_id=project["id"])
    changed = deepcopy(report)
    changed["issues"][0]["line"] = 123
    with pytest.raises(StoreError, match="immutable"):
        store.save(changed, root)
    assert store.load(saved["id"])["report"] == report


def test_postgres_transaction_rolls_back_on_invalid_issue(store, repository):
    root = repository({"bad.json": "{"})
    project = store.add_project(root)
    report = scan_repository(root)
    report["issues"][0]["line"] = 0
    with pytest.raises(StoreError):
        store.save(report, root)
    assert store.scans(project["id"]) == []


def test_postgres_cli_save_compare_flow(store, repository, monkeypatch):
    monkeypatch.setenv("BLASTRADIUS_DATABASE_URL", store.database_url)
    root = repository({"bad.json": "{"})
    runner = CliRunner()
    project = runner.invoke(app, ["--format", "json", "project", "add", "--path", str(root)])
    assert project.exit_code == 0, project.output
    args = ["scan", "--path", str(root), "--save", "--format", "json", "--deterministic-id", "--fail-on", "none"]
    base = runner.invoke(app, args)
    assert base.exit_code == 0, base.output
    (root / "bad.json").write_text("{}")
    head = runner.invoke(app, args)
    assert head.exit_code == 0, head.output
    comparison = runner.invoke(app, ["compare", json.loads(base.stdout)["storage"]["id"], json.loads(head.stdout)["storage"]["id"], "--format", "json"])
    assert comparison.exit_code == 0, comparison.output
    assert json.loads(comparison.stdout)["summary"]["resolved"] == 1


def test_postgres_migrations_repeat_and_ids_are_project_scoped(store, repository):
    assert store.initialize()["schema_version"] == 1
    root = repository({"one/a.json": "{}", "two/a.json": "{}"})
    first, second = root / "one", root / "two"
    store.add_project(first)
    store.add_project(second)
    a, b = scan_repository(first, deterministic=True), scan_repository(second, deterministic=True)
    assert a["scan"]["id"] == b["scan"]["id"]
    assert store.save(a, first)["id"] != store.save(b, second)["id"]


def test_postgres_harness_save_history_compare_and_project_scope(store, repository, monkeypatch):
    monkeypatch.setenv("BLASTRADIUS_DATABASE_URL", store.database_url)
    root = repository({"bad.json": "{", "nested/good.json": "{}"})
    project = store.add_project(root)
    with TestClient(create_app(root, token="test-session"), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as browser:
        browser.headers["x-blastradius-token"] = "test-session"
        assert browser.get("/api/session").json()["persistence"] is True
        base = browser.post("/api/scan", json={}).json()
        saved = browser.post("/api/save", json={"report_id": base["scan"]["id"]})
        assert saved.status_code == 200, saved.text
        base_id = saved.json()["id"]
        (root / "bad.json").write_text("{}")
        head = browser.post("/api/scan", json={}).json()
        saved = browser.post("/api/save", json={"report_id": head["scan"]["id"]})
        assert saved.status_code == 200, saved.text
        head_id = saved.json()["id"]
        history = browser.get("/api/history").json()
        assert history["project"]["id"] == project["id"]
        assert {scan["id"] for scan in history["scans"]} == {base_id, head_id}
        comparison = browser.post("/api/compare", json={"base": base_id, "head": head_id})
        assert comparison.status_code == 200, comparison.text
        assert comparison.json()["summary"]["resolved"] == 1
        nested = root / "nested"
        store.add_project(nested)
        outside_history = store.save(scan_repository(nested, deterministic=True), nested)
        assert browser.post("/api/compare", json={"base": base_id, "head": outside_history["id"]}).status_code == 403
        subreport = browser.post("/api/scan", json={"path": "nested"}).json()
        assert browser.post("/api/save", json={"report_id": subreport["scan"]["id"]}).status_code == 422
