"""Discovery -> independent checkers/graph -> immutable report merge."""

import hashlib
import json
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from blastradius import __version__
from blastradius.checkers import (
    CheckerUnavailable,
    check_css_references,
    check_dotenv,
    check_html,
    check_ini,
    check_json,
    check_mako,
    check_markdown,
    check_python,
    check_shell,
    check_sql,
    check_svg,
    check_toml,
    check_yaml,
)
from blastradius.discovery import discover, route
from blastradius.graph import DependencyGraph
from blastradius.models import Issue
from blastradius.worker import NodeWorker

TEXT_CHECKERS = {
    "toml": check_toml, "ini": check_ini, "svg": check_svg, "python": check_python,
    "dotenv": check_dotenv, "shell": check_shell, "sql": check_sql, "mako": check_mako,
}


def scan_repository(root: Path, *, mode="all", deterministic=False, max_files=5000, max_bytes=2_000_000) -> dict:
    root = root.resolve()
    if not root.is_dir():
        raise ValueError("Scan path must be an existing directory.")
    if mode not in {"all", "health", "structure"}:
        raise ValueError("Unknown scan mode.")
    discovered = discover(root)
    unsupported, excluded, skipped = [], [], []
    checked: list[str] = []
    sources, node_inputs, issues, imports = {}, [], [], []
    ignored_imports, limitations, file_hashes = [], [], {}
    for item in discovered:
        if item.skip_reason:
            excluded.append({"file": item.path, "reason": item.skip_reason})
            continue
        if item.checker is None:
            unsupported.append(item.path)
            continue
        if mode == "structure" and item.checker != "javascript":
            excluded.append({"file": item.path, "reason": "excluded by structure mode"})
            continue
        if len(checked) >= max_files:
            skipped.append({"file": item.path, "reason": "scan file limit"})
            continue
        try:
            path = root / item.path
            if path.stat().st_size > max_bytes:
                skipped.append({"file": item.path, "reason": "file size limit"})
                continue
            with path.open("rb") as stream:
                raw = stream.read(max_bytes + 1)
            if len(raw) > max_bytes:
                skipped.append({"file": item.path, "reason": "file size limit"})
                continue
            content = raw.decode("utf-8-sig")
            if "\0" in content:
                raise ValueError("binary content in a text file")
        except (OSError, ValueError) as error:
            reason = "file is not readable UTF-8 text" if isinstance(error, (UnicodeError, ValueError)) else "file could not be read"
            skipped.append({"file": item.path, "reason": reason})
            continue
        if item.checker in TEXT_CHECKERS:
            try:
                issues.extend(TEXT_CHECKERS[item.checker](item.path, content))
            except CheckerUnavailable:
                unsupported.append(item.path)
                continue
            except OSError:
                skipped.append({"file": item.path, "reason": "optional checker could not complete"})
                continue
        checked.append(item.path)
        sources[item.path] = item.checker
        file_hashes[item.path] = hashlib.sha256(raw).hexdigest()
        if item.checker in {"javascript", "css", "jsonc"}:
            node_inputs.append({"file": item.path, "checker": item.checker, "content": content})
        elif item.checker == "json":
            issues.extend(check_json(root, item.path, content))
        elif item.checker == "yaml":
            issues.extend(check_yaml(item.path, content))
        elif item.checker == "html":
            issues.extend(check_html(root, item.path, content))
        elif item.checker == "markdown":
            issues.extend(check_markdown(root, item.path, content))
    if node_inputs:
        with NodeWorker() as worker:
            # A single request allows TypeScript resolution caches to span the full scan.
            result = worker.request("analyze", root=str(root), files=node_inputs)
        for output in result["files"]:
            issues.extend(Issue(**issue) for issue in output["issues"])
            imports.extend(output["imports"])
            ignored_imports.extend(output["ignored_imports"])
            limitations.extend(output["limitations"])
            if "references" in output:
                css_issues, css_limits = check_css_references(root, output["file"], output["references"])
                issues.extend(css_issues)
                limitations.extend(css_limits)
    graph_files = [file for file in checked if sources[file] == "javascript"]
    graph_file_set = set(graph_files)
    # Imports to excluded source files are retained in the graph but coverage is explicit.
    outside = sorted({item["target"][5:] for item in imports if item["target"].startswith("file:") and item["target"][5:] not in graph_file_set})
    for file in outside:
        limitations.append({"file": file, "reason": "Imported source is outside the checked file set."})
    resolution_incomplete = any(issue.type == "unsupported_resolution" for issue in issues)
    parse_incomplete = any(issue.type == "parse_error" for issue in issues)
    partial = bool(skipped or limitations or resolution_incomplete)
    graph = DependencyGraph(graph_files, imports) if mode != "health" else None
    cache, merged = {}, []
    for issue in sorted(set(issues), key=Issue.sort_key):
        if graph is not None and issue.file in graph.files:
            if issue.file not in cache:
                cache[issue.file] = graph.impact(issue.file, partial=partial or parse_incomplete)
            impact = cache[issue.file]
        else:
            checker = sources.get(issue.file) or route(issue.file)
            note = ("Tree analysis is disabled in health mode." if checker == "javascript"
                    else f"{ {'jsonc': 'JSON configuration', 'css': 'CSS/SCSS'}.get(checker or '', str(checker).upper()) } files are outside the JS/TS dependency graph.")
            impact = {"has_tree_impact": False, "note": note}
        merged.append({**issue.to_dict(), "has_tree_impact": impact["has_tree_impact"], "impact": impact})
    counts = Counter(Path(file).suffix.lower() or "[no extension]" for file in unsupported)
    report: dict = {
        "schema_version": 1,
        "tool_version": __version__,
        "scan": {
            "root": "." if deterministic else root.as_posix(), "mode": mode,
            "files_discovered": len(discovered), "files_checked": len(checked),
            "checked_files": checked, "not_checked_count": len(unsupported),
            "not_checked_types": sorted(counts), "not_checked_by_type": dict(sorted(counts.items())),
            "not_checked_files": unsupported, "excluded_files": excluded, "skipped_files": skipped,
            "partial": partial, "graph_partial": bool(graph and (partial or parse_incomplete)),
            "limits": {"max_files": max_files, "max_bytes": max_bytes},
            "limitations": limitations,
            "ignored_imports": sorted(ignored_imports, key=lambda item: (item["file"], item["line"], item["target"])),
            "coverage_notes": [
                "Remote URLs are not fetched. HTML/Markdown fragments are not validated.",
                "Checks cover syntax and static references, not types, business logic, CSS property semantics, or runtime behavior.",
                "Only JS/TS source imports participate in tree impact. Project code and configuration scripts are never executed.",
            ],
        },
        "summary": {"issues": len(merged), **{severity: sum(issue["severity"] == severity for issue in merged) for severity in ("high", "medium", "low")}},
        "issues": merged,
        "graph": graph.to_dict() if graph else None,
    }
    if deterministic:
        identity = json.dumps({"report": report, "files": file_hashes}, sort_keys=True, ensure_ascii=True)
        report["scan"]["id"] = hashlib.sha256(identity.encode()).hexdigest()[:24]
    else:
        report["scan"]["id"] = str(uuid4())
        report["scan"]["created_at"] = datetime.now(UTC).isoformat()
    return report


def exit_code(report: dict, fail_on: str) -> int:
    if report["scan"]["partial"]:
        return 3
    if fail_on == "none":
        return 0
    severity = {"low": 1, "medium": 2, "high": 3}
    return int(any(severity[issue["severity"]] >= severity[fail_on] for issue in report["issues"]))
