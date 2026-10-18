# Saved scans and comparison

Persistence uses PostgreSQL and is optional. Ordinary scans remain offline and need no database or database driver. `--save` explicitly opts into a database connection; it does not modify the scanned repository.

## Install and configure

```sh
python -m pip install -e ".[postgres]"
```

Set `BLASTRADIUS_DATABASE_URL` to your PostgreSQL connection string in your shell or secret manager. Example with placeholder credentials:

```powershell
$env:BLASTRADIUS_DATABASE_URL = "postgresql://USER:PASSWORD@localhost:5432/blastradius"
```

```sh
export BLASTRADIUS_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/blastradius'
```

The database must already exist. The configured database role needs permission to create the `blastradius` schema during initialization and to read/write its tables afterward. Credentials are not written to the repository or printed in command errors.

```sh
blastradius db init
blastradius --format json project add --path /path/to/repository --name my-project
blastradius project list
blastradius scan --path /path/to/repository --save --deterministic-id
blastradius scans --project PROJECT_ID --format json
blastradius compare BASE_SAVED_ID HEAD_SAVED_ID --format json
```

Registration is explicit and idempotent. A saved scan must match the registered canonical root exactly. `scan --save --project PROJECT_ID` additionally verifies the requested identity. Moving a checkout requires registration at its new location; unrelated roots are never silently merged.

The scan report's `storage.id` is the ID accepted by `compare`; it is also printed in text output and returned by `scans`. This ID is scoped to the registered project. It is distinct from `scan.id`, which identifies report contents in deterministic mode. Re-saving an identical deterministic report is idempotent. An existing ID cannot overwrite a different report.

## Schema and transactions

Versioned SQL migrations live in `src/blastradius/migrations` and are included in built wheels. `db init` applies them under a transaction and advisory lock. Checksums detect edited migrations, and newer schema versions are rejected. Scans do not apply migrations implicitly.

| Table | Stored data |
| --- | --- |
| `projects` | Registered root and project identity |
| `scans` | Immutable full report, hash, mode, coverage status, save time |
| `components` | Checked files and graph file/package/unresolved nodes |
| `dependencies` | Directed graph edges with component foreign keys |
| `issues` | Diagnostic fields, full issue payload, `has_tree_impact` |
| `impacts` | Top 20 distinct failing source files, ranked by affected count |
| `schema_migrations` | Applied versions and checksums |

All records for one saved scan commit together. Failure rolls back the scan and its child rows. There are no remediation columns. The full report retains every impact result even though the normalized impact table stores the top 20.

## Comparison semantics

- Compare only scans from the same project, report schema, and scan mode.
- Match findings by file, type, and target; line movement, severity, messages, and impact differences appear as changed records.
- Preserve multiple occurrences of the same diagnostic identity.
- Report added, resolved, changed, unchanged, and unverified counts.
- Missing findings from an incomplete head scan, or files outside its checked set, are unverified rather than resolved. Removed and newly ignored files cannot be distinguished reliably from these report fields.
- Different scanner versions, limits, or incomplete coverage are disclosed and result in exit code 3.
- Otherwise, `--fail-on` applies to added/changed findings, not unchanged historical findings. Exit codes remain 0/1/2/3 for pass, threshold failure, operation error, and incomplete comparison.

## Integration testing

CI starts an isolated PostgreSQL 17 service and tests migrations, registration, save/load, normalized records, project matching, immutable IDs, rollback, and the CLI save/compare flow. Locally, set `BLASTRADIUS_TEST_DATABASE_URL` to an expendable test database and run `pytest -q tests/test_storage.py tests/test_comparison.py`. These tests create project/scan records; they never delete existing projects or drop a database.

Implementation references: [Psycopg transactions and parameterized queries](https://www.psycopg.org/psycopg3/docs/basic/usage.html), [PostgreSQL documentation](https://www.postgresql.org/docs/).
