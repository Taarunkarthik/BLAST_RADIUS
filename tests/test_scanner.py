import json
from pathlib import Path

import pytest

from blastradius import scanner
from blastradius.scanner import exit_code, scan_repository


def test_end_to_end_all_checkers_and_exact_reverse_paths(repository):
    root = repository({
        "package.json": {},
        "src/Chart.tsx": "import helper from 'chart-helper'; export const Chart = 1;",
        "src/Dashboard.tsx": "export { Chart } from './Chart';",
        "src/App.tsx": "import { Chart } from './Dashboard';",
        "src/Grid.tsx": "import { Chart } from './Chart';",
        "styles.css": "a { color: red;",
        "config.json": '{"a":}',
        "workflow.yaml": "a:\n\tb: 1",
        "index.html": '<img src="absent.svg">',
        "README.md": "[docs](missing.md)",
        "image.png": b"not checked",
    })
    report = scan_repository(root, deterministic=True)
    types = {item["type"] for item in report["issues"]}
    assert {"undeclared_external_package", "invalid_css", "invalid_json", "tabs_in_yaml", "missing_asset", "broken_link"} <= types
    chart = next(item for item in report["issues"] if item["file"] == "src/Chart.tsx")
    assert chart["impact"]["affected_count"] == 3
    assert chart["impact"]["direct_dependents"] == ["src/Dashboard.tsx", "src/Grid.tsx"]
    assert ["src/Chart.tsx", "src/Dashboard.tsx", "src/App.tsx"] in chart["impact"]["paths"]
    assert all(not item["has_tree_impact"] for item in report["issues"] if not item["file"].endswith(".tsx"))
    assert report["scan"]["not_checked_types"] == [".png"]
    assert exit_code(report, "high") == 1


def test_structure_and_health_modes(repository):
    root = repository({"main.ts": "import './missing';", "bad.json": "{"})
    structure = scan_repository(root, mode="structure")
    assert structure["scan"]["files_checked"] == 1
    assert {item["type"] for item in structure["issues"]} == {"missing_local_module"}
    health = scan_repository(root, mode="health")
    assert health["graph"] is None
    assert len(health["issues"]) == 2
    assert all(not item["impact"]["has_tree_impact"] for item in health["issues"])


def test_typescript_paths_jsconfig_comments_and_commonjs(repository):
    root = repository({
        "tsconfig.json": '{// comment\n"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}},}',
        "src/main.ts": "import {x} from '@/lib'; export {x} from './lib.js'; const lib = require('./lib');",
        "src/lib.ts": "export const x = 1;",
    })
    report = scan_repository(root)
    assert report["issues"] == []
    assert {"source": "file:src/main.ts", "target": "file:src/lib.ts"} in report["graph"]["edges"]


def test_package_classifications_and_version_mismatch(repository):
    root = repository({
        "package.json": {"dependencies": {"absent": "^1.0.0", "present": "^2.0.0"}},
        "main.ts": "import 'undeclared'; import 'absent'; import 'present';",
        "node_modules/present/package.json": {"name": "present", "version": "1.0.0", "main": "index.js"},
        "node_modules/present/index.js": "module.exports = {};",
    })
    types = {item["type"] for item in scan_repository(root)["issues"]}
    assert types == {"undeclared_external_package", "declared_but_not_installed", "version_mismatch"}


def test_builtin_assets_and_declarations_do_not_pollute_graph(repository):
    root = repository({
        "main.ts": "import 'node:fs'; import 'fs/promises'; import './absent.css'; import './image.svg?url'; import type { A } from './types';",
        "types.d.ts": "export interface A {}",
    })
    report = scan_repository(root)
    assert report["issues"] == []
    assert report["graph"]["edges"] == []
    assert len(report["scan"]["ignored_imports"]) == 5


def test_parse_errors_and_root_critical_semantics(repository):
    root = repository({"main.ts": "const value = ;"})
    report = scan_repository(root)
    assert report["issues"][0]["type"] == "parse_error"
    assert report["issues"][0]["impact"]["is_root"]
    assert report["scan"]["graph_partial"]


def test_dynamic_imports_static_and_computed_are_distinguished(repository):
    root = repository({"main.ts": "import('./lib'); import(`./${name}`);", "lib.ts": "export {};"})
    report = scan_repository(root)
    assert report["issues"][0]["type"] == "unsupported_resolution"
    assert {"source": "file:main.ts", "target": "file:lib.ts"} in report["graph"]["edges"]
    assert report["scan"]["partial"]
    assert exit_code(report, "none") == 3


def test_scss_partial_imports_and_syntax(repository):
    root = repository({
        "main.scss": '@use "colors"; @import "missing"; .a { color: $primary; &:hover { color: red; }}',
        "_colors.scss": "$primary: blue;",
        "broken.scss": ".a { color: red;",
    })
    report = scan_repository(root)
    assert {(item["file"], item["type"]) for item in report["issues"]} == {("main.scss", "missing_css_import"), ("broken.scss", "invalid_css")}
    assert all(not item["impact"]["has_tree_impact"] for item in report["issues"])


