# BlastRadius

**What is broken in this repository, and what depends on it?**

BlastRadius is a local-first CLI that combines file health checks with JavaScript and TypeScript dependency impact. It reports diagnostics, affected files, and dependency paths. Scans are read-only and work offline after installation.

## Install

Requirements: Python 3.11+ and Node.js 20+ with npm.

```sh
git clone https://github.com/Taarunkarthik/BLAST_RADIUS.git
cd BLAST_RADIUS
python -m venv .venv
```

Activate the environment:

```powershell
# Windows PowerShell
.\.venv\Scripts\Activate.ps1
```

```sh
# macOS / Linux
source .venv/bin/activate
```

Install the CLI and the pinned parser dependencies:

```sh
python -m pip install -e ".[dev,harness,postgres]"
blastradius setup
```

`setup` is the explicit installation step that contacts npm. It uses the checked-in lockfile and disables install scripts. Ordinary scans never install packages, fetch URLs, run project code, or change target files. `scan --save` explicitly connects to the configured PostgreSQL store.

For a built wheel, install it with `pip install path/to/blastradius-0.1.0-py3-none-any.whl`, then run `blastradius setup` in that Python environment.

For a minimal CLI installation, use `pip install -e .`; the database and browser dependencies are optional.

## Open the local browser interface

```sh
blastradius harness --path examples/demo
```

