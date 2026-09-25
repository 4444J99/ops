-- Additive runtime custody. Old records remain; no product data is migrated here.
CREATE TABLE IF NOT EXISTS ops_control (
  id TEXT PRIMARY KEY CHECK(id='dispatcher'),
  source_sha TEXT NOT NULL,
  activate_after INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN(0,1))
);
CREATE TABLE IF NOT EXISTS ops_targets (
  target TEXT PRIMARY KEY,
  generation INTEGER NOT NULL DEFAULT 0,
  last_started INTEGER NOT NULL DEFAULT 0,
  last_completed INTEGER NOT NULL DEFAULT 0,
  last_status TEXT NOT NULL DEFAULT 'skipped',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_allowed INTEGER NOT NULL DEFAULT 0,
  last_run_id TEXT,
  failure_code TEXT
);
CREATE TABLE IF NOT EXISTS ops_runs (
  id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN('production','staging')),
  repository_id INTEGER NOT NULL,
  service TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  contract_version INTEGER NOT NULL,
  scheduled_at INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN('scheduled','drain')),
  state TEXT NOT NULL CHECK(state IN('pending','running','completed','failed','uncertain','accepted')),
  owner TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  source_sha TEXT NOT NULL,
  call_limit INTEGER NOT NULL CHECK(call_limit>0),
  deadline INTEGER NOT NULL,
  error_code TEXT,
  completed_items INTEGER,
  pending_items INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ops_one_inflight_per_target ON ops_runs(target)
  WHERE state IN('running','uncertain','accepted');
CREATE INDEX IF NOT EXISTS ops_due_runs ON ops_runs(state,scheduled_at,target);
CREATE INDEX IF NOT EXISTS ops_target_history ON ops_runs(target,started_at);
CREATE INDEX IF NOT EXISTS ops_expired_leases ON ops_runs(state,lease_until);
CREATE TABLE IF NOT EXISTS ops_daily_dispatch (
  day TEXT NOT NULL, scope TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day,scope)
);
CREATE TRIGGER IF NOT EXISTS ops_register_pending AFTER INSERT ON ops_runs
BEGIN
  INSERT OR IGNORE INTO ops_targets(target) VALUES(NEW.target);
END;
CREATE TRIGGER IF NOT EXISTS ops_admit_claim BEFORE UPDATE OF state ON ops_runs
WHEN NEW.state='running' AND OLD.state='pending'
BEGIN
  -- Charge reservations even if a process dies. Ambiguous work is never refunded.
  INSERT OR IGNORE INTO ops_daily_dispatch(day,scope) VALUES(date(NEW.started_at/1000,'unixepoch'), NEW.target);
  INSERT OR IGNORE INTO ops_daily_dispatch(day,scope) VALUES(date(NEW.started_at/1000,'unixepoch'), '*');
  UPDATE ops_daily_dispatch SET calls=calls+1
    WHERE day=date(NEW.started_at/1000,'unixepoch') AND scope=NEW.target AND calls<NEW.call_limit;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'target_dispatch_budget_exhausted') END;
  UPDATE ops_daily_dispatch SET calls=calls+1
    WHERE day=date(NEW.started_at/1000,'unixepoch') AND scope='*' AND calls<2000;
  SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'fleet_dispatch_budget_exhausted') END;
END;
CREATE TRIGGER IF NOT EXISTS ops_record_start AFTER UPDATE OF state ON ops_runs
WHEN NEW.state='running' AND OLD.state='pending'
BEGIN
  UPDATE ops_targets SET generation=NEW.generation,last_started=NEW.started_at,last_status='running',last_run_id=NEW.id
    WHERE target=NEW.target;
  INSERT INTO bookends(id,date,target,phase,status,timestamp,duration_ms)
    VALUES(NEW.id||':start:'||NEW.generation,date(NEW.started_at/1000,'unixepoch'),NEW.target,
      'start','running',strftime('%Y-%m-%dT%H:%M:%fZ',NEW.started_at/1000.0,'unixepoch'),NULL);
END;
CREATE TRIGGER IF NOT EXISTS ops_record_terminal AFTER UPDATE OF state ON ops_runs
WHEN OLD.state IN('running','uncertain','accepted') AND NEW.state IN('completed','failed')
BEGIN
  INSERT INTO bookends(id,date,target,phase,status,timestamp,duration_ms)
    VALUES(NEW.id||':end:'||NEW.generation,date(NEW.finished_at/1000,'unixepoch'),NEW.target,
      'end',CASE WHEN NEW.state='completed' THEN 'success' ELSE 'failure' END,
      strftime('%Y-%m-%dT%H:%M:%fZ',NEW.finished_at/1000.0,'unixepoch'),NEW.finished_at-NEW.started_at);
  UPDATE ops_targets SET last_completed=CASE WHEN NEW.state='completed' THEN NEW.finished_at ELSE last_completed END,
    last_status=CASE WHEN NEW.state='completed' THEN 'success' ELSE 'failure' END,
    consecutive_failures=CASE WHEN NEW.state='completed' THEN 0 ELSE consecutive_failures+1 END,
    next_allowed=CASE WHEN NEW.state='completed' THEN 0 ELSE NEW.finished_at+MIN(1800000,30000*(consecutive_failures+1)) END,
    failure_code=NEW.error_code
    WHERE target=NEW.target AND generation=NEW.generation;
END;
CREATE TRIGGER IF NOT EXISTS ops_record_ambiguity AFTER UPDATE OF state ON ops_runs
WHEN OLD.state='running' AND NEW.state IN('uncertain','accepted')
BEGIN
  UPDATE ops_targets SET last_status=NEW.state, failure_code=NEW.error_code
    WHERE target=NEW.target AND generation=NEW.generation;
END;
-- Existing witness compatibility is an atomic projection, never the claim authority.
CREATE TRIGGER IF NOT EXISTS ops_compat_projection AFTER UPDATE ON ops_targets
BEGIN
  INSERT OR IGNORE INTO scheduler_state(id,payload) VALUES('scheduler:state','{"lastTick":0,"targetStates":{}}');
  UPDATE scheduler_state SET payload=json_set(payload,
    '$.lastTick',MAX(COALESCE(json_extract(payload,'$.lastTick'),0),NEW.last_started),
    '$.targetStates.'||json_quote(NEW.target),json_object(
      'lastInvokedAt',NEW.last_started,'lastCompletedAt',NEW.last_completed,
      'lastStatus',NEW.last_status,'consecutiveFailures',NEW.consecutive_failures,
      'lastFailureCode',NEW.failure_code,'lastRunId',NEW.last_run_id))
    WHERE id='scheduler:state';
END;
