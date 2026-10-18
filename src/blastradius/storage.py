"""Optional PostgreSQL storage. Ordinary scans never import the database driver."""

import hashlib
import json
import os
from contextlib import contextmanager
from pathlib import Path
from uuid import NAMESPACE_URL, uuid4, uuid5

MIGRATIONS = Path(__file__).with_name("migrations")


class StoreError(RuntimeError):
    pass


def canonical_root(path: Path) -> str:
    root = path.resolve(strict=True)
    if not root.is_dir():
        raise StoreError("Project path must be an existing directory.")
    return os.path.normcase(str(root)).replace("\\", "/")


class ScanStore:
    def __init__(self, database_url: str | None = None):
        self.database_url = database_url or os.environ.get("BLASTRADIUS_DATABASE_URL")
        if not self.database_url:
            raise StoreError("Set BLASTRADIUS_DATABASE_URL to use saved scans. Ordinary scans do not need a database.")

    @contextmanager
    def _connection(self, *, initialize=False):
        try:
            import psycopg
            from psycopg.rows import dict_row
        except ImportError as error:
            raise StoreError("Install the postgres extra: pip install 'blastradius[postgres]'.") from error
        try:
            with psycopg.connect(self.database_url, connect_timeout=5, row_factory=dict_row) as connection:
                connection.execute("SET LOCAL statement_timeout = '30s'")
                if not initialize:
                    connection.execute("SET LOCAL search_path TO blastradius, pg_catalog")
                    version = connection.execute("SELECT max(version) AS version FROM schema_migrations").fetchone()["version"]
                    if version != 1:
                        raise StoreError("Unsupported database schema version. Run 'blastradius db init' with the matching release.")
                yield connection
        except psycopg.Error as error:
            # Driver exceptions can contain credentials or server filesystem details.
            raise StoreError(f"Database operation failed ({type(error).__name__}). Check the connection and run 'blastradius db init'.") from None

    def initialize(self) -> dict:
        with self._connection(initialize=True) as connection:
            connection.execute("SELECT pg_advisory_xact_lock(1946283101)")
            connection.execute("CREATE SCHEMA IF NOT EXISTS blastradius")
            connection.execute("SET LOCAL search_path TO blastradius, pg_catalog")
            connection.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())")
            applied = {row["version"]: row["checksum"] for row in connection.execute("SELECT version, checksum FROM schema_migrations")}
            files = sorted(MIGRATIONS.glob("*.sql"))
            known = {int(file.name.split("_", 1)[0]) for file in files}
            if set(applied) - known:
                raise StoreError("Database schema is newer than this installation.")
            for file in files:
                version = int(file.name.split("_", 1)[0])
                sql = file.read_text(encoding="utf-8")
                checksum = hashlib.sha256(sql.encode()).hexdigest()
                if version in applied:
                    if applied[version] != checksum:
                        raise StoreError(f"Migration {version} checksum does not match the installed schema.")
                    continue
                connection.execute(sql)
                connection.execute("INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)", (version, checksum))
        return {"schema_version": max(known), "status": "ready"}

    def add_project(self, path: Path, name: str | None = None) -> dict:
        root = canonical_root(path)
        with self._connection() as connection:
            connection.execute("INSERT INTO projects (id, name, root) VALUES (%s, %s, %s) ON CONFLICT (root) DO NOTHING", (str(uuid4()), name or path.resolve().name, root))
            return dict(connection.execute("SELECT id, name, root FROM projects WHERE root = %s", (root,)).fetchone())

    def projects(self) -> list[dict]:
        with self._connection() as connection:
            return list(connection.execute("SELECT id, name, root FROM projects ORDER BY name, root, id"))

    def match_project(self, path: Path, project_id: str | None = None) -> dict:
        root = canonical_root(path)
        with self._connection() as connection:
            project = connection.execute("SELECT id, name, root FROM projects WHERE root = %s", (root,)).fetchone()
            if not project or (project_id is not None and project["id"] != project_id):
                raise StoreError("Scan path does not match the registered project. Register this exact root with 'blastradius project add --path PATH'.")
            return dict(project)

    def save(self, report: dict, path: Path, *, project_id: str | None = None, top_n=20) -> dict:
        project = self.match_project(path, project_id)
        from psycopg.types.json import Jsonb
        if top_n < 1:
            raise StoreError("top_n must be positive.")
        scan_id = str(uuid5(NAMESPACE_URL, f"blastradius:{project['id']}:{report['scan']['id']}"))
        canonical = json.dumps(report, sort_keys=True, ensure_ascii=True)
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        with self._connection() as connection:
            inserted = connection.execute(
                "INSERT INTO scans (id, project_id, report_id, mode, partial, report_hash, report) VALUES (%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING RETURNING id",
                (scan_id, project["id"], report["scan"]["id"], report["scan"]["mode"], report["scan"]["partial"], digest, Jsonb(report)),
            ).fetchone()
            if not inserted:
                previous = connection.execute("SELECT report_hash FROM scans WHERE id = %s", (scan_id,)).fetchone()
                if previous["report_hash"] != digest:
                    raise StoreError("A different report already uses this scan ID; stored scans are immutable.")
            else:
                graph = report["graph"] or {"nodes": [], "edges": []}
                nodes = sorted(set(graph["nodes"]) | {f"file:{file}" for file in report["scan"]["checked_files"]})
                with connection.cursor() as cursor:
                    cursor.executemany("INSERT INTO components (scan_id, key, kind, path) VALUES (%s,%s,%s,%s)", [(scan_id, node, *node.split(":", 1)) for node in nodes])
                    cursor.executemany("INSERT INTO dependencies (scan_id, source, target) VALUES (%s,%s,%s)", [(scan_id, edge["source"], edge["target"]) for edge in graph["edges"]])
                    cursor.executemany("INSERT INTO issues (scan_id, ordinal, file, line, type, severity, target, has_tree_impact, payload) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)", [
                        (scan_id, index, issue["file"], issue["line"], issue["type"], issue["severity"], issue["target"], issue["has_tree_impact"], Jsonb(issue)) for index, issue in enumerate(report["issues"])
                    ])
                    impacts = {issue["file"]: issue["impact"] for issue in report["issues"] if issue["has_tree_impact"]}
                    ranked = sorted(impacts.items(), key=lambda item: (-item[1]["affected_count"], item[0]))[:top_n]
                    cursor.executemany("INSERT INTO impacts (scan_id, file, rank, affected_count, payload) VALUES (%s,%s,%s,%s,%s)", [(scan_id, file, rank, impact["affected_count"], Jsonb(impact)) for rank, (file, impact) in enumerate(ranked, 1)])
        return {"id": scan_id, "project_id": project["id"]}

    def load(self, scan_id: str) -> dict:
        with self._connection() as connection:
            result = connection.execute("SELECT id, project_id, report FROM scans WHERE id = %s", (scan_id,)).fetchone()
            if result is None:
                raise StoreError("Saved scan ID was not found.")
            return dict(result)

    def scans(self, project_id: str, limit=20) -> list[dict]:
        if not 1 <= limit <= 1000:
            raise StoreError("Scan history limit must be between 1 and 1000.")
        with self._connection() as connection:
            if not connection.execute("SELECT id FROM projects WHERE id = %s", (project_id,)).fetchone():
                raise StoreError("Project ID was not found.")
            records = list(connection.execute("SELECT id, report_id, mode, partial, saved_at FROM scans WHERE project_id = %s ORDER BY saved_at DESC, id LIMIT %s", (project_id, limit)))
            return [{**record, "saved_at": record["saved_at"].isoformat()} for record in records]
