# Report and worker contracts

## Report schema v1

The root object has `schema_version`, `tool_version`, `scan`, `summary`, `issues`, and `graph`.

`scan` records its ID, root, mode, checked files, unsupported file counts/extensions/paths, exclusions, skipped files, limits, and resolution limitations. `partial` means the configured checks could not cover all eligible input; `graph_partial` additionally covers parse errors that can hide import edges. A nondeterministic scan has a UTC `created_at`; deterministic scans omit it.

The coverage partition is:

```text
files_discovered = files_checked + not_checked_count
                 + len(excluded_files) + len(skipped_files)
```

Ignored files/directories are outside this partition. Symbolic directory links are represented as one excluded entry and are never walked.

Issue records contain:

```json
{
  "file": "src/Chart.tsx",
  "line": 1,
  "type": "undeclared_external_package",
  "severity": "high",
  "target": "chart-helper",
  "message": "Imported package is not declared in the nearest package.json.",
  "has_tree_impact": true,
  "impact": {
    "has_tree_impact": true,
    "affected_count": 1,
    "eligible_count": 2,
    "impact_percentage": 50.0,
    "direct_dependents": ["src/App.tsx"],
    "transitive_dependents": [],
    "paths": [["src/Chart.tsx", "src/App.tsx"]],
    "is_root": false,
    "partial": false,
    "note": "Paths show one shortest reverse-dependency route per affected file."
  }
}
```

Non-graph issues and health-mode issues use `{"has_tree_impact": false, "note": "..."}` for impact. There are no remediation fields. Results sort by severity, file, line, issue type, and target.

Graph nodes are normalized keys: `file:<relative POSIX path>`, `package:<name>`, or `unresolved:<source>:<specifier>`. Edges have `source` and `target`. The graph is `null` in health mode. Declaration-only and non-source imports are explained in `scan.ignored_imports`.

An operational error returns `{"schema_version":1,"error":{"type":"scan_error","message":"..."}}` with exit code 2 in JSON mode. Per-file logs use stderr.

## Saved reports and browser API

`scan --save` adds a `storage` object containing `id` and `project_id` after the original report is saved. Use `storage.id` for comparisons. The stored full report excludes this response metadata. History records additionally include `saved_at`. See [persistence](persistence.md) for identity and comparison semantics.

The local harness returns this same scan contract from `POST /api/scan` and `GET /api/report`. `POST /api/save` returns the storage metadata separately. Comparison responses contain `schema_version`, `base_id`, `head_id`, `summary`, `added`, `resolved`, `changed`, `unverified`, `warnings`, `partial`, and `coverage`. `summary.unchanged` is a count; changed records contain `base`, `head`, and changed field names. Saved comparisons also include `project_id`, `base_saved_id`, and `head_saved_id`. Browser errors use an HTTP status and `detail`; there is no browser-specific alternative diagnostic schema.

## Parser worker protocol v1

The Python client launches the bundled `node/worker.mjs` once per scan, then exchanges one JSON object per line over stdin/stdout. It removes `NODE_OPTIONS` and `NODE_PATH` from the child environment. No target repository modules or scripts are loaded into the worker. The client sends `analyze` requests in bounded batches (about 8 MB or 250 files each) so peak memory tracks one batch rather than the total source size; the protocol version and method names are unchanged.

Requests:

```json
{"version":1,"id":1,"method":"ping","params":{}}
```

```json
{"version":1,"id":2,"method":"analyze","params":{"root":"/repo","files":[{"file":"src/main.ts","checker":"javascript","content":"export const x = 1;"}]}}
```

Supported checker values are `javascript`, `css`, and `jsonc`. Responses echo `version` and `id`, with either `result` or `error`. The `analyze` result has per-file diagnostics, import edges, ignored imports, and stylesheet references. Python owns coverage accounting and report merging. Syntax findings are data; protocol errors are operational failures.

The client enforces a response deadline per request (60 seconds by default, configurable with `--timeout`), closes the worker on completion, and fails explicitly if the worker exits, stalls, or returns an invalid response.
