"""Dependency graphs are independent of diagnostics and never mutated by reporting."""

from collections import defaultdict, deque


class DependencyGraph:
    def __init__(self, files: list[str], imports: list[dict]):
        self.files = frozenset(files)
        self.nodes = {f"file:{file}" for file in files}
        self.edges = set()
        self.reverse = defaultdict(set)
        for item in imports:
            source = item["source"]
            if source not in self.files:
                continue
            target = item["target"]
            source_key = f"file:{source}"
            self.nodes.add(target)
            self.edges.add((source_key, target))
            if target.startswith("file:") and target[5:] in self.files:
                self.reverse[target[5:]].add(source)

    def impact(self, file: str, *, partial: bool = False) -> dict:
        parents: dict[str, str | None] = {file: None}
        queue = deque([file])
        while queue:
            current = queue.popleft()
            for dependent in sorted(self.reverse.get(current, set())):
                if dependent not in parents:
                    parents[dependent] = current
                    queue.append(dependent)
        affected = sorted(set(parents) - {file})
        direct = sorted(self.reverse.get(file, set()) - {file})
        paths = []
        for dependent in affected:
            path = [dependent]
            while (parent := parents[path[-1]]) is not None:
                path.append(parent)
            paths.append(list(reversed(path)))
        count = len(affected)
        eligible = len(self.files)
        return {
            "has_tree_impact": True,
            "affected_count": count,
            "eligible_count": eligible,
            "impact_percentage": round(count * 100 / eligible, 2) if eligible else 0.0,
            "direct_dependents": direct,
            "transitive_dependents": sorted(set(affected) - set(direct)),
            "paths": paths,
            "is_root": not affected,
            "partial": partial,
            "note": ("No dependents in the scanned graph; this does not establish a runtime entry point."
                     if not affected else "Paths show one shortest reverse-dependency route per affected file."),
        }

    def to_dict(self) -> dict:
        return {
            "nodes": sorted(self.nodes),
            "edges": [{"source": source, "target": target} for source, target in sorted(self.edges)],
        }

