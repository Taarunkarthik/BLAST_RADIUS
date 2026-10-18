"""Stable text and JSON renderers. Report values are never interpreted as markup."""

import json

from rich.console import Console
from rich.text import Text
from rich.tree import Tree


def json_report(report: dict) -> str:
    return json.dumps(report, sort_keys=True, indent=2, ensure_ascii=True) + "\n"


def render_text(report: dict, console: Console) -> None:
    scan = report["scan"]
    console.print(Text(f"BlastRadius Scan - {scan['root']}", style="bold cyan"))
    console.print(f"Mode: {scan['mode']} | Scan: {scan['id']}", markup=False)
    types = ", ".join(scan["not_checked_types"]) or "none"
    console.print(f"Files checked: {scan['files_checked']} / {scan['files_discovered']} ({scan['not_checked_count']} not checked: {types})", markup=False)
    if scan["excluded_files"] or scan["skipped_files"]:
        console.print(f"Excluded: {len(scan['excluded_files'])} | Incomplete: {len(scan['skipped_files'])}")
    if scan["partial"]:
        console.print("PARTIAL SCAN - unresolved coverage remains.", style="bold yellow")
    console.print()
    console.print(f"BROKEN ({len(report['issues'])} issues)", style="bold")
    for severity in ("high", "medium", "low"):
        issues = [item for item in report["issues"] if item["severity"] == severity]
        if not issues:
            continue
        console.print(f"  {severity.upper()} ({len(issues)})", style={"high": "red", "medium": "yellow", "low": "blue"}[severity])
        for issue in issues:
            console.print(f"  {issue['file']}:{issue['line']}  {issue['type']}  {issue['target']}", markup=False)
            if issue["message"]:
                console.print(f"    {issue['message']}", markup=False)
    if not report["issues"]:
        console.print("  No issues detected by the configured checks.")
    console.print()
    console.print("TREE IMPACT (how each break propagates)", style="bold")
    for issue in report["issues"]:
        console.print(f"\n{issue['file']}:{issue['line']} ({issue['type']}: {issue['target']})", markup=False)
        impact = issue["impact"]
        if not impact["has_tree_impact"]:
            console.print("  No Tree Impact")
        else:
            if impact["is_root"]:
                console.print("  Impact: CRITICAL - root node (0 dependents)", style="bold red")
            else:
                console.print(f"  Impact: {issue['severity'].upper()} - {impact['affected_count']} affected / {impact['eligible_count']} eligible files ({impact['impact_percentage']}%)")
            if impact["partial"]:
                console.print("  Impact is partial; only the scanned graph is represented.", style="yellow")
            tree = Tree(Text(issue["file"]))
            branches = {(issue["file"],): tree}
            for path in sorted(impact["paths"]):
                for index in range(1, len(path)):
                    key = tuple(path[:index + 1])
                    if key not in branches:
                        label = "direct" if index == 1 else f"transitive, distance {index}"
                        branches[key] = branches[key[:-1]].add(Text(f"{path[index]} ({label})"))
            console.print(tree)
        console.print(f"  Note: {impact['note']}", markup=False)
    console.print("\nCOVERAGE", style="bold")
    for extension, count in scan["not_checked_by_type"].items():
        console.print(f"  Not checked: {extension} ({count})", markup=False)
    for item in scan["skipped_files"]:
        console.print(f"  Incomplete: {item['file']} - {item['reason']}", markup=False)
    for item in scan["limitations"]:
        console.print(f"  Limited: {item['file']} - {item['reason']}", markup=False)
    for note in scan["coverage_notes"]:
        console.print(f"  {note}", markup=False)
    console.print("\nNo fixes were applied.")

