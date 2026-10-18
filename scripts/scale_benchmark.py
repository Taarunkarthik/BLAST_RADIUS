"""Measure traversal time and Python allocation peaks for deeper/dense graphs."""

import json
import tracemalloc
from time import perf_counter

from blastradius.graph import DependencyGraph


def measure(name, count, edges):
    files = [f"{index:05}.ts" for index in range(count)]
    tracemalloc.start()
    started = perf_counter()
    graph = DependencyGraph(files, [{"source": files[a], "target": f"file:{files[b]}"} for a, b in edges])
    impact = graph.impact(files[0])
    elapsed = perf_counter() - started
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    assert impact["affected_count"] == count - 1
    return {"shape": name, "nodes": count, "edges": len(graph.edges), "affected": impact["affected_count"],
            "seconds": round(elapsed, 3), "python_peak_mb": round(peak / 1024 / 1024, 2)}


if __name__ == "__main__":
    print(json.dumps([
        measure("deep-chain", 2000, ((index, index - 1) for index in range(1, 2000))),
        measure("dense-cycle", 300, ((a, b) for a in range(300) for b in range(300) if a != b)),
        measure("wide-star", 10000, ((index, 0) for index in range(1, 10000))),
    ], indent=2))
