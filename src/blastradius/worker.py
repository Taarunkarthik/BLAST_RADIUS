"""One long-lived Node process; request/response NDJSON protocol v1."""

import json
import os
import queue
import shutil
import subprocess
import threading
from pathlib import Path

RUNTIME = Path(__file__).with_name("node")


class WorkerError(RuntimeError):
    pass


class NodeWorker:
    def __init__(self, timeout: float = 60):
        node = shutil.which("node")
        if not node:
            raise WorkerError("Node.js 20 or newer is required for JS/TS, CSS/SCSS, and JSONC checks.")
        if not (RUNTIME / "node_modules" / "typescript").is_dir():
            raise WorkerError("Parser dependencies are not installed. Run 'blastradius setup' once before scanning.")
        env = {key: value for key, value in os.environ.items() if key not in {"NODE_OPTIONS", "NODE_PATH"}}
        self.process = subprocess.Popen(
            [node, str(RUNTIME / "worker.mjs")], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            encoding="utf-8", cwd=RUNTIME, env=env,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        self.timeout = timeout
        self.responses = queue.Queue()
        self.sequence = 0
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        try:
            for line in self.process.stdout:
                self.responses.put(line)
        finally:
            self.responses.put(None)

    def request(self, method: str, **params) -> dict:
        self.sequence += 1
        request = {"version": 1, "id": self.sequence, "method": method, "params": params}
        try:
            self.process.stdin.write(json.dumps(request, ensure_ascii=True) + "\n")
            self.process.stdin.flush()
            line = self.responses.get(timeout=self.timeout)
        except (BrokenPipeError, OSError, queue.Empty) as exc:
            self.close()
            raise WorkerError("Parser worker failed or exceeded its response deadline.") from exc
        if line is None:
            raise WorkerError("Parser worker exited before returning a report.")
        try:
            response = json.loads(line)
        except ValueError as exc:
            raise WorkerError("Parser worker returned invalid NDJSON.") from exc
        if response.get("version") != 1 or response.get("id") != self.sequence:
            raise WorkerError("Parser worker protocol/version mismatch.")
        if "error" in response:
            raise WorkerError(response["error"])
        return response["result"]

    def close(self):
        if self.process.poll() is None:
            # EOF lets readline drain and exit normally; terminate only a stuck worker.
            try:
                self.process.stdin.close()
            except OSError:
                pass
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.reader.join(timeout=1)
        for stream in (self.process.stdin, self.process.stdout):
            if stream:
                stream.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
