# BlastRadius implementation phases

Status date: 18 October 2026  
Implementation baseline: `a8986a7` on `codex/initial-mvp`

This document turns section 15 of the [v3.0 PRD](product-requirements-v3.txt) into a tracked implementation roadmap. The original week numbers describe the proposed sequence; they are not elapsed time or new delivery commitments. Work already completed across later phases is recorded below.

## At a glance

| Phase | Original PRD slot | Deliverable | Current status |
| --- | --- | --- | --- |
| 1 | Week 1 | CLI, file discovery, routing, parser protocol | Implemented |
| 2 | Week 2 | JS/TS resolver and dependency graph | Implemented; two confirmed accuracy bugs remain |
| 3 | Week 3 | Tree impact and merged reports | Implemented |
| 4 | Week 4 | CSS/SCSS, JSON, YAML, HTML, Markdown checkers | Baseline implemented; documented coverage limits |
| 5 | Week 5 | Persistence, saved-scan comparison, JSON output | JSON output implemented; persistence and comparison not started |
| 6 | Week 6 | Tests, accuracy validation, documentation, demo | In progress |
| 7 | Week 7 | Optional local web harness | Not started; optional |

The required CLI workflow is available. Broader accuracy and performance validation remain unfinished. PostgreSQL and the harness are optional in the PRD, even though persistence also appears as FR-07 and in its week-five roadmap.

## Phase 1 — CLI foundation

**Status: implemented.**

- [x] Python CLI using Typer and Rich.
- [x] Deterministic file discovery and extension routing.
- [x] Built-in exclusions, nested `.gitignore`, and `.repohealthignore` rules.
- [x] Explicit coverage for unsupported, excluded, and skipped files.
- [x] Persistent Node parser subprocess using NDJSON protocol v1.
- [x] `all`, `structure`, and `health` modes.
- [x] Output flags, severity thresholds, logging, and explicit exit codes.
- [x] Parser installation through `blastradius setup`.

**Acceptance:** the CLI discovers eligible files, dispatches checkers, reports coverage, and handles unavailable parser dependencies without modifying the scanned repository.

## Phase 2 — JS/TS resolution and graph construction

**Status: implemented; accuracy hardening required next.**

- [x] Parse static imports, re-exports, CommonJS imports, and literal dynamic imports.
- [x] Resolve local modules, TypeScript path aliases, and package exports.
- [x] Read nearest tsconfig/jsconfig and package declarations.
- [x] Distinguish file, package, and unresolved graph nodes.
- [x] Report missing modules, undeclared/uninstalled packages, and version mismatches.
- [x] Exclude built-ins, non-source imports, and declaration-only targets from propagation.
- [ ] Reject TypeScript-only syntax in JavaScript files where JavaScript grammar forbids it.
- [ ] Recognize shadowed `require` identifiers instead of treating every call named `require` as a package import.
- [ ] Broaden fixtures for workspace layouts, resolver configurations, and ambiguous module patterns.

**Confirmed regressions to address:**

```javascript
// main.js: currently produces no issue, although the type annotation is invalid JavaScript.
const count: number = 1;
```

```javascript
// Currently reports an undeclared package, although require is a local parameter.
function demo(require) {
  return require('not-a-package');
}
```

**Acceptance:** both reproductions have regression tests and correct results; existing resolution tests continue to pass; unsupported cases remain explicit rather than silently treated as validated.

## Phase 3 — Tree impact and output merging

**Status: implemented.**

- [x] Reverse traversal with cycle protection.
- [x] Unique affected counts, eligible counts, and percentages.
- [x] Direct and transitive dependents.
- [x] One deterministic shortest dependency path per affected file.
- [x] Root-node labeling when no dependents exist.
- [x] Severity-grouped text and JSON reports.
- [x] Explicit No Tree Impact notes for non-JS/TS findings.
- [x] Partial-graph disclosure and deterministic IDs/output.

**Acceptance:** the demo's broken Chart module affects Dashboard, Grid, and App; cycles do not inflate counts; non-graph issues never receive dependency traversal.

**Boundary:** the report preserves the full edge set but does not enumerate every possible route through cyclic or diamond-shaped graphs. Root status describes the scanned graph, not proof of a runtime entry point.

## Phase 4 — Local file checkers

