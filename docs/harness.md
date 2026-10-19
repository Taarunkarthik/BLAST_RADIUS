# Local browser harness

The optional harness presents the existing scanner in a browser. It runs locally and does not upload repositories, execute project code, or alter scanned files.

## Start

```sh
python -m pip install -e ".[harness]"
blastradius setup
blastradius harness --path /path/to/repository --port 8765
```

Open the address printed by the command, normally [http://127.0.0.1:8765](http://127.0.0.1:8765). Keep the terminal running; Ctrl+C stops the server. The repository's `examples/demo` directory is a useful first scan: **10 / 10 files checked, 0 unsupported**, including its valid SVG, with five intentional findings and a Chart module with three dependent files.

![Demo report with ten checked files and zero unsupported files](assets/harness.png)

Regenerate this screenshot from the real local harness with `python -m playwright install chromium` followed by `python scripts/ui_capture.py` (requires the `dev,harness` extras). The script starts and stops its own loopback server, verifies the demo counts and coverage in Chromium, and writes `docs/assets/harness.png`.

## Inspect a scan

1. Leave the directory as `.` or select a subdirectory within the startup root.
2. Choose Full scan, Structure only, or Health only, then Run scan.
3. Search findings or filter by severity; select a row to inspect its dependency paths.
4. Open Coverage for checked, excluded, unsupported, incomplete, and unresolved cases.
5. Export JSON to download the complete report.

The browser paginates findings, shows at most 200 dependency paths per finding, and shows the first 200 entries per coverage group. Each truncated view says so; JSON export retains the complete report. Health mode has no graph, and non-JS/TS findings explicitly show No Tree Impact. Partial scans show a coverage warning.

## Save and compare

Install the `postgres` extra and follow [database initialization and project registration](persistence.md). Set `BLASTRADIUS_DATABASE_URL` in the shell before starting the harness. The Save scan control appears when that setting exists; a successful connection and registered project are still required.

Run a scan, save it, change your project, and save another scan. Open Saved scans, select a base and head, and compare. The history lists the latest 100 scans for the startup root. To save a subdirectory as a separate project, register it and start a harness with that directory as `--path`. This keeps saved history and comparison scoped to the same project.

The browser displays comparison totals and the first 100 records per change category. Use `blastradius compare BASE_SAVED_ID HEAD_SAVED_ID --format json` for the complete comparison.

## Local access and limits

- Uvicorn binds to `127.0.0.1`; there is no remote-host option.
- Requests require a loopback peer and localhost Host header. Cross-origin and cross-site requests are rejected. API calls require the per-process session token delivered by the local page.
- Paths resolve inside the selected root; symlink escapes and parent directories are rejected.
- Only one scan or save runs at a time. Requests are limited to 8 KiB; scan API bounds are 20,000 files and 10 MB per file. The UI uses the scanner defaults of 5,000 files and 2 MB.
- The latest report is held in memory until shutdown. Saving requires its current report ID, so an older browser view cannot accidentally save a newer report.
- Static assets are bundled in the wheel; there are no external fonts, scripts, or CDNs. Content Security Policy disallows inline scripts and framing. Diagnostic strings are rendered as text.

This is a single-user development harness, not a multi-user hosting service. It does not serve arbitrary repository files or provide file editing.

Implementation references: [FastAPI](https://fastapi.tiangolo.com/), [Uvicorn settings](https://www.uvicorn.org/settings/).
