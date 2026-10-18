"""Deterministic discovery with nested Git-style ignores and no symlink traversal."""

import os
from dataclasses import dataclass
from pathlib import Path

from pathspec import GitIgnoreSpec

from blastradius.models import JS_EXTENSIONS, is_declaration

BUILTIN_DIRS = frozenset({
    ".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__",
    ".pytest_cache", ".ruff_cache", ".mypy_cache", ".next", ".nuxt", ".turbo",
    "dist", "build", "coverage", "htmlcov",
})


@dataclass(frozen=True)
class DiscoveredFile:
    path: str
    checker: str | None
    skip_reason: str | None = None


def route(path: str) -> str | None:
    suffix = Path(path).suffix.lower()
    if suffix in JS_EXTENSIONS:
        return "javascript"
    if suffix in {".css", ".scss"}:
        return "css"
    if suffix == ".json":
        name = Path(path).name.lower()
        if name.startswith(("tsconfig", "jsconfig")) or ".vscode" in Path(path).parts:
            return "jsonc"
        return "json"
    return {".yaml": "yaml", ".yml": "yaml", ".html": "html", ".md": "markdown"}.get(suffix)


def discover(root: Path) -> list[DiscoveredFile]:
    files = []

    def walk(directory, inherited):
        rules = list(inherited)
        for name in (".gitignore", ".repohealthignore"):
            ignore = directory / name
            if ignore.is_file() and not ignore.is_symlink():
                rules.append((directory, GitIgnoreSpec.from_lines(ignore.read_text(encoding="utf-8-sig").splitlines())))
        with os.scandir(directory) as entries:
            ordered = sorted(entries, key=lambda entry: entry.name)
        for entry in ordered:
            path = Path(entry.path)
            rel = path.relative_to(root).as_posix()
            is_dir = entry.is_dir(follow_symlinks=False)
            if entry.name in BUILTIN_DIRS or entry.name.endswith(".egg-info"):
                if is_dir:
                    continue
            ignored = False
            for base, spec in rules:
                result = spec.check_file(path.relative_to(base).as_posix() + ("/" if is_dir else ""))
                if result.include is not None:
                    ignored = result.include
            if ignored:
                continue
            if entry.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
                files.append(DiscoveredFile(rel, route(rel), "symbolic link or junction"))
            elif is_dir:
                walk(path, rules)
            else:
                files.append(DiscoveredFile(rel, route(rel), "type declaration" if is_declaration(rel) else None))

    walk(root, [])
    return sorted(files, key=lambda file: file.path)

