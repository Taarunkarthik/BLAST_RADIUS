import hashlib
import threading

import anyio
import httpx
import pytest

from blastradius.harness import create_app

pytestmark = pytest.mark.anyio


def transport(app, *, client=("127.0.0.1", 50000)):
    return httpx.ASGITransport(app=app, client=client)


@pytest.fixture
async def client(repository):
    root = repository({"main.ts": "import './missing';", "image.svg": "<svg/>"})
    app = create_app(root, token="test-session")
    async with httpx.AsyncClient(
        transport=transport(app), base_url="http://127.0.0.1", headers={"x-blastradius-token": "test-session"}
    ) as client:
        yield client


async def test_browser_assets_and_session(client):
    response = await client.get("/")
    assert response.status_code == 200
    assert 'content="test-session"' in response.text
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]
    assert (await client.get("/app.js")).status_code == 200
    assert (await client.get("/styles.css")).status_code == 200
    assert (await client.get("/api/session")).status_code == 200
    assert (await client.get("/api/report")).status_code == 404


@pytest.mark.parametrize("path", [
    "/static/app.js",
    "/static/styles.css",
    "/static/lib/api.js",
    "/static/lib/dom.js",
    "/static/lib/state.js",
    "/static/lib/format.js",
    "/static/lib/tree.js",
    "/static/lib/graph.js",
    "/static/views/overview.js",
    "/static/views/findings.js",
    "/static/views/map.js",
    "/static/views/dependencies.js",
    "/static/views/coverage.js",
    "/static/views/history.js",
    "/static/styles/overview.css",
    "/static/styles/findings.css",
    "/static/styles/map.css",
    "/static/styles/dependencies.css",
    "/static/styles/coverage.css",
    "/static/styles/history.css",
    # The same assets are served at the web root for the document-relative
    # URLs used by index.html.
    "/app.js",
    "/styles.css",
    "/lib/api.js",
    "/views/overview.js",
    "/styles/overview.css",
])
async def test_static_modules_are_served(client, path):
    response = await client.get(path)
    assert response.status_code == 200, path
    assert response.headers["cache-control"] == "no-store"
    expected = "text/css" if path.endswith(".css") else "text/javascript"
    assert response.headers["content-type"].startswith(expected)


async def test_static_serving_rejects_escapes_and_missing_files(client):
    assert (await client.get("/static/../harness.py")).status_code in (403, 404)
    assert (await client.get("/static/lib/%2e%2e/%2e%2e/harness.py")).status_code in (403, 404)
    assert (await client.get("/static/views/missing.js")).status_code == 404


async def test_index_references_served_entry_points(client):
    html = (await client.get("/")).text
    assert 'src="app.js"' in html
    assert 'href="styles.css"' in html
    # CSP allows same-origin files only: every script must have a src and no
    # element may carry a style attribute.
    import re
    assert all("src=" in tag for tag in re.findall(r"<script\b[^>]*>", html))
    assert "style=" not in html.lower()


async def test_scan_and_report_are_read_only(client, tmp_path):
    def snapshot():
        return {file.name: hashlib.sha256(file.read_bytes()).hexdigest() for file in tmp_path.iterdir() if file.is_file()}
    before = snapshot()
    response = await client.post("/api/scan", json={"path": "."})
    assert response.status_code == 200, response.text
    report = response.json()
    assert report["issues"][0]["type"] == "missing_local_module"
    assert report["scan"]["not_checked_types"] == [".svg"]
    assert (await client.get("/api/report")).json() == report
    assert snapshot() == before


@pytest.mark.parametrize("headers", [
    {"origin": "https://attacker.example"}, {"origin": "null"},
    {"sec-fetch-site": "cross-site"}, {"host": "attacker.example"},
    {"x-blastradius-token": "wrong"},
])
async def test_cross_site_host_and_session_guards(client, headers):
    assert (await client.post("/api/scan", json={}, headers=headers)).status_code == 403


async def test_missing_token_and_remote_client_rejected(repository):
    root = repository({})
    app = create_app(root, token="test-session")
    async with httpx.AsyncClient(transport=transport(app), base_url="http://127.0.0.1") as browser:
        assert (await browser.get("/api/session")).status_code == 403
    async with httpx.AsyncClient(transport=transport(app, client=("192.0.2.1", 50000)), base_url="http://127.0.0.1") as remote:
        assert (await remote.get("/")).status_code == 403


async def test_paths_and_request_limits(client):
    assert (await client.post("/api/scan", json={"path": ".."})).status_code == 400
    assert (await client.post("/api/scan", json={"path": "missing"})).status_code == 400
    assert (await client.post("/api/scan", json={"max_files": 20001})).status_code == 422
    assert (await client.post("/api/scan", content="{}", headers={"content-type": "text/plain"})).status_code == 415
    assert (await client.post("/api/scan", content='{"path":"' + 'x' * 9000 + '"}', headers={"content-type": "application/json"})).status_code == 413


async def test_scanning_symlink_escape_is_rejected(client, tmp_path):
    try:
        (tmp_path / "outside").symlink_to(tmp_path.parent, target_is_directory=True)
    except OSError:
        pytest.skip("Host does not permit symlinks")
    assert (await client.post("/api/scan", json={"path": "outside"})).status_code == 400


async def test_save_requires_current_report_and_database(client, monkeypatch):
    monkeypatch.delenv("BLASTRADIUS_DATABASE_URL", raising=False)
    assert (await client.post("/api/save", json={"report_id": "stale"})).status_code == 409
    report = (await client.post("/api/scan", json={})).json()
    assert (await client.post("/api/save", json={"report_id": report["scan"]["id"]})).status_code == 422
    assert (await client.get("/api/history")).status_code == 422


async def test_overlapping_scan_is_rejected(client, monkeypatch):
    from blastradius import harness
    original = harness.scan_repository
    entered, release = threading.Event(), threading.Event()
    def delayed(*args, **kwargs):
        entered.set()
        assert release.wait(10)
        return original(*args, **kwargs)
    monkeypatch.setattr(harness, "scan_repository", delayed)
    result = []

    async def overlapping_scan():
        result.append(await client.post("/api/scan", json={}))

    async with anyio.create_task_group() as group:
        group.start_soon(overlapping_scan)
        with anyio.fail_after(5):
            while not entered.is_set():
                await anyio.sleep(0.01)
        assert (await client.post("/api/scan", json={})).status_code == 409
        release.set()
    assert result[0].status_code == 200
