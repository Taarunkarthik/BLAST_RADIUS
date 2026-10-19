"""Structural tests for the BlastRadius browser-harness UI.

These tests are deliberately browser-free: they assert the *frozen* static
contract (entry points, view modules, hash routes, CSP hygiene) by reading the
shipped assets and by syntax-checking the ES modules with ``node --check``.

The module-layout assertions (view modules + routes) skip while the UI refactor
is in flight; the entry-point, syntax and CSP assertions always run.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

import pytest
from playwright.sync_api import expect, sync_playwright

from scripts.ui_capture import demo_server, verify_demo

REPO_ROOT = Path(__file__).resolve().parents[1]
STATIC = REPO_ROOT / "src" / "blastradius" / "static"

INDEX_HTML = STATIC / "index.html"
APP_JS = STATIC / "app.js"
STYLES_CSS = STATIC / "styles.css"

VIEWS_DIR = STATIC / "views"
VIEW_NAMES = ("overview", "findings", "map", "dependencies", "coverage", "history")

HASH_ROUTES = ("#overview", "#findings", "#map", "#dependencies", "#coverage", "#history")

REFACTOR_IN_PROGRESS = "UI refactor in progress"

# `export function render`, `export async function render`, `export const render`,
# `export { render }`, `export { render as default }`, `export { render } from …`
_RENDER_EXPORTS = (
    re.compile(r"\bexport\s+(?:async\s+)?function\s+render\b"),
    re.compile(r"\bexport\s+(?:const|let|var)\s+render\b"),
    re.compile(r"\bexport\s*\{[^}]*\brender\b[^}]*\}"),
)
_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_LINE_COMMENT = re.compile(r"^[ \t]*//.*$", re.MULTILINE)


def _strip_comments(source: str) -> str:
    """Drop comments so prose like "Contract: export function render" cannot pass."""
    return _LINE_COMMENT.sub("", _BLOCK_COMMENT.sub("", source))


def _exports_render(source: str) -> bool:
    code = _strip_comments(source)
    return any(pattern.search(code) for pattern in _RENDER_EXPORTS)


def _refactor_incomplete() -> str | None:
    """Return why the module layout cannot be asserted yet, or None when ready."""
    if not VIEWS_DIR.is_dir():
        return f"{VIEWS_DIR.name}/ does not exist yet"
    missing = [name for name in VIEW_NAMES if not (VIEWS_DIR / f"{name}.js").is_file()]
    if missing:
        return f"missing view modules: {', '.join(missing)}"
    return None


class _AssetScan(HTMLParser):
    """Collect <script>/<link> tags plus every src/href attribute in the shell."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.script_tags: list[dict[str, str]] = []
        self.inline_script_bodies: list[str] = []
        self.link_tags: list[dict[str, str]] = []
        self.references: list[tuple[str, str, str]] = []
        self._collecting = False
        self._buffer: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {name.lower(): (value or "") for name, value in attrs}
        for name, value in attributes.items():
            if name in {"src", "href"}:
                self.references.append((tag, name, value))
        if tag == "script":
            self.script_tags.append(attributes)
            if "src" not in attributes:
                self._collecting = True
                self._buffer = []
        elif tag == "link":
            self.link_tags.append(attributes)

    def handle_data(self, data: str) -> None:
        if self._collecting:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._collecting:
            self.inline_script_bodies.append("".join(self._buffer))
            self._collecting = False
            self._buffer = []

    def close(self) -> None:
        super().close()
        if self._collecting:  # unterminated <script> still counts as inline code
            self.inline_script_bodies.append("".join(self._buffer))
            self._collecting = False
            self._buffer = []


@pytest.fixture(scope="module")
def index_source() -> str:
    return INDEX_HTML.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def index_scan(index_source: str) -> _AssetScan:
    scan = _AssetScan()
    scan.feed(index_source)
    scan.close()
    return scan


def test_entry_point_files_exist() -> None:
    for path in (INDEX_HTML, APP_JS, STYLES_CSS):
        assert path.is_file(), f"missing frozen entry point: {path.relative_to(REPO_ROOT)}"


def test_index_html_references_app_and_styles(index_source: str) -> None:
    assert "app.js" in index_source, "index.html must reference app.js"
    assert "styles.css" in index_source, "index.html must reference styles.css"


def test_javascript_modules_pass_node_syntax_check() -> None:
    modules = sorted(
        path
        for path in STATIC.rglob("*.js")
        if "node_modules" not in path.parts and path.is_file()
    )
    assert modules, f"no *.js modules found under {STATIC.relative_to(REPO_ROOT)}"

    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not available on PATH; skipping ES module syntax checks")

    for module in modules:
        relative = module.relative_to(REPO_ROOT)
        try:
            subprocess.run(
                [node, "--check", str(module)],
                check=True,
                capture_output=True,
                text=True,
            )
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or error.stdout or "").strip()
            pytest.fail(f"node --check failed for {relative}:\n{detail}")


@pytest.mark.parametrize("name", VIEW_NAMES)
def test_view_module_exports_render(name: str) -> None:
    module = VIEWS_DIR / f"{name}.js"
    if not module.is_file():
        pytest.skip(f"{REFACTOR_IN_PROGRESS}: {module.name} is not present yet")
    source = module.read_text(encoding="utf-8")
    assert _exports_render(source), f"{module.name} must export a render function"


def test_app_js_mentions_every_hash_route() -> None:
    incomplete = _refactor_incomplete()
    if incomplete is not None:
        pytest.skip(f"{REFACTOR_IN_PROGRESS}: {incomplete}")

    source = APP_JS.read_text(encoding="utf-8")
    missing = [route for route in HASH_ROUTES if route not in source]
    assert not missing, f"app.js does not mention hash route(s): {', '.join(missing)}"


def test_index_html_has_no_inline_script_bodies(index_scan: _AssetScan) -> None:
    inline = [body for body in index_scan.inline_script_bodies if body.strip()]
    assert not inline, f"index.html contains {len(inline)} inline <script> body(ies); CSP forbids them"


def test_index_html_has_no_external_http_assets(index_scan: _AssetScan) -> None:
    external = [
        f"<{tag} {attr}=\"{value}\">"
        for tag, attr, value in index_scan.references
        if urlparse(value).scheme in {"http", "https"}
    ]
    assert not external, f"index.html references external URL(s): {', '.join(external)}"


def test_demo_ui_coverage_and_finding_filters():
    with sync_playwright() as playwright:
        if not Path(playwright.chromium.executable_path).is_file():
            pytest.skip("Install Chromium with: python -m playwright install chromium")
        with demo_server() as url:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                verify_demo(page, url)
                page.locator('[data-view="findings"]').click()
                page.get_by_role("textbox", name="Search findings").fill("styles")
                expect(page.locator(".findings-panel .count")).to_have_text("1")
                expect(page.locator(".detail-panel")).to_contain_text("No Tree Impact")
                page.get_by_role("textbox", name="Search findings").fill("")
                page.get_by_role("combobox", name="Filter severity").select_option("high")
                expect(page.locator(".findings-panel .count")).to_have_text("1")
                expect(page.locator(".detail-panel")).to_contain_text("src/Chart.tsx")
                expect(page.locator(".detail-panel")).to_contain_text("3 affected / 4 eligible files")
                assert errors == []
            finally:
                browser.close()