def test_limits_invalid_encoding_and_imports_outside_coverage(repository):
    root = repository({"a.ts": "import './b';", "b.ts": "export {};", "c.json": b"\xff\xfe", "d.json": " " * 400})
    limited = scan_repository(root, max_files=1)
    assert limited["scan"]["partial"]
    assert limited["scan"]["files_checked"] == 1
    assert len(limited["scan"]["skipped_files"]) == 3
    assert exit_code(limited, "none") == 3
    full = scan_repository(root, max_bytes=100)
    assert len(full["scan"]["skipped_files"]) == 2


def test_determinism_and_scan_does_not_modify_files(repository):
    root = repository({"main.ts": "import './missing';", "data.json": "{}", "README.md": "# Hello"})
    before = {file.relative_to(root): (file.read_bytes(), file.stat().st_mtime_ns) for file in root.rglob("*") if file.is_file()}
    first = scan_repository(root, deterministic=True)
    second = scan_repository(root, deterministic=True)
    assert json.dumps(first, sort_keys=True) == json.dumps(second, sort_keys=True)
    after = {file.relative_to(root): (file.read_bytes(), file.stat().st_mtime_ns) for file in root.rglob("*") if file.is_file()}
    assert before == after
    (root / "data.json").write_text('{"changed": true}')
    assert scan_repository(root, deterministic=True)["scan"]["id"] != first["scan"]["id"]


def test_ignored_file_import_is_reported_as_incomplete_coverage(repository):
    root = repository({".gitignore": "hidden.ts\n", "main.ts": "import './hidden';", "hidden.ts": "export {};"})
    report = scan_repository(root)
    assert report["scan"]["partial"]
    assert report["scan"]["limitations"][0]["file"] == "hidden.ts"


def test_invalid_config_does_not_invent_missing_imports(repository):
    root = repository({"tsconfig.json": '{"compilerOptions": {"moduleResolution":"unknown"}}', "main.ts": "import './real';", "real.ts": ""})
    report = scan_repository(root)
    assert {item["type"] for item in report["issues"]} == {"unsupported_resolution"}
    assert report["scan"]["partial"]


def test_tsconfig_extends_and_nearest_nested_configuration(repository):
    root = repository({
        "base.json": {"compilerOptions": {"baseUrl": ".", "paths": {"@lib": ["lib.ts"]}}},
        "tsconfig.json": {"extends": "./base.json"},
        "lib.ts": "export const x = 1;",
        "main.ts": "import {x} from '@lib';",
        "nested/tsconfig.json": {"compilerOptions": {"paths": {"@lib": ["./local.ts"]}}},
        "nested/local.ts": "export const x = 2;",
        "nested/main.ts": "import {x} from '@lib';",
    })
    report = scan_repository(root)
    assert report["issues"] == []
    assert {"source": "file:nested/main.ts", "target": "file:nested/local.ts"} in report["graph"]["edges"]
    assert {"source": "file:main.ts", "target": "file:lib.ts"} in report["graph"]["edges"]


def test_package_exports_and_types_only_installation(repository):
    root = repository({
        "package.json": {"dependencies": {"pkg": "1.0.0", "runtime": "1.0.0"}, "devDependencies": {"@types/runtime": "1.0.0"}},
        "main.ts": "import 'pkg'; import 'pkg/private'; import 'runtime';",
        "node_modules/pkg/package.json": {"name": "pkg", "version": "1.0.0", "exports": {".": "./main.js"}},
        "node_modules/pkg/main.js": "throw new Error('must never execute');",
        "node_modules/pkg/private.js": "module.exports = {};",
        "node_modules/@types/runtime/package.json": {"name": "@types/runtime", "version": "1.0.0", "types": "index.d.ts"},
        "node_modules/@types/runtime/index.d.ts": "export const x: number;",
    })
    issues = scan_repository(root)["issues"]
    assert {(item["target"], item["type"]) for item in issues} == {("pkg/private", "unsupported_resolution"), ("runtime", "declared_but_not_installed")}


def test_static_parser_never_interprets_import_text_in_comments_or_strings(repository):
    root = repository({"main.ts": '''// import 'ghost';
const text = "require('phantom')";
/* export * from 'imaginary'; */
export {text};
'''})
    report = scan_repository(root)
    assert report["issues"] == []
    assert report["graph"]["edges"] == []


def test_coverage_partition_is_complete(repository):
    root = repository({"a.ts": "", "b.ts": "", "defs.d.ts": "", "icon.svg": "", "config.json": "{}"})
    scan = scan_repository(root, max_files=1)["scan"]
    assert scan["files_discovered"] == scan["files_checked"] + scan["not_checked_count"] + len(scan["excluded_files"]) + len(scan["skipped_files"])


