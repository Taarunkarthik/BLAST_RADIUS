# Local browser harness

The optional harness presents the existing scanner in a browser. It runs locally and does not upload repositories, execute project code, or alter scanned files.

## Start

```sh
python -m pip install -e ".[harness]"
blastradius setup
blastradius harness --path /path/to/repository --port 8765
```

On a fresh clone you can instead run `./scripts/bootstrap.sh` (Windows: `.\scripts\bootstrap.ps1`),
which is idempotent and does the install and `blastradius setup` in one step; pass an extras list
such as `harness,postgres`, or an empty string for the base package only.

Open the address printed by the command, normally [http://127.0.0.1:8765](http://127.0.0.1:8765). Keep the terminal running; Ctrl+C stops the server. The repository's `examples/demo` directory is a useful first scan: **10 / 10 files checked, 0 unsupported**, including its valid SVG, with five intentional findings and a Chart module with three dependent files.

![Demo report with ten checked files and zero unsupported files](assets/harness.png)

Regenerate this screenshot from the real local harness with `python -m playwright install chromium` followed by `python scripts/ui_capture.py --demo` (requires the `dev,harness` extras). The script starts and stops its own loopback server, verifies the demo counts and coverage in Chromium, and writes `docs/assets/harness.png`.

## Design

The interface follows a Swiss / International Typographic style: a strict black, white, and grey palette, one grotesque type stack for copy, and monospace with tabular figures for every path, line number, issue type, id, and count. Structure comes from flat 1px rules and whitespace — there are no rounded corners, shadows, gradients, or blur. Colour is reserved for severity alone: red (high), yellow (medium), and blue (low) on badges, the severity donut, and graph node fills. Light is the default; the theme toggle inverts the same tokens for dark mode. Tokens live in `src/blastradius/static/styles.css`, shell chrome in `styles/shell.css`, and the module layout is described in `src/blastradius/static/CONTRACT.md`. The Dependencies view is the exception to the shared shell: it hides the side rail so the graph fills the whole tab, with two floating docks for tools and legend.

## Shell

Every view shares one shell:

- **Project switcher** (top bar). The button shows the current scan path. Its menu lists recent folders (remembered in `localStorage`) and a live subfolder browser backed by `GET /api/directories?path=<relative-path>`, which returns the folders directly under that path — scoped to the harness root — plus the parent path. Selecting a folder sets the scan path; run a scan to load it. If the endpoint is unavailable the menu degrades to the recent-folder list and says so.
- **Command palette** (Ctrl/Cmd-K, or the Commands button). Type to filter, arrow keys to move, Enter to run, Esc to close. Commands navigate to any view, toggle the theme, switch project, run a scan, and clear the findings filters.
- **Theme toggle** (top bar). Light is the default; the choice persists in `localStorage` under `blastradius-theme`.
- **Scan strip.** Choose the directory within the workspace and a mode (Full scan, Structure only, Health only), then Run scan. The notice banner reports progress and results, and Export JSON downloads the complete report.

## Inspect a scan

1. Leave the directory as `.` or select a subdirectory within the startup root, choose a mode, then Run scan.
2. **Overview** is the impact-first dashboard: a metric strip (files checked, issues, high severity, affected files), an inline SVG severity donut, a **Top blast radius** leaderboard of the findings with the widest reach, and a coverage bar. A banner appears here when the scan is partial.
3. **Findings** is the full diagnostic list in monospace with severity badges and highlighted search matches. Severity and **Tree impact only** filters and severity/file/impact sorting narrow the list; selecting a finding opens a detail panel with a terminal-style impact diagram of its direct and transitive dependents, plus copy actions for the report ID and the CLI command.
4. **Map** is a DSA-style node-link tree of the scanned filesystem, drawn as inline SVG (see below).
5. **Dependencies** draws the JS/TS import graph as a full-bleed inline SVG — files are squares, packages are diamonds, and unresolved imports are triangles — with smooth cubic Bézier edges. The graph owns the tab (no side rail); two floating docks hold the tools (top) and the legend plus selected-node card (bottom). A left→right / top→down orientation toggle, wheel zoom-to-cursor, − / % / + buttons, and Fit pan and scale the drawing, and labels are placed under a collision-aware budget. When the graph exceeds 300 nodes a cap notice appears and asks you to filter. The `→ imports` legend, toolbar Scan and Export JSON actions, a roving-tabindex keyboard walk (arrows, Enter/Space, Home/End), search cycling, and click-to-clear keep it operable without a mouse.
6. **Coverage** summarizes what was and was not checked with a summary bar and grouped tables for unsupported, excluded, incomplete, and checked files; rows deep-link into Findings or the Map.
7. **Saved scans** lists saved scans and compares a base and head pair in a flat diff table (see below).
8. Export JSON to download the complete report.

### The Map tree

The Map is a tidy node-link tree: the real report's coverage lists and issues are folded into a directory-to-file tree, laid out so leaves sit in sequence and parents are centred, and painted in inline SVG. Folders are 1px rectangles (showing their aggregate severity and file count); files are 1px circles filled by severity. Unchecked, excluded, and skipped files are dashed and muted.

Three orientations share one layout engine — **Top-down**, **Left-right**, and **Radial** — chosen from the toolbar; the linear orientations use orthogonal elbow connectors and the radial layout uses quadratic arcs. Folders collapse and expand by click (or Enter/Space; ArrowLeft/ArrowRight on a focused folder), and deep folders start collapsed so large trees stay readable. The toolbar zooms (− / + / FIT) and a search box finds a node by name or path, revealing and path-highlighting it (Enter cycles matches). Selecting a file opens a side panel with its issues, imports, imported-by files, and reverse blast radius (direct and transitive, with distances), plus buttons to open the finding in Findings or the file in Dependencies.

## Routing

Sections use hash routes (`#overview`, `#findings`, `#findings/<finding-id>`, `#map`, `#dependencies`, `#coverage`, `#history`), so browser Back/Forward work and a reload restores the last report held in memory. Findings deep-link via `#findings/<finding-id>`, and unknown routes fall back to Overview. Map and Dependencies share the selected node, so a file opened from one is already selected in the other. The UI is a small dependency-free ES-module app described in `src/blastradius/static/CONTRACT.md`.

The browser paginates findings (30 per page), shows at most 200 dependency paths per finding, and shows the first 200 entries per coverage group. Each truncated view says so; JSON export retains the complete report. Health mode has no graph, and non-JS/TS findings explicitly show No Tree Impact. Partial scans show a coverage warning.

## Save and compare

Install the `postgres` extra and follow [database initialization and project registration](persistence.md). Set `BLASTRADIUS_DATABASE_URL` in the shell before starting the harness. The Save scan control appears when that setting exists; a successful connection and registered project are still required.

Run a scan, save it, change your project, and save another scan. Open Saved scans, select a base and head, and compare. The history lists the latest 100 scans for the startup root. To save a subdirectory as a separate project, register it and start a harness with that directory as `--path`. This keeps saved history and comparison scoped to the same project.

The browser displays comparison totals and the first 100 records per change category. Use `blastradius compare BASE_SAVED_ID HEAD_SAVED_ID --format json` for the complete comparison.

## Audit log

Harness startup records a `harness_start` event, and every scan through the browser records a
`harness_scan` event (action `scan`) with the scanned root, mode, report id, duration, findings,
exit code, outcome, and the loopback peer. These go to the same local audit log the CLI writes:
`BLASTRADIUS_AUDIT_LOG` when set, otherwise `~/.blastradius/audit.log`. Like the CLI, the harness
never records file contents, database URLs, or session tokens. Read the entries back with
`blastradius audit`; see the [README](../README.md#audit-log) for the format and the disable switch.

## Local access and limits

- Uvicorn binds to `127.0.0.1`; there is no remote-host option.
- Requests require a loopback peer and localhost Host header. Cross-origin and cross-site requests are rejected. API calls require the per-process session token delivered by the local page.
- Paths resolve inside the selected root; symlink escapes and parent directories are rejected.
- Only one scan or save runs at a time. Requests are limited to 8 KiB; scan API bounds are 20,000 files and 10 MB per file. The UI uses the scanner defaults of 5,000 files and 2 MB.
- The latest report is held in memory until shutdown. Saving requires its current report ID, so an older browser view cannot accidentally save a newer report.
- Static assets are bundled in the wheel; there are no external fonts, scripts, or CDNs. Content Security Policy disallows inline scripts and framing. Diagnostic strings are rendered as text.

This is a single-user development harness, not a multi-user hosting service. It does not serve arbitrary repository files or provide file editing.

Implementation references: [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn settings](https://www.uvicorn.org/settings/).
