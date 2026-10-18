from blastradius.graph import DependencyGraph
from blastradius.scanner import exit_code, scan_repository


def test_more_than_five_thousand_files_has_exact_partial_coverage(tmp_path):
    for index in range(5002):
        (tmp_path / f"config-{index:04}.json").write_text("{}", encoding="utf-8")
    report = scan_repository(tmp_path, deterministic=True)
    assert report["scan"]["files_checked"] == 5000
    assert len(report["scan"]["skipped_files"]) == 2
    assert exit_code(report, "none") == 3
    full = scan_repository(tmp_path, max_files=5002)
    assert full["scan"]["files_checked"] == 5002
    assert not full["scan"]["partial"]


def test_deep_graph_avoids_recursion_and_preserves_full_path():
    files = [f"{index:04}.ts" for index in range(2000)]
    graph = DependencyGraph(files, [{"source": files[index], "target": f"file:{files[index-1]}"} for index in range(1, len(files))])
    result = graph.impact(files[0])
    assert result["affected_count"] == 1999
    assert result["paths"][-1] == files


def test_dense_cyclic_graph_counts_each_dependent_once():
    files = [f"{index:03}.ts" for index in range(150)]
    graph = DependencyGraph(files, [{"source": a, "target": f"file:{b}"} for a in files for b in files if a != b])
    result = graph.impact(files[0])
    assert result["affected_count"] == 149
    assert result["transitive_dependents"] == []
    assert all(len(path) == 2 for path in result["paths"])
