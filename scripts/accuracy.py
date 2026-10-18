"""Measure exact diagnostic identities on reviewed layouts and pinned real package sources."""

import json
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

from blastradius.scanner import scan_repository
from blastradius.worker import RUNTIME

CASES = Path(__file__).resolve().parents[1] / "tests/fixtures/accuracy/cases.json"


def identity(issue):
    return (issue["file"], issue["type"], issue["target"])


def evaluate():
    results = []
    with TemporaryDirectory(prefix="blastradius-accuracy-") as directory:
        root = Path(directory)
        for case in json.loads(CASES.read_text(encoding="utf-8")):
            project = root / case["name"]
            for file, content in case["files"].items():
                target = project / file
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(content, encoding="utf-8")
            report = scan_repository(project, deterministic=True)
            actual = {identity(issue) for issue in report["issues"]}
            expected = {tuple(issue) for issue in case["expected"]}
            results.append({"name": case["name"], "checked": report["scan"]["files_checked"],
                            "true_positives": len(actual & expected), "false_positives": sorted(actual - expected),
                            "false_negatives": sorted(expected - actual)})
        # Semver is a real published repository snapshot pinned by our npm lockfile.
        # Copy it only into a temporary directory; no third-party sources are vendored.
        package = root / "semver"
        shutil.copytree(RUNTIME / "node_modules/semver", package)
        clean = scan_repository(package, mode="structure", deterministic=True)
        results.append({"name": "semver-7.8.5-clean", "checked": clean["scan"]["files_checked"],
                        "true_positives": 0, "false_positives": [identity(issue) for issue in clean["issues"]], "false_negatives": []})
        mutations = {"functions/valid.js": "\nrequire('./missing-diagnostic-fixture');\n",
                     "functions/clean.js": "\nconst invalidAnnotation: number = 1;\n"}
        expected = set()
        for file, content in mutations.items():
            with (package / file).open("a", encoding="utf-8") as stream:
                stream.write(content)
            expected.add((file, "parse_error", "") if "Annotation" in content else (file, "missing_local_module", "./missing-diagnostic-fixture"))
        mutated = scan_repository(package, mode="structure", deterministic=True)
        actual = {identity(issue) for issue in mutated["issues"]}
        results.append({"name": "semver-7.8.5-injected-failures", "checked": mutated["scan"]["files_checked"],
                        "true_positives": len(actual & expected), "false_positives": sorted(actual - expected), "false_negatives": sorted(expected - actual)})
    tp = sum(case["true_positives"] for case in results)
    fp = sum(len(case["false_positives"]) for case in results)
    fn = sum(len(case["false_negatives"]) for case in results)
    return {"cases": results, "true_positives": tp, "false_positives": fp, "false_negatives": fn,
            "precision": tp / (tp + fp) if tp + fp else 1, "recall": tp / (tp + fn) if tp + fn else 1,
            "target": "Zero unexpected or missed diagnostics in this finite reviewed corpus."}


if __name__ == "__main__":
    result = evaluate()
    print(json.dumps(result, indent=2))
    raise SystemExit(int(bool(result["false_positives"] or result["false_negatives"])))
