"""Reproducible local benchmark; creates only a temporary fixture, never a target repo."""

import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

from blastradius.scanner import scan_repository


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--files", type=int, default=1000)
    args = parser.parse_args()
    if args.files < 2:
        parser.error("--files must be at least 2")
    with TemporaryDirectory(prefix="blastradius-benchmark-") as temporary:
        root = Path(temporary)
        (root / "broken.ts").write_text("import './missing'; export const x = 1;", encoding="utf-8")
        for number in range(args.files - 1):
            (root / f"consumer-{number:05}.ts").write_text("import { x } from './broken'; export { x };", encoding="utf-8")
        start = perf_counter()
        report = scan_repository(root, deterministic=True, max_files=args.files)
        elapsed = perf_counter() - start
        assert report["scan"]["files_checked"] == args.files
        assert report["issues"][0]["impact"]["affected_count"] == args.files - 1
        assert not report["scan"]["partial"]
        print(json.dumps({"files": args.files, "seconds": round(elapsed, 3), "under_five_seconds": elapsed < 5}, indent=2))


if __name__ == "__main__":
    main()
