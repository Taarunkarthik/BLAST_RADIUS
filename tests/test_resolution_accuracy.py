import pytest

from blastradius.scanner import scan_repository


@pytest.mark.parametrize("content", [
    "const count: number = 1;", "interface Shape { x: number }",
    "const x = value as string;", "enum Color { Red }", "type Value = string;",
])
def test_typescript_grammar_in_javascript_is_rejected(repository, content):
    report = scan_repository(repository({"main.js": content}))
    assert any(issue["type"] == "parse_error" for issue in report["issues"])


@pytest.mark.parametrize("content", [
    "function demo(require) { return require('not-a-package'); }",
    "const require = x => x; require('local-function');",
    "{ require('local'); const require = x => x; }",
    "function demo() { require('local'); var require = x => x; }",
    "try {} catch (require) { require('local'); }",
    "const f = ({require}) => require('local');",
    "function require(x) { return x; } require('local');",
    "for (const require of []) { require('local'); }",
])
def test_shadowed_require_is_not_an_import(repository, content):
    report = scan_repository(repository({"main.js": content}))
    assert report["issues"] == []
    assert report["graph"]["edges"] == []


def test_require_shadowing_does_not_escape_its_scope(repository):
    report = scan_repository(repository({"main.js": "function f(require) { require('local'); } require('real-missing');"}))
    assert [(issue["type"], issue["target"]) for issue in report["issues"]] == [("undeclared_external_package", "real-missing")]


def test_javascript_jsdoc_and_jsx_remain_valid(repository):
    report = scan_repository(repository({"main.jsx": '/** @type {number} */ const x = 1; export const element = <div>{x}</div>;'}))
    assert report["issues"] == []


def test_nearest_workspace_manifest_owns_dependencies(repository):
    root = repository({
        "package.json": {"private": True, "workspaces": ["packages/*"], "dependencies": {"root-only": "1.0.0"}},
        "packages/widget/package.json": {"name": "widget", "dependencies": {"hoisted": "1.0.0"}},
        "packages/widget/src/index.ts": "import 'hoisted'; import 'root-only';",
        "node_modules/hoisted/package.json": {"name": "hoisted", "version": "1.0.0", "main": "index.js"},
        "node_modules/hoisted/index.js": "module.exports = {};",
        "node_modules/root-only/package.json": {"name": "root-only", "version": "1.0.0", "main": "index.js"},
        "node_modules/root-only/index.js": "module.exports = {};",
    })
    report = scan_repository(root)
    assert [(issue["type"], issue["target"]) for issue in report["issues"]] == [("undeclared_external_package", "root-only")]


def test_package_import_map_and_nodenext_resolution(repository):
    root = repository({
        "package.json": {"type": "module", "imports": {"#utils": "./utils.js"}},
        "tsconfig.json": {"compilerOptions": {"module": "NodeNext", "moduleResolution": "NodeNext"}},
        "main.ts": "import {x} from '#utils';", "utils.ts": "export const x = 1;",
    })
    report = scan_repository(root)
    assert report["issues"] == []
    assert {"source": "file:main.ts", "target": "file:utils.ts"} in report["graph"]["edges"]


def test_scanning_a_package_inside_node_modules_keeps_local_edges(repository):
    root = repository({"node_modules/example/index.js": "module.exports = require('./lib');", "node_modules/example/lib.js": "exports.x = 1;"})
    report = scan_repository(root / "node_modules/example")
    assert report["issues"] == []
    assert {"source": "file:index.js", "target": "file:lib.js"} in report["graph"]["edges"]
