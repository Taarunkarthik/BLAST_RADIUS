"""Capture a full-page screenshot of the BlastRadius browser harness.

The desktop-browser tooling is not always available, so this script drives a real
local Chrome over the DevTools Protocol (CDP) and writes a PNG. It is intentionally
self-contained: Chrome is launched headless with a throwaway profile, and the CDP
traffic runs over a minimal standard-library WebSocket client. No third-party
package (selenium/playwright/websockets) is required.

Transport choice
----------------
No websocket library is installed in this environment, so rather than add a dev
dependency the client implements the RFC 6455 handshake and framing directly on a
raw socket (localhost traffic only: client frames masked, server frames unmasked,
ping/pong handled, continuation frames reassembled). If that ever fails, a degraded
manual fallback is Chrome's own one-shot capture of the *pre-scan* page:

    chrome --headless=new --screenshot=out.png --window-size=1440,1400 <url>

That fallback cannot click "Run scan", so it misses the populated finding list.

Usage
-----
    python scripts/ui_capture.py --url http://127.0.0.1:8765 --out docs/assets/harness.png

Or verify and capture an isolated demo (requires the dev and harness extras):

    python scripts/ui_capture.py --demo

Without --demo, the harness must already be running, for example:

    python -m blastradius harness --path examples/demo --port 8765
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from playwright.sync_api import Page

DEFAULT_URL = "http://127.0.0.1:8765"
DEFAULT_OUT = "docs/assets/harness.png"
DEFAULT_WIDTH = 1440
DEFAULT_HEIGHT = 1400
DEFAULT_CLICK = "#scan-button"
DEFAULT_WAIT = ".overview-meta"
DEFAULT_TIMEOUT = 30.0

# Standard install locations, tried after PATH lookups. Edge is a usable fallback
# because it speaks the same DevTools Protocol.
CHROME_NAMES = (
    "chrome",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "msedge",
)
CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
)


class CaptureError(RuntimeError):
    """Raised when the screenshot cannot be produced."""


def find_chrome(explicit: str | None = None) -> str:
    """Return a path to a Chrome/Edge binary or raise a helpful error."""
    if explicit:
        if Path(explicit).is_file():
            return str(Path(explicit))
        raise CaptureError(f"--chrome path does not exist: {explicit}")

    for variable in ("BLASTRADIUS_CHROME", "CHROME_PATH"):
        candidate = os.environ.get(variable)
        if candidate and Path(candidate).is_file():
            return candidate

    for name in CHROME_NAMES:
        located = shutil.which(name)
        if located:
            return located

    for candidate in CHROME_PATHS:
        if Path(candidate).is_file():
            return candidate

    raise CaptureError(
        "Could not locate Chrome or Edge. Install Chrome, or pass --chrome <path>.\n"
        "Looked on PATH for " + ", ".join(CHROME_NAMES) + " and at:\n  "
        + "\n  ".join(CHROME_PATHS)
    )


def free_port() -> int:
    """Reserve and release a loopback TCP port for the DevTools endpoint."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


