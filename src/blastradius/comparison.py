"""Pure, deterministic saved-report comparison with conservative coverage handling."""

import json
from collections import defaultdict


def compare_reports(base: dict, head: dict) -> dict:
    if base["schema_version"] != head["schema_version"]:
        raise ValueError("Cannot compare different report schema versions.")
    if base["scan"]["mode"] != head["scan"]["mode"]:
        raise ValueError("Cannot compare different scan modes.")

    def grouped(report):
        groups = defaultdict(list)
        for issue in report["issues"]:
            groups[(issue["file"], issue["type"], issue["target"])].append(issue)
        return groups

    old, new = grouped(base), grouped(head)
    added, resolved, changed, unverified = [], [], [], []
    unchanged = 0
    head_checked = set(head["scan"]["checked_files"])
    for key in sorted(set(old) | set(new)):
        left, right = list(old[key]), list(new[key])
        # Preserve repeated findings: exact pairs are removed before matching moved lines.
        for issue in list(left):
            if issue in right:
                unchanged += 1
                left.remove(issue)
                right.remove(issue)
        def order(item):
            return (item["line"], json.dumps(item, sort_keys=True))
        left.sort(key=order)
        right.sort(key=order)
        count = min(len(left), len(right))
        for before, after in zip(left[:count], right[:count], strict=True):
            changed.append({"base": before, "head": after, "fields": sorted(field for field in set(before) | set(after) if before.get(field) != after.get(field))})
        added.extend(right[count:])
        for issue in left[count:]:
            if head["scan"]["partial"] or issue["file"] not in head_checked:
                unverified.append(issue)
            else:
                resolved.append(issue)
    warnings = []
    for label, report in (("Base", base), ("Head", head)):
        if report["scan"]["partial"] or report["scan"]["graph_partial"]:
            warnings.append(f"{label} scan has incomplete coverage or graph information.")
    if base["tool_version"] != head["tool_version"]:
        warnings.append("Scanner versions differ; changes may reflect checker behavior.")
    if base["scan"]["limits"] != head["scan"]["limits"]:
        warnings.append("Scan limits differ.")
    if unverified:
        warnings.append("Some baseline findings are absent from the head's verified coverage; they are not marked resolved.")
    return {
        "schema_version": 1, "base_id": base["scan"]["id"], "head_id": head["scan"]["id"],
        "summary": {"added": len(added), "resolved": len(resolved), "changed": len(changed), "unchanged": unchanged, "unverified": len(unverified)},
        "added": added, "resolved": resolved, "changed": changed, "unverified": unverified,
        "warnings": warnings, "partial": bool(warnings),
        "coverage": {"no_longer_checked": sorted(set(base["scan"]["checked_files"]) - head_checked),
                     "newly_checked": sorted(head_checked - set(base["scan"]["checked_files"]))},
    }


def compare_saved(store, base_id: str, head_id: str) -> dict:
    base, head = store.load(base_id), store.load(head_id)
    if base["project_id"] != head["project_id"]:
        raise ValueError("Saved scans belong to different projects.")
    result = compare_reports(base["report"], head["report"])
    return {**result, "project_id": base["project_id"], "base_saved_id": base_id, "head_saved_id": head_id}


def comparison_exit_code(result: dict, fail_on: str) -> int:
    if result["partial"]:
        return 3
    levels = {"none": 4, "low": 1, "medium": 2, "high": 3}
    findings = result["added"] + [item["head"] for item in result["changed"]]
    return int(any(levels[issue["severity"]] >= levels[fail_on] for issue in findings))
