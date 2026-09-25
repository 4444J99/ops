import type { Target, ScheduledPayload, RunResult } from './types';
import { logicalRunKey } from './contracts';
export const MAX_INFLIGHT=4;
export const MAX_DISPATCHES_PER_TICK=4;
export interface Run {
 id:string; target:string; environment:string; scheduled_at:number; mode:'scheduled'|'drain';
 repository_id:number; service:string; account_ref:string; contract_version:number;
 state:string; owner:string; generation:number; attempt:number; started_at:number;
 lease_until:number; deadline:number; source_sha:string;
}
export class RunStore {
 constructor(private db:D1Database) {}
 async activation(sha:string):Promise<number|null> {
  if(!/^[a-f0-9]{40}$/.test(sha)) return null;
  const row=await this.db.prepare("SELECT source_sha,activate_after,enabled FROM ops_control WHERE id='dispatcher'").first<{source_sha:string;activate_after:number;enabled:number}>();
  return row && row.enabled===1 && row.source_sha===sha && Number.isSafeInteger(row.activate_after) ? row.activate_after : null;
 }
 async enqueue(targets:{target:Target;payload:ScheduledPayload}[], now:number, sha:string):Promise<void> {
  // Chunk below provider statement/subrequest bounds. No source-defined empty scans.
  for(let offset=0;offset<targets.length;offset+=8) {
   const statements=targets.slice(offset,offset+8).map(({target:t,payload:p})=>{
    const mode=p.drainOnly?'drain':'scheduled';
    return this.db.prepare(`INSERT OR IGNORE INTO ops_runs
      (id,target,environment,repository_id,service,account_ref,contract_version,scheduled_at,mode,state,created_at,source_sha,call_limit,deadline)
      VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)`).bind(
       logicalRunKey(t,p.scheduledTime,mode),t.name,t.ownership.environment,
       t.ownership.repositoryId,t.ownership.service,t.ownership.accountRef,t.ownership.contractVersion,
       Math.floor(p.scheduledTime/60000)*60000,mode,now,sha,t.ownership.maxInvocationsPerDay,
       p.scheduledTime+t.ownership.freshnessMs);
   });
   if(statements.length) await this.db.batch(statements);
  }
 }
 async expire(now:number):Promise<void> {
  // Timeout is ambiguous. Keep the per-target unique lock until owner reconciliation.
  await this.db.prepare("UPDATE ops_runs SET state='uncertain',error_code='lease_expired' WHERE state='running' AND lease_until<?").bind(now).run();
 }
 async candidates(now:number, targets:readonly Target[]):Promise<Run[]> {
  const admitted=targets.filter(t=>t.active).map(t=>({target:t.name,limit:t.ownership.maxInvocationsPerDay}));
  if(!admitted.length)return [];
  if(admitted.length>256)throw new Error('target_selection_bound');
  const day=new Date(now).toISOString().slice(0,10);
  const result=await this.db.prepare(`WITH admitted AS (
      SELECT json_extract(value,'$.target') AS target,json_extract(value,'$.limit') AS call_limit FROM json_each(?)
    ) SELECT r.* FROM ops_runs r JOIN ops_targets t ON t.target=r.target JOIN admitted a ON a.target=r.target
    LEFT JOIN ops_daily_dispatch d ON d.scope=r.target AND d.day=?
    WHERE r.state='pending' AND r.scheduled_at<=? AND t.next_allowed<=?
      AND COALESCE(d.calls,0)<MIN(r.call_limit,a.call_limit)
      AND COALESCE((SELECT calls FROM ops_daily_dispatch WHERE scope='*' AND day=?),0)<2000
      AND NOT EXISTS(SELECT 1 FROM ops_runs live WHERE live.target=r.target AND live.state IN('running','uncertain','accepted'))
      AND r.id=(SELECT next.id FROM ops_runs next WHERE next.target=r.target AND next.state='pending' ORDER BY next.scheduled_at,next.id LIMIT 1)
    ORDER BY t.last_started,r.deadline,r.id LIMIT ?`).bind(JSON.stringify(admitted),day,now,now,day,MAX_DISPATCHES_PER_TICK).all<Run>();
  return result.results??[];
 }
 async claim(run:Run,target:Target,now:number,sha:string):Promise<Run|null> {
  if(run.target!==target.name || run.environment!==target.ownership.environment
    || run.repository_id!==target.ownership.repositoryId || run.service!==target.ownership.service
    || run.account_ref!==target.ownership.accountRef || run.contract_version!==target.ownership.contractVersion)throw new Error('claim_scope_mismatch');
  const owner=crypto.randomUUID();
  try {
   return await this.db.prepare(`UPDATE ops_runs SET state='running',owner=?,attempt=attempt+1,
     generation=(SELECT generation+1 FROM ops_targets WHERE target=ops_runs.target),
     started_at=?,lease_until=?,source_sha=?,call_limit=MIN(call_limit,?) WHERE id=? AND state='pending'
     AND NOT EXISTS(SELECT 1 FROM ops_runs live WHERE live.target=ops_runs.target AND live.state IN('running','uncertain','accepted'))
     AND (SELECT COUNT(*) FROM ops_runs WHERE state='running')<?
     AND (SELECT next_allowed FROM ops_targets WHERE target=ops_runs.target)<=?
     RETURNING *`).bind(owner,now,now+target.ownership.maxDurationMs+30000,sha,target.ownership.maxInvocationsPerDay,run.id,MAX_INFLIGHT,now).first<Run>();
  } catch(error) {
   if(/(?:target|fleet)_dispatch_budget_exhausted/.test(String(error))) return null;
   throw error;
  }
 }
 async finish(run:Run,result:RunResult,now:number):Promise<boolean> {
  const state=result.outcome??(result.ok?'completed':'failed');
  // A response received after the lease expired is evidence for reconciliation,
  // not authority to commit an obsolete result or unlock another attempt.
  const row=await this.db.prepare(`UPDATE ops_runs SET state=?,finished_at=?,error_code=?,completed_items=?,pending_items=?
    WHERE id=? AND owner=? AND generation=? AND state='running' AND lease_until>=? RETURNING id`)
   .bind(state,now,result.error??null,result.completedItems??null,result.pendingItems??null,
     run.id,run.owner,run.generation,now).first<{id:string}>();
  return !!row;
 }
 async status():Promise<{targets:unknown[];queue:unknown[]}> {
  const [targets,queue]=await this.db.batch([
   this.db.prepare('SELECT target,last_started,last_completed,last_status,consecutive_failures,next_allowed,failure_code FROM ops_targets ORDER BY target LIMIT 100'),
   this.db.prepare("SELECT target,state,COUNT(*) AS count,MIN(scheduled_at) AS oldest_scheduled_at FROM ops_runs WHERE state IN('pending','running','uncertain','accepted') GROUP BY target,state LIMIT 400"),
  ]);
  return {targets:targets.results??[],queue:queue.results??[]};
 }
}
