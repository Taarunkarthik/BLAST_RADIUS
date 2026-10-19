# BlastRadius implementation phases

Status date: 18 October 2026  
Delivery branch: `codex/initial-mvp`

All seven implementation phases from section 15 of the [v3.0 PRD](product-requirements-v3.txt) are implemented, including the optional persistence and browser milestones. Week numbers below are the original planning sequence, not elapsed delivery time. Validation evidence and its boundaries are recorded in [validation.md](validation.md).

## At a glance

| Phase | Original slot | Deliverable | Status |
| --- | --- | --- | --- |
| 1 | Week 1 | CLI, discovery, routing, parser protocol | Complete |
| 2 | Week 2 | JS/TS resolver and dependency graph | Complete; accuracy regressions fixed |
| 3 | Week 3 | Tree impact and merged reports | Complete |
| 4 | Week 4 | CSS/SCSS, JSON, YAML, HTML, Markdown checkers | Complete within documented MVP coverage |
| 5 | Week 5 | PostgreSQL, saved comparison, JSON output | Complete; database remains optional |
| 6 | Week 6 | Tests, accuracy, scale validation, docs, demo | Complete within the measured validation scope |
| 7 | Week 7 | Optional local web harness | Complete |

## Phase 1 — CLI foundation

- [x] Typer/Rich CLI and deterministic discovery.
- [x] Built-in exclusions, nested `.gitignore` and `.repohealthignore` rules.
- [x] Explicit unsupported, excluded, skipped, and checked coverage.
- [x] Persistent Node parser subprocess with NDJSON protocol v1.
- [x] `all`, `structure`, and `health` modes.
- [x] Output flags, severity thresholds, logs, explicit exit codes, parser setup.

**Acceptance:** scans route eligible files to their checkers, disclose incomplete coverage and missing parser dependencies, and leave target files unchanged.

## Phase 2 — JS/TS resolution and graph construction

- [x] Static imports, re-exports, CommonJS imports, literal dynamic imports.
- [x] Local resolution, TypeScript path aliases, package exports/imports, nearest config and manifest.
- [x] File/package/unresolved graph nodes; missing, undeclared, uninstalled, and mismatched package diagnostics.
- [x] Built-in, non-source, and declaration-only imports excluded from propagation.
- [x] TypeScript-only syntax in JavaScript is rejected through syntactic diagnostics.
- [x] Locally shadowed `require` bindings are distinguished from global CommonJS imports.
- [x] Workspace, hoisted dependency, configuration, and nested-package regression fixtures.

**Acceptance:** invalid `const count: number = 1` in a `.js` file is diagnosed, while a function parameter named `require` does not create a false package finding. Resolver tests and the reviewed accuracy corpus pass.

## Phase 3 — Tree impact and reporting

- [x] Reverse traversal with cycle protection and unique affected counts.
- [x] Eligible-file percentages, direct/transitive dependents, deterministic shortest paths.
- [x] Root-node labels, severity-grouped text/JSON, No Tree Impact notes.
- [x] Partial-graph disclosure, stable IDs, deterministic output.

**Acceptance:** the demo's Chart module affects Dashboard, Grid, and App exactly once. The report preserves all graph edges and one shortest route per dependent; it does not enumerate every cyclic route. Root status describes the scanned graph, not proof of a runtime entry point.

## Phase 4 — Local file checkers

- [x] CSS/SCSS syntax and local stylesheet imports.
- [x] JSON syntax, local reference files, JSON Pointers, named anchors.
- [x] JSON-with-comments for recognized configuration files.
- [x] YAML syntax and indentation tabs.
- [x] HTML local assets/pages, base URLs, source sets.
- [x] Markdown links, images, reference links, embedded HTML.

**Acceptance:** tested local failures have the expected issue type, location, severity, and `has_tree_impact: false`. Remote references are not fetched.

## Phase 5 — Persistence and comparison

- [x] Stable machine-readable reports.
- [x] Versioned, transactional PostgreSQL migrations with checksum verification.
- [x] Explicit project registration and exact canonical-root matching.
- [x] `scan --save`, project listing, scan history, saved-ID comparison.
- [x] Immutable full reports, normalized components/dependencies/issues, top-20 impact rows.
- [x] `has_tree_impact` storage without remediation fields.
- [x] Deterministic added/resolved/changed/unchanged/unverified comparison semantics.
- [x] Real PostgreSQL integration tests for CLI and harness workflows and rollback.

**Acceptance:** registered projects can save and compare scans; incomplete head coverage does not falsely claim findings were resolved. Ordinary scans need no database. The missing v2.1 database appendix is replaced by the explicit [persistence design](persistence.md).

## Phase 6 — Accuracy, validation, and release readiness

- [x] Phase 2 regression fixes and tests.
- [x] Reviewed authored layouts plus pinned real semver package source, clean and mutated.
- [x] Measured finite-corpus precision/recall; zero unexpected or missed identities.
- [x] Read-only behavior, cycles, scan modes, bounds, deterministic output.
- [x] 5,002-file cap test and deeper/denser/wider graph checks.
- [x] Synthetic 1,000-file scan and graph timing/allocation benchmarks.
- [x] Windows, Linux, macOS CI across Python 3.11–3.14, plus PostgreSQL 17 integration.
- [x] Wheel/source builds, bundled SQL/static assets, clean wheel install checks.
- [x] mypy type checking and a 75% coverage floor enforced in CI.
- [x] Installation, persistence, harness, contract, validation docs and broken demo.

**Acceptance:** known regressions are closed, measurements are reproducible, and claims stay within the tested corpus and hosts. The current local suite has 92 passes and six database skips on hosts that permit symlink creation; where symlink creation is forbidden, the two symlink tests skip too, giving 90 passes and eight skips. Database tests execute in CI. Performance and accuracy figures are detailed in [validation.md](validation.md).

## Phase 7 — Local web harness

- [x] FastAPI service and packaged static browser interface.
- [x] `blastradius harness --path ... --port ...` command.
- [x] Full/structure/health scans using the existing scanner and report contract.
- [x] Search/severity filters, findings, direct/transitive paths, coverage, JSON download.
- [x] Optional PostgreSQL save/history/compare controls.
- [x] Loopback/session/origin guards, bounded paths/requests, single scan/save execution.
- [x] Automated API tests and manual browser verification of the demo workflow.

**Acceptance:** a user can run a scan and inspect its findings and coverage locally. The harness is a single-user development tool; a full React dashboard and multi-user hosting are outside this phase. See [harness.md](harness.md).

## Future scope, outside these phases

- CSS `url()` image/font target checks.
- HTML/Markdown fragment-anchor validation.
- Sass interpolation and custom package load paths.
- Nested JSON Schema `$id` rebasing.
- Broader real-repository accuracy sampling and performance profiling.
- Python, Go, and Rust checkers, described separately as later language expansion in the PRD.

Full type checking, CSS property/value semantics, runtime execution, automatic fixes, and fix suggestions remain excluded from this diagnostic MVP.

## References

- [Product requirements v3.0](product-requirements-v3.txt)
- [Implementation decisions](implementation-decisions.md)
- [Report and worker contracts](report-contract.md)
- [Installation and usage](../README.md)
- [Validation results](validation.md)
