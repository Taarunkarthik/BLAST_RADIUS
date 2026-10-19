# MVP implementation decisions

The supplied v3.0 PRD is the product reference. It refers to missing v2.1 appendices (and to an Appendix E that is not included). These explicit decisions make the first implementation reviewable.

- Implement the required CLI MVP first, followed by optional PostgreSQL persistence, saved-scan comparison, and a local FastAPI browser harness. All are now implemented; ordinary CLI scans still need neither optional service.
- A graph edge A -> B means A imports B. An issue propagates from the source file containing the issue. Eligible files are successfully parsed/scanned JS/TS source files, excluding declaration files. Affected counts exclude the failing file itself.
- Report one deterministic shortest dependency path per affected file. Enumerating every path through a cyclic graph is unbounded. The full graph preserves all edges.
- A file with no reverse dependents is labeled `CRITICAL — root node` as required. This is a graph property, not evidence that the file is a runtime entry point.
- Default failure threshold is high. Exit codes: 0 below threshold, 1 findings at/above threshold, 2 invocation/runtime failure, 3 incomplete scan. Incompleteness takes precedence over finding thresholds.
- Always report unsupported files separately from files excluded by mode, size limits, symbolic links, or scan limits. Ignored paths are outside coverage. A limited scan labels impact as partial.
- Walk directories with an explicit stack rather than recursion, so deeply nested trees have no recursion limit.
- Ignore non-source JS/TS imports, Node built-ins, and declaration files as graph vertices. Diagnose non-literal dynamic imports as unsupported resolution. Never execute project code, configuration, install scripts, or network requests during scans.
- Use the nearest package manifest for package declarations and the nearest tsconfig/jsconfig for TypeScript resolution. Read JSON configuration only. Respect TypeScript path mappings and package exports; unsupported resolution is reported rather than guessed.
- A nearest package.json that cannot be parsed is reported as a coverage limitation, making the scan partial, instead of silently yielding cascading undeclared_external_package findings.
- Workspace-linked local packages (npm, yarn, and pnpm workspaces) resolve through node_modules but point at real paths inside the scan root; include those real paths in the dependency graph.
- CSS and SCSS use PostCSS parsers in the same persistent Node worker. This recognizes SCSS syntax without compiling Sass or executing plugins. Other local checks use Python parsers.
- Send node-checker files to the worker in bounded batches (about 8 MB or 250 files each) over the unchanged protocol v1. One worker still serves the whole scan and shares resolution caches, so peak memory tracks a single batch rather than the total source size.
- JSON references validate local files and JSON Pointer fragments. A referenced file is read only up to the scan's `--max-bytes` limit, and exceeding it is reported rather than validated silently. Network references are excluded from local validation. HTML/Markdown validate local file targets; remote URLs and anchor-only links are not fetched or checked. Root-relative links resolve against the scan root.
- Non-JS issues always say that their file type is outside the JS/TS dependency graph, even when an application imports that asset. A zero structural radius does not claim zero runtime impact.
- Deterministic mode omits timestamps and absolute root paths, sorts output, and derives the scan ID from report content and checked file hashes.
- Use TypeScript syntactic diagnostics for JavaScript grammar and symbol declarations to distinguish global CommonJS `require` from locally shadowed identifiers. This does not enable semantic type checking.
- The missing database appendix is replaced by the documented [persistence design](persistence.md): immutable full reports plus normalized records, project-scoped saved IDs, transactional migrations, and top-20 impact rows. Compare conservatively when head coverage cannot establish that a finding was resolved.
- The [browser harness](harness.md) binds only to loopback and scopes scans to its startup directory. It reuses the scanner and report contract, with static HTML/CSS/JavaScript instead of a separate React application. Saving and comparison remain explicit database actions.

## Parser references

- [TypeScript Compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [TypeScript configuration](https://www.typescriptlang.org/tsconfig/)
- [PostCSS SCSS parser](https://github.com/postcss/postcss-scss)
- [PathSpec API](https://python-path-specification.readthedocs.io/en/latest/api.html)

