CREATE TABLE IF NOT EXISTS bookends (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  target TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  duration_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_bookends_date ON bookends(date);

CREATE TABLE IF NOT EXISTS scheduler_state (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL
);
