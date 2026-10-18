from copy import deepcopy

import pytest

from blastradius.comparison import compare_reports, compare_saved, comparison_exit_code
from blastradius.scanner import scan_repository


def test_added_resolved_changed_and_unchanged(repository):
    root = repository({"a.json": "{", "b.json": "{", "c.json": "{", "d.json": "{}"})
    base = scan_repository(root, deterministic=True)
    (root / "a.json").write_text("{}")
    (root / "b.json").write_text("\n{")
    (root / "d.json").write_text("{")
    result = compare_reports(base, scan_repository(root, deterministic=True))
    assert result["summary"] == {"added": 1, "resolved": 1, "changed": 1, "unchanged": 1, "unverified": 0}
    assert result["changed"][0]["base"]["file"] == "b.json"
    assert "line" in result["changed"][0]["fields"]
    assert comparison_exit_code(result, "medium") == 1
    assert comparison_exit_code(result, "high") == 0


def test_coverage_loss_is_never_presented_as_resolution(repository):
    root = repository({"a.json": "{", "b.json": "{"})
    base = scan_repository(root)
    result = compare_reports(base, scan_repository(root, max_files=1))
    assert result["summary"]["resolved"] == 0
    assert result["summary"]["unverified"] == 1
    assert comparison_exit_code(result, "none") == 3


def test_removed_or_ignored_files_are_unverified(repository):
    root = repository({"bad.json": "{"})
    base = scan_repository(root)
    (root / "bad.json").unlink()
    result = compare_reports(base, scan_repository(root))
    assert result["summary"]["unverified"] == 1


def test_duplicate_findings_are_not_collapsed(repository):
    root = repository({"bad.json": "{"})
    base = scan_repository(root)
    base["issues"].append(deepcopy(base["issues"][0]))
    base["issues"][1]["line"] = 5
    head = deepcopy(base)
    head["issues"].pop(0)
    result = compare_reports(base, head)
    assert result["summary"]["unchanged"] == 1
    assert result["summary"]["resolved"] == 1


def test_modes_and_projects_must_match(repository):
    root = repository({"good.json": "{}"})
    with pytest.raises(ValueError, match="modes"):
        compare_reports(scan_repository(root), scan_repository(root, mode="health"))
    class Store:
        def load(self, scan_id):
            return {"project_id": scan_id, "report": {}}
    with pytest.raises(ValueError, match="different projects"):
        compare_saved(Store(), "one", "two")
