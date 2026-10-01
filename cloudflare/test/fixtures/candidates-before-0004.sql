-- Candidate selection from accepted revision 35c60b741ab3df2011b163d7a2fd17c0ef8bebe0.
-- Regression fixture only: compare semantics and local SQLite work with its schema.
WITH admitted AS (
  SELECT json_extract(value,'$.target') AS target,json_extract(value,'$.limit') AS call_limit FROM json_each(?)
) SELECT r.* FROM ops_runs r JOIN ops_targets t ON t.target=r.target JOIN admitted a ON a.target=r.target
LEFT JOIN ops_daily_dispatch d ON d.scope=r.target AND d.day=?
WHERE r.state='pending' AND r.scheduled_at<=? AND t.next_allowed<=?
  AND COALESCE(d.calls,0)<MIN(r.call_limit,a.call_limit)
  AND COALESCE((SELECT calls FROM ops_daily_dispatch WHERE scope='*' AND day=?),0)<2000
  AND NOT EXISTS(SELECT 1 FROM ops_runs live WHERE live.target=r.target AND live.state IN('running','uncertain','accepted'))
  AND r.id=(SELECT next.id FROM ops_runs next WHERE next.target=r.target AND next.state='pending' ORDER BY next.scheduled_at,next.id LIMIT 1)
ORDER BY t.last_started,r.deadline,r.id LIMIT ?
