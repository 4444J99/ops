-- Admission provenance. Records which bundle digest was admitted for each source
-- revision, so later releases can validate the live artifact against the
-- previously admitted revision instead of only the one incident baseline.
-- Per-run capability custody lives on ops_runs (added in 0002 / backfilled by
-- the release script for databases created before the column existed).
CREATE TABLE IF NOT EXISTS ops_admissions (
  source_sha TEXT PRIMARY KEY CHECK(source_sha GLOB '[a-f0-9]*'),
  bundle_sha256 TEXT NOT NULL,
  admitted_at INTEGER NOT NULL
);
