from blastradius.graph import DependencyGraph


def graph(files, edges):
    return DependencyGraph(files, [{"source": a, "target": f"file:{b}"} for a, b in edges])


def test_reverse_diamond_and_shortest_paths():
    subject = graph(["chart.ts", "dashboard.ts", "grid.ts", "app.ts"], [
        ("dashboard.ts", "chart.ts"), ("grid.ts", "chart.ts"),
        ("app.ts", "dashboard.ts"), ("app.ts", "grid.ts"),
    ])
    before = subject.to_dict()
    impact = subject.impact("chart.ts")
    assert impact["affected_count"] == 3
    assert impact["eligible_count"] == 4
    assert impact["impact_percentage"] == 75.0
    assert impact["direct_dependents"] == ["dashboard.ts", "grid.ts"]
    assert impact["transitive_dependents"] == ["app.ts"]
    assert ["chart.ts", "dashboard.ts", "app.ts"] in impact["paths"]
    assert subject.to_dict() == before


def test_cycles_and_self_imports_do_not_inflate_counts():
    subject = graph(["a.ts", "b.ts", "c.ts"], [("a.ts", "a.ts"), ("a.ts", "b.ts"), ("b.ts", "c.ts"), ("c.ts", "a.ts")])
    result = subject.impact("a.ts")
    assert result["affected_count"] == 2
    assert result["direct_dependents"] == ["c.ts"]
    assert result["transitive_dependents"] == ["b.ts"]
    assert all(len(path) == len(set(path)) for path in result["paths"])


def test_isolated_file_is_root_and_traversal_does_not_mutate_graph():
    subject = graph(["a.ts"], [])
    assert subject.impact("a.ts")["is_root"]
    assert dict(subject.reverse) == {}

