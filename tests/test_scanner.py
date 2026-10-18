import json

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