class WebSocket:
    """Minimal RFC 6455 client, sufficient for local DevTools traffic."""

    def __init__(self, url: str, timeout: float = DEFAULT_TIMEOUT) -> None:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme != "ws":
            raise CaptureError(f"Unsupported DevTools websocket URL: {url}")
        self._host = parts.hostname or "127.0.0.1"
        self._port = parts.port or 80
        self._resource = parts.path or "/"
        if parts.query:
            self._resource = f"{self._resource}?{parts.query}"
        self._buffer = b""
        self._closed = False
        self._sock = socket.create_connection((self._host, self._port), timeout=timeout)
        self._sock.settimeout(timeout)
        self._handshake()

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self._resource} HTTP/1.1\r\n"
            f"Host: {self._host}:{self._port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(request.encode("ascii"))
        header = b""
        while b"\r\n\r\n" not in header:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise CaptureError("DevTools websocket closed during handshake")
            header += chunk
        head, _, remainder = header.partition(b"\r\n\r\n")
        status_line = head.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101 " not in status_line:
            raise CaptureError(f"DevTools websocket handshake failed: {status_line}")
        self._buffer = remainder

    def _recv_exact(self, count: int) -> bytes:
        while len(self._buffer) < count:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise CaptureError("DevTools websocket closed unexpectedly")
            self._buffer += chunk
        data, self._buffer = self._buffer[:count], self._buffer[count:]
        return data

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        header = bytearray([0x80 | opcode])  # FIN set; no RSV bits
        mask = os.urandom(4)
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < 65536:
            header.append(0x80 | 126)
            header += struct.pack("!H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack("!Q", length)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._sock.sendall(bytes(header) + mask + masked)

    def _recv_frame(self) -> tuple[int, bytes, bool]:
        first, second = self._recv_exact(2)
        fin = bool(first & 0x80)
        opcode = first & 0x0F
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        masked = bool(second & 0x80)
        mask = self._recv_exact(4) if masked else b""
        payload = self._recv_exact(length)
        if masked:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        return opcode, payload, fin

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_text(self) -> str:
        fragments = bytearray()
        opcode = 0x1
        while True:
            frame_opcode, payload, fin = self._recv_frame()
            if frame_opcode == 0x8:
                raise CaptureError("DevTools websocket closed by peer")
            if frame_opcode == 0x9:  # ping
                self._send_frame(0xA, payload)
                continue
            if frame_opcode == 0xA:  # pong
                continue
            if frame_opcode != 0x0:
                opcode = frame_opcode
            fragments += payload
            if fin:
                break
        if opcode == 0x2:
            raise CaptureError("Unexpected binary frame from DevTools")
        return fragments.decode("utf-8")

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_frame(0x8, b"")
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass


class CDP:
    """Synchronous request/response wrapper over a DevTools websocket."""

    def __init__(self, websocket: WebSocket) -> None:
        self._ws = websocket
        self._next_id = 0

    def call(self, method: str, params: dict | None = None, session_id: str | None = None) -> dict:
        self._next_id += 1
        message: dict = {"id": self._next_id, "method": method}
        if params:
            message["params"] = params
        if session_id:
            message["sessionId"] = session_id
        self._ws.send_text(json.dumps(message))
        while True:
            payload = json.loads(self._ws.recv_text())
            if payload.get("id") == self._next_id:
                if "error" in payload:
                    raise CaptureError(f"DevTools {method} failed: {payload['error']}")
                return payload.get("result", {})


def http_json(url: str, timeout: float) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def check_harness(url: str, timeout: float) -> None:
    """Fail early with an actionable message when the harness is not serving."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            response.read(1)
    except urllib.error.HTTPError:
        return  # The server answered; an error status is still reachable.
    except (urllib.error.URLError, OSError) as error:
        raise CaptureError(
            f"Harness not reachable at {url} ({error}).\n"
            "Start it first, for example:\n"
            "  python -m blastradius harness --path examples/demo --port 8765"
        ) from error


def launch_chrome(chrome: str, port: int, profile: str, width: int, height: int) -> subprocess.Popen:
    args = [
        chrome,
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--remote-allow-origins=*",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        f"--window-size={width},{height}",
        "about:blank",
    ]
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_for_devtools(port: int, timeout: float) -> dict:
    endpoint = f"http://127.0.0.1:{port}/json/version"
    deadline = time.monotonic() + timeout
    last_error = "no response yet"
    while time.monotonic() < deadline:
        try:
            return http_json(endpoint, timeout=1.0)
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as error:
            last_error = str(error)
            time.sleep(0.1)
    raise CaptureError(
        f"Chrome DevTools endpoint did not start on port {port} within {timeout:.0f}s ({last_error})."
    )


def evaluate(cdp: CDP, session_id: str, expression: str) -> object:
    result = cdp.call(
        "Runtime.evaluate",
        {"expression": expression, "returnByValue": True},
        session_id=session_id,
    )
    return result.get("result", {}).get("value")


def wait_ready(cdp: CDP, session_id: str, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if evaluate(cdp, session_id, "document.readyState") == "complete":
                return
        except CaptureError:
            pass  # Execution context not ready yet; retry until the deadline.
        time.sleep(0.1)
    raise CaptureError(f"Page did not finish loading within {timeout:.0f}s")


def click_element(cdp: CDP, session_id: str, selector: str) -> bool:
    selector_json = json.dumps(selector)
    expression = (
        f"(() => {{ const element = document.querySelector({selector_json});"
        " if (!element) { return false; } element.click(); return true; })()"
    )
    return bool(evaluate(cdp, session_id, expression))


def wait_for_selector(cdp: CDP, session_id: str, selector: str, timeout: float) -> bool:
    expression = f"Boolean(document.querySelector({json.dumps(selector)}))"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if evaluate(cdp, session_id, expression):
                return True
        except CaptureError:
            pass
        time.sleep(0.1)
    return False


def png_size(data: bytes) -> tuple[int, int]:
    """Read the pixel dimensions from a PNG IHDR chunk."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise CaptureError("Chrome did not return a valid PNG payload")
    width, height = struct.unpack(">II", data[16:24])
    return width, height


def kill_process_tree(process: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(process.pid)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def capture(args: argparse.Namespace) -> tuple[Path, int, int, int]:
    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if urllib.parse.urlsplit(args.url).scheme in ("http", "https"):
        check_harness(args.url, timeout=min(args.timeout, 5.0))

    chrome = find_chrome(args.chrome)
    port = free_port()
    profile = tempfile.mkdtemp(prefix="blastradius-ui-capture-")
    process: subprocess.Popen | None = None
    websocket: WebSocket | None = None
    try:
        process = launch_chrome(chrome, port, profile, args.width, args.height)
        version = wait_for_devtools(port, args.timeout)
        browser_url = version.get("webSocketDebuggerUrl")
        if not browser_url:
            raise CaptureError("Chrome DevTools did not expose a browser websocket URL")

        websocket = WebSocket(browser_url, timeout=args.timeout)
        cdp = CDP(websocket)

        target = cdp.call("Target.createTarget", {"url": "about:blank"})
        attached = cdp.call(
            "Target.attachToTarget", {"targetId": target["targetId"], "flatten": True}
        )
        session_id = attached["sessionId"]

        cdp.call("Page.enable", session_id=session_id)
        cdp.call(
            "Emulation.setDeviceMetricsOverride",
            {
                "width": args.width,
                "height": args.height,
                "deviceScaleFactor": 1,
                "mobile": False,
            },
            session_id=session_id,
        )
        cdp.call("Page.navigate", {"url": args.url}, session_id=session_id)
        wait_ready(cdp, session_id, args.timeout)

        if args.click:
            if click_element(cdp, session_id, args.click):
                print(f"Clicked {args.click}", file=sys.stderr)
            else:
                print(
                    f"Warning: click target {args.click!r} not found; capturing without clicking.",
                    file=sys.stderr,
                )

        if args.wait:
            if wait_for_selector(cdp, session_id, args.wait, args.timeout):
                print(f"Found {args.wait}", file=sys.stderr)
            else:
                print(
                    f"Warning: wait target {args.wait!r} did not appear within "
                    f"{args.timeout:.0f}s; capturing the current page anyway.",
                    file=sys.stderr,
                )

        time.sleep(0.4)  # Let layout and paint settle before the capture.
        shot = cdp.call(
            "Page.captureScreenshot",
            {"format": "png", "captureBeyondViewport": True},
            session_id=session_id,
        )
        data = base64.b64decode(shot.get("data", ""))
        width, height = png_size(data)
        out_path.write_bytes(data)
        return out_path, width, height, len(data)
    finally:
        if websocket is not None:
            websocket.close()
        if process is not None:
            kill_process_tree(process)
        shutil.rmtree(profile, ignore_errors=True)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--demo", action="store_true", help="Verify and capture an isolated demo using Playwright (dev and harness extras).")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"Harness URL (default: {DEFAULT_URL}).")
    parser.add_argument("--out", default=DEFAULT_OUT, help=f"Output PNG path (default: {DEFAULT_OUT}).")
    parser.add_argument(
        "--width", type=int, default=DEFAULT_WIDTH, help=f"Viewport width (default: {DEFAULT_WIDTH})."
    )
    parser.add_argument(
        "--height",
        type=int,
        default=DEFAULT_HEIGHT,
        help=f"Viewport height (default: {DEFAULT_HEIGHT}).",
    )
    parser.add_argument(
        "--click",
        default=DEFAULT_CLICK,
        help=f"CSS selector to click before capture; empty to skip (default: {DEFAULT_CLICK}).",
    )
    parser.add_argument(
        "--wait",
        default=DEFAULT_WAIT,
        help=f"CSS selector to await after clicking; empty to skip (default: {DEFAULT_WAIT}).",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT,
        help=f"Seconds to wait per step (default: {DEFAULT_TIMEOUT:.0f}).",
    )
    parser.add_argument("--chrome", default=None, help="Explicit path to a Chrome/Edge binary.")
    return parser.parse_args(argv)


ROOT = Path(__file__).resolve().parents[1]


@contextmanager
def demo_server():
    import uvicorn

    from blastradius.harness import create_app

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
    from playwright.sync_api import expect

    page.goto(url)
    expect(page.locator("#project-name")).to_have_text("demo")
    page.get_by_role("button", name="Run scan", exact=True).click()
    expect(page.locator(".metric").filter(has_text="Files checked").locator("strong")).to_have_text("10", timeout=30000)
    expect(page.locator(".metric").filter(has_text="Files checked")).to_contain_text("10 discovered · 0 unsupported")
    expect(page.locator(".metric").filter(has_text="Issues found").locator("strong")).to_have_text("5")
    expect(page.locator(".metric").filter(has_text="Affected files").locator("strong")).to_have_text("3")
    page.get_by_role("button", name="Coverage", exact=True).click()
    expect(page.get_by_role("heading", name="Unsupported files (0)", exact=True)).to_be_visible()
    expect(page.get_by_role("heading", name="Checked files (10)", exact=True)).to_be_visible()
    expect(page.locator(".coverage-panel")).to_contain_text("icon.svg")
    page.get_by_role("button", name="Overview", exact=True).click()



def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.demo:
        from playwright.sync_api import sync_playwright

        with demo_server() as url, sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(viewport={"width": args.width, "height": args.height}, device_scale_factor=1)
                verify_demo(page, url)
                output = Path(args.out)
                output.parent.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(output), full_page=True)
                print(f"Saved {output}")
                print("Demo: 10 / 10 checked; 0 unsupported; 5 findings; 3 affected files.")
            finally:
                browser.close()
        return 0
    try:
        out_path, width, height, size = capture(args)
    except CaptureError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("error: interrupted", file=sys.stderr)
        return 130
    print(f"Wrote {out_path}")
    print(f"Image size: {width}x{height}px")
    print(f"Bytes: {size}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
