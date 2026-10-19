# Validation results

Original benchmark measurements: 18 October 2026. File-checker extension: 19 October 2026. These results describe the checked fixtures and hosts, not universal accuracy or performance guarantees.

## Automated checks

The suite covers deterministic output, read-only scans, ignore rules, parser failures, resolver configurations, JS grammar, shadowed CommonJS imports, coverage accounting, cycles, deep paths, comparison uncertainty, database transactions, and the harness API.

Local Windows baseline before the file-checker extension: **84 passed, 6 skipped**. The six skips are PostgreSQL integration tests; they run in the database CI job. The installed Starlette version emits a deprecation warning for its current httpx TestClient adapter; it does not fail the tests.

File-checker extension result on 19 October 2026: **131 passed, 6 database tests skipped**, with the same TestClient deprecation warning. Ruff, `mypy src`, and `mypy src --platform linux` pass. The existing venv reports Python **3.12.10**. SQLGlot and Mako were installed through the optional `languages` extra, and Git Bash was put first on PATH only for the verification processes; the system PATH was not changed. The live Chromium test passes, and the screenshot was regenerated with `scripts/ui_capture.py`.

The repository self-scan exits **0** with **47 / 52 files checked, zero issues**, and five unsupported files (one PNG, one TXT, and three extensionless configuration files). No ignore rules or demo files were changed. A separate temporary directory with valid and invalid examples of every new extension checks **18 / 18 files** and reports **nine expected medium findings** across all eight new issue types; its byte/mtime snapshot remains unchanged. Full command output is saved as local verification artifacts when running the checks, rather than embedded in scanned source files.

CI runs nine OS/Python combinations: Windows, Linux, and macOS with Python 3.11, 3.12, and 3.13. Each job runs lint, tests, the accuracy corpus, a zero-finding self-scan, builds, wheel-content checks, and a clean wheel installation. A tenth job runs against PostgreSQL 17, including actual save/load/rollback and CLI/harness comparison flows. Database tests skip locally when `BLASTRADIUS_TEST_DATABASE_URL` is absent. Follow [GitHub Actions](https://github.com/Taarunkarthik/BLAST_RADIUS/actions) for per-commit results.

## Accuracy corpus

Run `python scripts/accuracy.py` after `blastradius setup`.

| Case | Files checked | Expected diagnostics found | Unexpected | Missed |
| --- | ---: | ---: | ---: | ---: |
| Workspace UI fixture | 8 | 2 | 0 | 0 |
| Configuration and documentation fixture | 10 | 5 | 0 | 0 |
| CommonJS library fixture | 7 | 1 | 0 | 0 |
| Published semver 7.8.5 source, structure mode | 49 | 0 | 0 | 0 |
| Same package with two injected failures | 49 | 2 | 0 | 0 |

Target: zero unexpected or missed diagnostic identities in this reviewed finite corpus. Result: 10 true positives, zero false positives, zero false negatives; corpus precision and recall are both 1.0. The three layout fixtures are authored examples; semver is real published package source pinned by the parser lockfile, copied into a temporary directory for validation. This is a regression gate, not a statistically representative measurement across all repositories. Expected identities include file, issue type, and target; line and severity behavior has separate unit tests.

The resolver regression suite also covers nearest workspace manifests, hoisted dependencies, package imports, JavaScript containing forbidden TypeScript syntax, and parameter/block/function/catch/destructuring/loop bindings named `require`.

## Performance and bounds

On the development Windows host, `python scripts/benchmark.py --files 1000` completed in **4.769 seconds** after the accuracy changes. This temporary repository has 999 dependents of one failing module. It meets the PRD's five-second target for this case; cold caches, slower hosts, different project layouts, and complex configurations can take longer.

`python scripts/scale_benchmark.py` measured graph construction plus one impact traversal with Python allocation tracking:

| Shape | Nodes | Edges | Seconds | Peak traced Python allocation |
| --- | ---: | ---: | ---: | ---: |
| Deep chain | 2,000 | 1,999 | 1.370 | 17.02 MiB |
| Dense cycle | 300 | 89,700 | 2.424 | 37.82 MiB |
| Wide star | 10,000 | 9,999 | 0.853 | 6.23 MiB |

These are graph timings, not full scans; allocation peaks are not whole-process RSS and exclude Node. Automated tests additionally verify a 5,002-file repository stopped at the 5,000-file cap, exact coverage partitioning, deep paths without recursive traversal, and dense cycles without duplicate affected counts. Timing thresholds are not enforced in CI.

## Browser verification

The local demo was exercised through the browser: full and health scans, severity and search filters, finding selection, direct/transitive impact, No Tree Impact, coverage, and the unconfigured saved-history state. With SVG checking enabled, the demo shows **five findings, 10 / 10 checked files, 0 unsupported files**, and three unique affected JS/TS files in full mode. Automated HTTP tests cover loopback/host/origin/session guards, scan boundaries, body limits, concurrent scans, stale report IDs, and read-only behavior. `tests/test_ui.py` verifies the live demo's counts, coverage, and filters in Chromium; `scripts/ui_capture.py` regenerates the documentation screenshot. The PostgreSQL CI job verifies the harness save/history/compare API against a real database; the development machine does not have a running PostgreSQL service.

## Scope boundaries

The checks do not establish semantic type correctness, runtime correctness, CSS value validity, remote-link health, HTML/Markdown fragment existence, custom Sass load paths, or nested JSON Schema `$id` behavior. Python syntax is checked, but Python dependency analysis, Go/Rust analyzers, and remediation remain future scope. See [the tracked phases](PHASES.md).