**Status: baseline implemented.**

- [x] CSS/SCSS parser errors and local stylesheet imports.
- [x] JSON syntax, local reference files, JSON Pointers, and named anchors.
- [x] JSON-with-comments syntax for recognized configuration files.
- [x] YAML syntax and indentation tabs.
- [x] HTML local assets/pages, base URLs, and source sets.
- [x] Markdown links, images, reference links, and embedded HTML.

**Acceptance:** covered local failures have the correct issue type, file, line, severity, and `has_tree_impact: false`.

**Known limits / potential extensions:**

- CSS `url()` image/font targets are not checked; this would extend the PRD's explicit CSS import taxonomy.
- HTML/Markdown fragment anchors are not validated.
- Sass interpolation and custom package load paths are not resolved.
- Nested JSON Schema `$id` rebasing is not implemented.
- Full type checking, CSS property/value semantics, and runtime correctness are not part of this baseline.
- Remote references are not fetched, preserving offline scans.

These coverage extensions are not presented as completed work or automatically added to the required MVP.

## Phase 5 — Persistence and comparison

**Status: JSON output implemented; storage and comparison not started. Optional persistence milestone.**

- [x] Machine-readable JSON reports and stable serialization.
- [ ] PostgreSQL schema and migrations.
- [ ] Project identity and project-match validation.
- [ ] `blastradius scan --save`.
- [ ] Store scans, components, dependencies, issues, and top-N impact results.
- [ ] Store `has_tree_impact` without remediation fields.
- [ ] `blastradius compare ID1 ID2` for base-to-head comparisons.
- [ ] Database integration and comparison tests.

**Acceptance:** two scans can be saved and compared for the same project; added, resolved, and changed findings are reported deterministically; ordinary scans continue to work without a database.

The detailed v2.1 database design referenced by the PRD was not supplied. Schema decisions must therefore be documented before implementing storage.

## Phase 6 — Accuracy, validation, and release readiness

**Status: in progress.**

- [x] 45 local tests passing at the implementation baseline.
- [x] Linux and Windows CI on Python 3.11, 3.12, and 3.13.
- [x] Read-only behavior, cycles, scan modes, coverage limits, and deterministic output tests.
- [x] Wheel/source package builds and clean wheel installation validation.
- [x] Installation documentation, report contract, and deliberately broken demo.
- [x] A synthetic 1,000-file benchmark measured below five seconds after optimization.
- [ ] Regression tests and fixes for the two confirmed Phase 2 bugs.
- [ ] A representative real-repository fixture set with reviewed expected findings.
- [ ] Defined and measured false-positive/false-negative accuracy targets.
- [ ] Larger, deeper, and denser dependency-graph performance/memory checks.
- [ ] Broader coverage of scans exceeding 5,000 files.
- [ ] macOS validation before claiming tested support on that platform.

**Acceptance:** known accuracy regressions are closed, validation results are reproducible, and published coverage/performance claims match the measured evidence. One synthetic benchmark is not evidence that every 1,000-file repository meets the target.

## Phase 7 — Local web harness

**Status: not started; optional.**

- [ ] FastAPI service with a static local browser interface.
- [ ] `blastradius harness` command.
- [ ] Browse diagnostics, dependency impact, and unchecked-file coverage.
- [ ] Reuse the existing report contract and scanner.
- [ ] Validate local access, scan boundaries, and read-only operation.

**Acceptance:** a user can run a scan and inspect its results in a local browser. A full React dashboard is explicitly outside the PRD's MVP scope.

## Next execution order

1. Fix the two confirmed Phase 2 accuracy bugs and add regression tests.
2. Complete the remaining Phase 6 accuracy and scale validation.
3. Implement Phase 5 if proceeding with saved history and comparison.
4. Implement Phase 7 if proceeding with the optional browser harness.

Python, Go, and Rust checkers remain a later language-expansion milestone (called "Phase 2" in the PRD's scope section, separate from the week-two JS/TS work above). Automatic fixes and fix suggestions remain deliberately excluded.

## References

- [Product requirements v3.0](product-requirements-v3.txt)
- [Implementation decisions and missing-appendix assumptions](implementation-decisions.md)
- [Report and worker contracts](report-contract.md)
- [Installation and usage](../README.md)
