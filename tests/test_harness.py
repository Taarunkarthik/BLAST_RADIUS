import hashlib
import threading

import pytest
from fastapi.testclient import TestClient

from blastradius.harness import create_app


@pytest.fixture
def client(repository):
    root = repository({"main.ts": "import './missing';", "image.svg": "<svg/>"})
    with TestClient(create_app(root, token="test-session"), base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as client:
        client.headers["x-blastradius-token"] = "test-session"
        yield client


def test_browser_assets_and_session(client):
    response = client.get("/")
    assert response.status_code == 200
    assert 'content="test-session"' in response.text
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert client.get("/app.js").status_code == 200
    assert client.get("/styles.css").status_code == 200
    assert client.get("/api/session").status_code == 200
    assert client.get("/api/report").status_code == 404


def test_scan_and_report_are_read_only(client, tmp_path):
    def snapshot():
        return {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in tmp_path.iterdir() if file.is_file()}
    before = snapshot()
    response = client.post("/api/scan", json={"path": "."})
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["issues"][0]["type"] == "missing_local_module"
    assert report["scan"]["not_checked_types"] == [".svg"]
    assert client.get("/api/report").json() == report
    assert snapshot() == before


@pytest.mark.parametrize("headers", [
    {"origin": "https://attacker.example"}, {"origin": "null"},
    {"sec-fetch-site": "cross-site"}, {"host": "attacker.example"},
    {"x-blastradius-token": "wrong"},
])
def test_cross_site_host_and_session_guards(client, headers):
    assert client.post("/api/scan", json={}, headers=headers).status_code == 403


def test_missing_token_and_remote_client_rejected(repository):
    root = repository({})
    app = create_app(root, token="test-session")
    with TestClient(app, base_url="http://127.0.0.1", client=("127.0.0.1", 50000)) as browser:
        assert browser.get("/api/session").status_code == 403
    with TestClient(app, base_url="http://127.0.0.1", client=("192.0.2.1", 50000)) as remote:
        assert remote.get("/").status_code == 403


def test_paths_and_request_limits(client):
    assert client.post("/api/scan", json={"path": ".."}).status_code == 400
    assert client.post("/api/scan", json={"path": "missing"}).status_code == 400
    assert client.post("/api/scan", json={"max_files": 20001}).status_code == 422
    assert client.post("/api/scan", content="{}", headers={"content-type": "text/plain"}).status_code == 415
    assert client.post("/api/scan", content='{"path":"' + 'x' * 9000 + '"}', headers={"content-type": "application/json"}).status_code == 413


def test_scanning_symlink_escape_is_rejected(client, tmp_path):
    try:
        (tmp_path / "outside").symlink_to(tmp_path.parent, target_is_directory=True)
    except OSError:
        pytest.skip("Host does not permit symlinks")
    assert client.post("/api/scan", json={"path": "outside"}).status_code == 400


def test_save_requires_current_report_and_database(client, monkeypatch):
    monkeypatch.delenv("BLASTRADIUS_DATABASE_URL", raising=False)
    assert client.post("/api/save", json={"report_id": "stale"}).status_code == 409
    report = client.post("/api/scan", json={}).json()
    assert client.post("/api/save", json={"report_id": report["scan"]["id"]}).status_code == 422
    assert client.get("/api/history").status_code == 422


def test_overlapping_scan_is_rejected(client, monkeypatch):
    from blastradius import harness
    original = harness.scan_repository
    entered, release = threading.Event(), threading.Event()
    def delayed(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return original(*args, **kwargs)
    monkeypatch.setattr(harness, "scan_repository", delayed)
    result = []
    worker = threading.Thread(target=lambda: result.append(client.post("/api/scan", json={})))
    worker.start()
    try:
        assert entered.wait(5)
        assert client.post("/api/scan", json={}).status_code == 409
    finally:
        release.set()
        worker.join(timeout=15)
    assert result[0].status_code == 200
