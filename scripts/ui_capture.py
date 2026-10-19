"""Capture the real demo harness in an isolated, short-lived local server."""

import argparse
import socket
import threading
import time
from contextlib import contextmanager
from pathlib import Path

import uvicorn
from playwright.sync_api import Page, expect, sync_playwright

from blastradius.harness import create_app

ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def demo_server():
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(create_app(ROOT / "examples/demo"), log_level="error", access_log=False))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            deadline = time.monotonic() + 10
            while not server.started:
                if not thread.is_alive() or time.monotonic() > deadline:
                    raise RuntimeError("Demo harness did not start.")
                time.sleep(0.05)
            yield f"http://127.0.0.1:{port}"
        finally:
            server.should_exit = True
            thread.join(timeout=10)


def verify_demo(page: Page, url: str) -> None:
    page.goto(url)
    expect(page.locator("#project-name")).to_have_text("demo")
    page.get_by_role("button", name="Run scan", exact=True).click()
    expect(page.locator("#metric-files")).to_have_text("10", timeout=30000)
    expect(page.locator("#metric-coverage")).to_have_text("10 discovered · 0 unsupported")
    expect(page.locator("#metric-issues")).to_have_text("5")
    expect(page.locator("#metric-affected")).to_have_text("3")
    expect(page.locator("#detail")).to_contain_text("3 affected / 4 eligible files (75%)")
    page.get_by_role("button", name="Coverage", exact=True).click()
    expect(page.get_by_role("heading", name="Unsupported files (0)", exact=True)).to_be_visible()
    expect(page.get_by_role("heading", name="Checked files (10)", exact=True)).to_be_visible()
    expect(page.locator("#coverage")).to_contain_text("icon.svg")
    page.get_by_role("button", name="Overview", exact=True).click()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "docs/assets/harness.png")
    args = parser.parse_args()
    with demo_server() as url, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
            verify_demo(page, url)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(args.output), full_page=True)
            print(f"Saved {args.output}")
            print("Demo: 10 / 10 checked; 0 unsupported; 5 findings; 3 affected files.")
        finally:
            browser.close()


if __name__ == "__main__":
    main()
