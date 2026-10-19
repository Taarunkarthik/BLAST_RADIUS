import os
import subprocess
import sys

import pytest

from blastradius.discovery import discover, route


def test_nested_gitignore_negation_and_repohealthignore(repository):
    root = repository({
        ".gitignore": "*.log\nignored/\n!keep.log\n",
        ".repohealthignore": "private.json\n",
        "keep.log": "keep", "debug.log": "skip", "private.json": "{}",
        "ignored/bad.ts": "broken", "node_modules/pkg/index.js": "broken",
        "src/.gitignore": "*.json\n!keep.json\n",
        "src/keep.json": "{}", "src/skip.json": "{}", "src/index.ts": "",
    })
    files = {file.path for file in discover(root)}
    assert {"keep.log", "src/keep.json", "src/index.ts"} <= files
    assert not files.intersection({"debug.log", "private.json", "ignored/bad.ts", "node_modules/pkg/index.js", "src/skip.json"})


def test_unsupported_and_declaration_coverage(repository):
    root = repository({"picture.svg": "<svg/>", "picture.png": b"png", "globals.d.ts": "declare const x: number;", "main.mts": ""})
    files = {item.path: item for item in discover(root)}
    assert files["picture.svg"].checker == "svg"
    assert files["picture.png"].checker is None
    assert files["globals.d.ts"].skip_reason == "type declaration"
    assert files["main.mts"].checker == "javascript"


@pytest.mark.parametrize("file,checker", [
    ("project.TOML", "toml"), ("settings.ini", "ini"), ("icon.svg", "svg"),
    ("script.py", "python"), (".env", "dotenv"), ("secrets.env", "dotenv"),
    (".env.example", "dotenv"), (".example", "dotenv"),
    ("yarn.lock", None), ("image.png", None), ("a.template", None),
    ("a.vercel", None), ("Dockerfile", None), ("LICENSE", None),
])
def test_new_routes_and_out_of_scope_files(file, checker):
    assert route(file) == checker


def test_optional_routes_are_unsupported_without_dependencies(monkeypatch):
    monkeypatch.setattr("blastradius.discovery.optional_parser", lambda _: None)
    monkeypatch.setattr("blastradius.discovery.available_bash", lambda: None)
    assert all(route(file) is None for file in ("query.sql", "view.mako", "script.sh"))


def test_symlinks_are_not_followed(repository, tmp_path):
    root = repository({"real/main.ts": ""})
    try:
        (root / "loop").symlink_to(root, target_is_directory=True)
    except OSError:
        pytest.skip("Host does not allow creating symlinks")
    files = discover(root)
    assert len(files) == 2
    assert next(item for item in files if item.path == "loop").skip_reason


def test_deep_tree_does_not_recursion_error(repository):
    # Short names keep the full path well under Windows MAX_PATH while the depth
    # still exceeds the deliberately lowered recursion limit.
    depth = 60
    chain = "/".join(["d"] * depth)
    root = repository({f"{chain}/leaf.ts": "export {};", "shallow.ts": ""})
    limit = sys.getrecursionlimit()
    sys.setrecursionlimit(50)
    try:
        files = {file.path: file for file in discover(root)}
    finally:
        sys.setrecursionlimit(limit)
    expected = f"{chain}/leaf.ts"
    assert expected in files
    assert files[expected].checker == "javascript"
    assert files["shallow.ts"].checker == "javascript"


@pytest.mark.skipif(os.name != "nt", reason="Windows junction behavior")
def test_directory_junctions_are_not_followed(repository):
    root = repository({"real/main.ts": ""})
    result = subprocess.run(["cmd", "/c", "mklink", "/J", str(root / "loop"), str(root)], capture_output=True, check=False)
    if result.returncode:
        pytest.skip("Host does not allow creating directory junctions")
    try:
        files = discover(root)
        assert len(files) == 2
        assert next(item for item in files if item.path == "loop").skip_reason
    finally:
        # rmdir removes only the junction itself, never the target directory.
        (root / "loop").rmdir()

