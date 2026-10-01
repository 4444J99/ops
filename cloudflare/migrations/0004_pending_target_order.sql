-- Additive selection index; retain every queued run, receipt, and historical row.
-- One ordered lookup per admitted target avoids scanning the pending backlog.
CREATE INDEX IF NOT EXISTS ops_pending_target_order ON ops_runs(target,scheduled_at,id)
  WHERE state='pending';
