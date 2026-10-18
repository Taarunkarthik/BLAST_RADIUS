CREATE TABLE projects (
    id text PRIMARY KEY,
    name text NOT NULL,
    root text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE scans (
    id text PRIMARY KEY,
    project_id text NOT NULL REFERENCES projects(id),
    report_id text NOT NULL,
    mode text NOT NULL CHECK (mode IN ('all', 'health', 'structure')),
    partial boolean NOT NULL,
    report_hash text NOT NULL,
    report jsonb NOT NULL,
    saved_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (project_id, report_id)
);
CREATE INDEX scans_project_saved ON scans (project_id, saved_at DESC, id);
CREATE TABLE components (
    scan_id text NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    key text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('file', 'package', 'unresolved')),
    path text NOT NULL,
    PRIMARY KEY (scan_id, key)
);
CREATE TABLE dependencies (
    scan_id text NOT NULL,
    source text NOT NULL,
    target text NOT NULL,
    PRIMARY KEY (scan_id, source, target),
    FOREIGN KEY (scan_id, source) REFERENCES components(scan_id, key) ON DELETE CASCADE,
    FOREIGN KEY (scan_id, target) REFERENCES components(scan_id, key) ON DELETE CASCADE
);
CREATE TABLE issues (
    scan_id text NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    ordinal integer NOT NULL,
    file text NOT NULL,
    line integer NOT NULL CHECK (line > 0),
    type text NOT NULL,
    severity text NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    target text NOT NULL,
    has_tree_impact boolean NOT NULL,
    payload jsonb NOT NULL,
    PRIMARY KEY (scan_id, ordinal)
);
CREATE TABLE impacts (
    scan_id text NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    file text NOT NULL,
    rank integer NOT NULL,
    affected_count integer NOT NULL CHECK (affected_count >= 0),
    payload jsonb NOT NULL,
    PRIMARY KEY (scan_id, file),
    UNIQUE (scan_id, rank)
);