Open the printed local address, normally [localhost:8765](http://127.0.0.1:8765), and choose **Run scan**. The interface includes searchable findings, severity filters, dependency paths, coverage details, and JSON export. Use `--path /path/to/repository` for your own project. Saved history and comparison use the optional PostgreSQL configuration.

See [the harness guide](docs/harness.md) and [saved scans and comparison](docs/persistence.md).

## Scan

```sh
blastradius scan --path /path/to/repository
blastradius scan --path /path/to/repository --format json --deterministic-id
blastradius scan --mode structure
blastradius scan --mode health
blastradius --format json --fail-on medium scan --path /path/to/repository
```

Global output flags also work after `scan`. `--logs` writes file coverage to stderr, keeping JSON stdout parseable.

| Mode | File checks | JS/TS dependency graph |
| --- | --- | --- |
| `all` (default) | All configured checkers | Yes |
| `structure` | JS/TS syntax and imports | Yes |
| `health` | All configured checkers | No |

### Try the broken demo

```sh
blastradius scan --path examples/demo --deterministic-id
```

The command intentionally exits with code 1. Its missing `chart-helper` package affects three dependent files:

```text
src/Chart.tsx
├── src/Dashboard.tsx (direct)
│   └── src/App.tsx (transitive, distance 2)
└── src/Grid.tsx (direct)
```

The same report includes a missing CSS import, JSON reference, HTML asset, Markdown link, and an unchecked SVG. The demo is excluded when scanning the project itself.

## Checks and coverage

| Files | Checks |
| --- | --- |
| JS/JSX/TS/TSX/MJS/CJS/MTS/CTS | Syntax, static imports/re-exports/require/dynamic string imports, missing modules, undeclared or uninstalled packages, installed version mismatches |
| CSS/SCSS | Parser syntax errors, local `@import`, Sass `@use`/`@forward`, partial and index resolution |
| JSON | Strict syntax and local `$ref` file/JSON Pointer/anchor targets |
| tsconfig/jsconfig and `.vscode` JSON | JSON-with-comments syntax |
| YAML/YML | Syntax, indentation tabs; multiple documents and custom tags supported |
| HTML | Local asset and page targets, `srcset`, `<base>` |
| Markdown | Local links, images, reference links, and embedded HTML; code examples are excluded |

Each issue has a file, line, closed-taxonomy type, severity, target, and impact record. High findings include broken JS/TS syntax/imports. Local configuration/assets are medium; Markdown links are low. An issue retains its severity when the separate graph status says `CRITICAL - root node`.

Non-JS files explicitly report **No Tree Impact**, because they are outside the JS/TS graph. That does not claim that a broken asset has no runtime consequences.

The walker applies built-in exclusions, nested `.gitignore`, and nested `.repohealthignore` patterns. Built-in ignored directories include `.git`, `node_modules`, virtual environments, build output, and caches. Declaration files and symbolic links/junctions are excluded explicitly. Unsupported extensions are counted and listed in every report.

By default a scan checks up to 5,000 eligible files, each up to 2 MB. Increase the bounds with `--max-files` and `--max-bytes`. Files beyond a limit or unreadable text produce a partial report. Missing graph coverage and unsupported resolution are also explicit. Ignored paths are outside coverage and are not counted as checked.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Complete scan with no findings at or above the threshold |
| `1` | Findings meet `--fail-on` (default: `high`) |
| `2` | Invalid invocation, unavailable parser, or scan failure |
| `3` | Incomplete scan; takes precedence over finding thresholds |

`--fail-on none` disables finding-based failure, but still reports incomplete scans as code 3. A parse error is a diagnostic and can also make the graph partial; its high severity determines finding-based failure. Unsupported file types alone do not make a configured scan incomplete.

## Determinism and graph semantics

`--deterministic-id` removes timestamps and the absolute scan root, sorts report records, fixes text width, and hashes the report plus checked file contents. Repeated scans of unchanged inputs and dependency state produce identical reports. Redirect report output outside the target directory to avoid including the previous report in the next scan.

Edges point from importer to dependency. A broken source file propagates through the reverse graph. Counts are unique, exclude the failing file, and use checked JS/TS source files as the eligible denominator. Each affected file has one deterministic shortest path; cycles cannot duplicate counts. A file with zero dependents is a graph root, not necessarily an application entry point.

## Architecture

```text
Python CLI -> deterministic walker -> file router
                                   |-- TypeScript / PostCSS worker (NDJSON v1)
                                   |-- Python JSON / YAML / HTML / Markdown checks
                                   |-- independent dependency graph
                                   `-- report merger -> Rich text / stable JSON
```

The Node subprocess stays alive for the scan and shares TypeScript resolution caches across files. TypeScript uses the nearest tsconfig/jsconfig, path mappings, package exports, and nearest package manifest. Bundler resolution is the default when a project has no compiler configuration. Built-ins, declaration-only targets, and non-source imports are excluded from graph propagation.

Read [the implementation phases and status](docs/PHASES.md), [the implementation decisions](docs/implementation-decisions.md), [the report contract](docs/report-contract.md), and [the supplied v3.0 PRD](docs/product-requirements-v3.txt).

## Limits of this release

This is a static diagnostic MVP. It does not run a type checker, compile Sass, validate CSS property values, execute bundler configuration, or prove runtime behavior. Computed JS imports and custom bundler resolvers may leave partial coverage. Sass package load paths and interpolation are not resolved. Remote links are not requested; HTML/Markdown anchor fragments are not validated. JSON references use filesystem-relative paths; nested JSON Schema `$id` rebasing is not implemented.

All seven implementation phases are delivered, including the optional PostgreSQL store and FastAPI browser harness. Python, Go, and Rust files appear as unsupported, as specified for the MVP. The remaining coverage extensions are listed explicitly in [the phases document](docs/PHASES.md).

## Development

```sh
ruff check src tests scripts
pytest -q
python -m build
python scripts/benchmark.py --files 1000
python scripts/accuracy.py
python scripts/scale_benchmark.py
```

CI runs on Linux, Windows, and macOS with Python 3.11, 3.12, and 3.13. A separate PostgreSQL 17 job verifies real database transactions and CLI/browser API workflows. CI checks lint, tests, accuracy fixtures, a scan of this repository, wheel contents, and a clean wheel installation. See [validation results and their limits](docs/validation.md). Benchmarks use temporary repositories; timings depend on the host and are not a CI timing gate.
