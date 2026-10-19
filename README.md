# BlastRadius

[![CI](https://github.com/Taarunkarthik/BLAST_RADIUS/actions/workflows/ci.yml/badge.svg)](https://github.com/Taarunkarthik/BLAST_RADIUS/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Python](https://img.shields.io/badge/python-3.11%20%7C%203.12%20%7C%203.13%20%7C%203.14-blue)

> **What's broken in this repository — and how far does the damage spread?**

BlastRadius is a local-first CLI that checks every file it can read and traces how a broken
JavaScript/TypeScript file ripples through the dependency graph. It answers both questions in one
pass, honestly reports what it did *not* check, and never suggests or applies a fix.

Read-only. Offline after setup. Deterministic. No code execution, no network calls during a scan.

![BlastRadius harness Overview dashboard after a full scan of the demo project](docs/assets/harness.png)

## The problem

Today you reach for ESLint, Stylelint, a JSON linter, and a separate graph tool — and none of them
tell you *what depends on the thing that just broke*. BlastRadius does both in a single scan: it
flags the broken file and shows exactly which files it takes down.

## See it work

One undeclared import in `examples/demo` takes down three files:

```text
$ blastradius scan --path examples/demo

BlastRadius Scan - .
Files checked: 9 / 10 (1 not checked: .svg)

BROKEN (5 issues)
  HIGH (1)
  src/Chart.tsx:1  undeclared_external_package  chart-helper

TREE IMPACT (how each break propagates)
src/Chart.tsx:1 (undeclared_external_package: chart-helper)
  Impact: HIGH - 3 affected / 4 eligible files (75.0%)
src/Chart.tsx
+-- src/Dashboard.tsx (direct)
|   `-- src/App.tsx (transitive, distance 2)
`-- src/Grid.tsx (direct)
```

The same report also catches a missing CSS import, a broken JSON reference, a missing HTML asset,
and a dead Markdown link — each explicitly tagged **No Tree Impact**, because it is outside the
JS/TS graph.

## What it does

- **Checks every file type it knows:** JS/TS, CSS/SCSS, JSON, YAML, HTML, and Markdown.
- **Builds a real dependency graph** for JS/TS and computes the reverse-dependency *blast radius* —
  affected files, direct vs. transitive, and one shortest path each.
- **Shows it all in a browser:** the optional local harness renders an Overview dashboard with a
  severity donut and top-blast-radius ranking, a searchable findings list with collapsible
  tree-impact detail, a filesystem **Map** of the component tree, and an interactive SVG
  dependency graph — still local and read-only.
- **Uses the real resolver:** nearest `tsconfig`/`jsconfig`, path mappings, package exports, and the
  nearest `package.json` — so aliases and workspaces resolve like your bundler does.
- **Tells the truth about coverage:** unsupported files, size/limit skips, unresolved imports, and
  partial scans are all listed, never hidden.
- **Is deterministic:** `--deterministic-id` produces byte-identical reports, so CI can diff them.
- **Never fixes anything:** it is a diagnostic scanner. No suggestions, no patches, no surprises.

## Try it in 60 seconds

Requirements: Python 3.11+ and Node.js 20+ with npm.

```sh
git clone https://github.com/Taarunkarthik/BLAST_RADIUS.git
cd BLAST_RADIUS
python -m venv .venv
source .venv/bin/activate        # Windows PowerShell: .\.venv\Scripts\Activate.ps1
python -m pip install -e ".[harness]"
blastradius setup                # one-time; after this, scans work offline
blastradius scan --path examples/demo --deterministic-id
```

Prefer a UI? Open the local browser harness:

```sh
blastradius harness --path examples/demo   # then open http://127.0.0.1:8765
```

## Scan your own project

```sh
blastradius scan --path /path/to/repo                       # text report
blastradius scan --path /path/to/repo --mode structure      # graph/impact only
blastradius scan --path /path/to/repo --mode health         # file checks only
blastradius scan --path /path/to/repo --format json --deterministic-id
blastradius --format json --fail-on medium scan --path .    # CI gate
```

Exit codes make it a drop-in CI check: `0` clean · `1` findings at/above the threshold (`high` by
default) · `2` bad invocation or parser failure · `3` incomplete scan (takes precedence).

## Why the output is trustworthy

- **Read-only and local.** Scans never install packages, fetch URLs, run your code, or modify files.
  The only networked step is the explicit one-time `blastradius setup`.
- **Deterministic.** No timestamps or absolute paths in deterministic mode; identical inputs produce
  identical reports, down to the scan ID.
- **Honest.** Coverage is partitioned and disclosed, root-node failures are labelled as graph
  properties (not proof of a runtime entry point), and partial scans never claim a finding was
  resolved.
- **Measured.** CI runs a pinned real-package accuracy corpus (zero unexpected or missed diagnostics
  in the reviewed corpus) alongside unit, integration, and scale tests.

## How it works

```text
Python CLI -> deterministic walker -> file router
                                   |-- TypeScript / PostCSS worker (NDJSON v1, persistent)
                                   |-- Python JSON / YAML / HTML / Markdown checks
                                   |-- independent dependency graph
                                   `-- report merger -> Rich text / stable JSON
```

The file checkers and the dependency graph run independently; the report merges them without
mutating either. TypeScript resolution happens in a long-lived Node subprocess that shares caches
across the scan.

## Full reference

- [Implementation phases and status](docs/PHASES.md)
- [Implementation decisions](docs/implementation-decisions.md)
- [Report and worker contract](docs/report-contract.md)
- [Saved scans and comparison (optional PostgreSQL)](docs/persistence.md)
- [Local browser harness](docs/harness.md)
- [Validation results and their limits](docs/validation.md)
- [Product requirements (v3.0)](docs/product-requirements-v3.txt)

**Limits:** this is a static diagnostic MVP — it does not type-check, compile Sass, validate CSS
property values, or prove runtime behavior. Full scope boundaries are in
[the phases document](docs/PHASES.md).

## Development

```sh
pip install -e ".[dev,harness]"
ruff check src tests scripts
mypy src
pytest -q
python scripts/accuracy.py
```

CI runs Linux, Windows, and macOS across Python 3.11–3.14, plus a PostgreSQL 17 job that exercises
real save/compare workflows and the harness API.

## License

MIT — see [LICENSE](LICENSE). Release history is in [CHANGELOG.md](CHANGELOG.md).
