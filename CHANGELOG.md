# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Add `--timeout` to `blastradius scan` to bound the parser worker response deadline (default 60 seconds, minimum 1).
- Support Python 3.14 in the classifiers and the CI matrix.
- Enforce mypy type checking and a 75% coverage floor in CI.
- Add MIT `license`, classifiers, keywords, and `[project.urls]` packaging metadata.
- Add an append-only local audit log (JSON Lines) recording `scan`, `save`, `compare`, `harness_start`, and `harness_scan` actions, plus `blastradius audit` to read it back.
- Add `blastradius doctor` for dependency-free environment checks with OK/WARN/FAIL statuses and exact fixes.
- Add idempotent `scripts/bootstrap.ps1` and `scripts/bootstrap.sh` one-command setup.
- Rework the harness Dependencies view as a full-bleed graph with curved edges, an orientation toggle, zoom-to-cursor, label collision avoidance, a 300-node cap notice, toolbar Scan/Export, and keyboard navigation.

### Fixed
- Send Node parser requests in bounded batches (about 8 MB or 250 files) so peak memory no longer scales with total source size.
- Report a nearest `package.json` that cannot be parsed as a coverage limitation instead of cascading `undeclared_external_package` findings.
- Include workspace-linked local packages whose real path is inside the scan root in the dependency graph.
- Honor `--max-bytes` for JSON reference validation instead of a fixed 2 MB cap.
- Match only structural `$ref` keys so `$ref` text inside string values is not validated.
- Walk directories iteratively so deep trees have no recursion limit.
- Rework the harness request body cap and migrate the harness tests to the httpx ASGI transport.

## [0.1.0] - 2026-10-18

### Added
- Implement read-only repository scanner and tree impact CLI (`07eb250`)
- Add demo, CI, installation docs and resolver performance improvements (`34a53a9`)
- Harden resolution and add PostgreSQL scan history and comparison (`fca0bca`)
- Add local browser harness and complete phase validation (`6ed15dd`)

### Fixed
- Stabilize diagnostic ordering and exclude Windows junctions on Python 3.11 (`a8986a7`)

### Docs
- Establish BlastRadius v3 MVP scope and architecture (`02ee045`)
- Add phased implementation roadmap and current status (`7a66013`)