def test_new_syntax_checkers_are_read_only_and_have_no_graph_impact(repository):
    root = repository({"bad.toml": "x = ?", "bad.ini": "[x]\nbad line", "bad.svg": "<svg>",
                       "bad.py": "def broken(:", ".env": "bad line", ".env.example": "bad line"})
    before = {file.name: (file.read_bytes(), file.stat().st_mtime_ns) for file in root.iterdir()}
    report = scan_repository(root, deterministic=True)
    assert {issue["type"] for issue in report["issues"]} == {
        "invalid_toml", "invalid_ini", "invalid_svg", "invalid_python", "invalid_dotenv"}
    assert report["scan"]["files_checked"] == 6
    assert report["scan"]["not_checked_types"] == []
    assert all(issue["severity"] == "medium" and not issue["has_tree_impact"] for issue in report["issues"])
    assert report["graph"] == {"nodes": [], "edges": []}
    assert before == {file.name: (file.read_bytes(), file.stat().st_mtime_ns) for file in root.iterdir()}
    structure = scan_repository(root, mode="structure")
    assert structure["scan"]["files_checked"] == 0
    assert len(structure["scan"]["excluded_files"]) == 6


@pytest.mark.parametrize("suffix", ["toml", "ini", "svg", "py", "env", "example", "sql", "mako", "sh"])
def test_new_checkers_respect_byte_bounds(repository, monkeypatch, suffix):
    from blastradius import scanner
    monkeypatch.setattr("blastradius.discovery.optional_parser", lambda _: object())
    monkeypatch.setattr("blastradius.discovery.available_bash", lambda: "bash")
    root = repository({f"too-large.{suffix}": "x" * 100})
    def never_check(*args):
        pytest.fail("Oversized input reached a checker")
    for name in scanner.TEXT_CHECKERS:
        monkeypatch.setitem(scanner.TEXT_CHECKERS, name, never_check)
    report = scan_repository(root, max_bytes=10)
    assert report["scan"]["files_checked"] == 0
    assert report["scan"]["skipped_files"] == [{"file": f"too-large.{suffix}", "reason": "file size limit"}]
    assert report["issues"] == []


def test_optional_checkers_absent_stay_unsupported(repository, monkeypatch):
    monkeypatch.setattr("blastradius.discovery.optional_parser", lambda _: None)
    monkeypatch.setattr("blastradius.discovery.available_bash", lambda: None)
    report = scan_repository(repository({"a.sql": "broken", "b.mako": "broken", "c.sh": "broken"}))
    assert report["scan"]["not_checked_types"] == [".mako", ".sh", ".sql"]
    assert report["scan"]["files_checked"] == 0
    assert report["issues"] == [] and not report["scan"]["partial"]


def test_demo_coverage_includes_valid_svg_without_new_findings():
    report = scan_repository(Path(__file__).resolve().parents[1] / "examples/demo", deterministic=True)
    assert report["scan"]["files_discovered"] == report["scan"]["files_checked"] == 10
    assert report["scan"]["not_checked_count"] == 0
    assert report["scan"]["not_checked_types"] == []
    assert report["summary"] == {"issues": 5, "high": 1, "medium": 3, "low": 1}


class _RecordingWorker:
    """Stand-in for NodeWorker that records request batches and echoes empty results."""

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.batches = []

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def request(self, method, **params):
        self.batches.append(params["files"])
        return {"files": [
            {"file": entry["file"], "issues": [], "imports": [], "ignored_imports": [], "limitations": []}
            for entry in params["files"]
        ]}


def test_node_requests_are_batched_with_bounded_payloads(repository, monkeypatch):
    root = repository({f"src/mod{i}.ts": "export const x = 1;" for i in range(20)})
    worker = _RecordingWorker()
    monkeypatch.setattr(scanner, "NodeWorker", lambda **kwargs: worker)
    monkeypatch.setattr(scanner, "NODE_BATCH_MAX_BYTES", 64)
    scan_repository(root)
    assert len(worker.batches) > 1
    assert all(sum(len(entry["content"]) for entry in batch) <= 64 for batch in worker.batches)
    assert sorted(entry["file"] for batch in worker.batches for entry in batch) == sorted(f"src/mod{i}.ts" for i in range(20))


def test_node_batching_matches_single_request(repository, monkeypatch):
    files = {f"src/mod{i}.ts": f"import {{x}} from './mod{(i + 1) % 20}'; export const x = {i};" for i in range(20)}
    root = repository(files)
    single = scan_repository(root, deterministic=True)
    monkeypatch.setattr(scanner, "NODE_BATCH_MAX_BYTES", 64)
    batched = scan_repository(root, deterministic=True)
    assert single == batched


def test_worker_timeout_is_plumbed_to_node_worker(repository, monkeypatch):
    captured = {}

    def factory(**kwargs):
        captured.update(kwargs)
        return _RecordingWorker(**kwargs)

    monkeypatch.setattr(scanner, "NodeWorker", factory)
    scan_repository(repository({"main.ts": "export {};"}), worker_timeout=12.5)
    assert captured["timeout"] == 12.5
    captured.clear()
    scan_repository(repository({"main.ts": "export {};"}))
    assert captured["timeout"] == 60.0

