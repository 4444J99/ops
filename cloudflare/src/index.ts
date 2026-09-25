/** One controller; durable per-run claims; product-owned business execution. */
import type {ScheduledEvent,ExecutionContext} from '@cloudflare/workers-types';
import type {Env,Target} from './types';
import {getDueTargets} from './scheduler';
import {getTargetByName,SCHEDULE_MANIFEST} from './manifest';
import {validateTargets,assertController} from './contracts';
import {RunStore,MAX_DISPATCHES_PER_TICK} from './run-store';
import {invokeTarget} from './invoker';
validateTargets(SCHEDULE_MANIFEST);
export const PROTOCOL='ops-isolated-runs-v2';
export async function tick(event:Pick<ScheduledEvent,'scheduledTime'>,env:Env):Promise<void> {
 if(env.OPS_CONTROLLER_ENV!=='production')throw new Error('noncanonical_controller_disabled');
 if(!Number.isSafeInteger(event.scheduledTime)||!Number.isFinite(new Date(event.scheduledTime).getTime()))throw new Error('invalid_scheduled_time');
 const sha=env.OPS_RELEASE_SHA??'',now=Date.now(),store=new RunStore(env.SCHED_DB);
 const tickDeadline=now+330000;
 const activation=await store.activation(sha);
 if(activation===null)throw new Error('release_not_admitted');
 // The release actor installs the accepted source before activation; due work
 // remains queued during cutover rather than vanishing or running twice.
 const due=getDueTargets(event.scheduledTime);
 for(const item of due)assertController(item.target,env.OPS_CONTROLLER_ENV);
 await store.enqueue(due,now,sha);
 if(now<activation)return;
 await store.expire(now);
 let dispatched=0;
 while(dispatched<MAX_DISPATCHES_PER_TICK) {
  const candidates=await store.candidates(Date.now(),SCHEDULE_MANIFEST);
  const claimed=[];
  for(const candidate of candidates.slice(0,MAX_DISPATCHES_PER_TICK-dispatched)) {
   const target=getTargetByName(candidate.target);
   if(!target?.active || Date.now()+target.ownership.maxDurationMs>tickDeadline)continue;
   assertController(target,env.OPS_CONTROLLER_ENV);
   const run=await store.claim(candidate,target,Date.now(),sha);
   if(run)claimed.push({run,target});
  }
  if(!claimed.length)break;
  dispatched+=claimed.length;
  // Each completion is durable independently. Spare tick capacity may then
  // drain older slots; a one-minute outage must not create permanent lag.
  const outcomes=await Promise.allSettled(claimed.map(async({run,target})=>{
   const payload={scheduledTime:run.scheduled_at,cron:target.schedule,target:target.name,
    ...(run.mode==='drain'?{drainOnly:true}:{}),runId:run.id,attempt:run.attempt,
    fencingToken:run.generation,contractVersion:target.ownership.contractVersion};
   const invocation=await invokeTarget(env,target,payload);
   if(!await store.finish(run,invocation.result,Date.now()))throw new Error('stale_completion_refused');
  }));
  if(outcomes.some(outcome=>outcome.status==='rejected'))throw new Error('receipt_write_failed');
 }

}
export default {
 async scheduled(event:ScheduledEvent,env:Env,_ctx:ExecutionContext):Promise<void>{await tick(event,env);},
 async fetch(req:Request,env:Env):Promise<Response>{
  const url=new URL(req.url),headers={'cache-control':'no-store'};
  if(!['GET','HEAD'].includes(req.method))return new Response(null,{status:405,headers:{allow:'GET, HEAD'}});
  let response:Response;
  if(url.pathname==='/health'||url.pathname==='/healthz') {
   response=Response.json({scheduler:'ops-scheduler',protocol:PROTOCOL,check:'liveness_only',revision:env.OPS_RELEASE_SHA??null},{headers});
  } else if(url.pathname==='/status') {
   // Exactly one known-key read, no list, writes, ingestion, or fleet-table scan.
   const row=await env.SCHED_DB.prepare("SELECT payload FROM scheduler_state WHERE id='scheduler:state'").first<{payload:string}>();
   let raw:Record<string,unknown>|null=null;
   try{const parsed=row?JSON.parse(row.payload):null;if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))raw=parsed;}catch{}
   const number=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=8640000000000000?Number(value):null;
   const old=raw?.targetStates as Record<string,Record<string,unknown>>|undefined;
   const targetStates=Object.fromEntries(SCHEDULE_MANIFEST.filter(t=>t.active).map(t=>{
    const value=old?.[t.name]??{};
    return [t.name,{lastInvokedAt:number(value.lastInvokedAt),lastCompletedAt:number(value.lastCompletedAt),
     lastStatus:['success','failure','timeout','running','accepted','uncertain','skipped'].includes(String(value.lastStatus))?value.lastStatus:'unknown',
     consecutiveFailures:number(value.consecutiveFailures),
     lastRunId:typeof value.lastRunId==='string'&&/^[a-z][a-z0-9-]*:(production|staging):\d+:(scheduled|drain)$/.test(value.lastRunId)&&value.lastRunId.length<256?value.lastRunId:null}];
   }));
   const state={lastTick:number(raw?.lastTick),targetStates};
   response=Response.json({scheduler:'ops-scheduler',protocol:PROTOCOL,revision:env.OPS_RELEASE_SHA??null,state,
    lastTick:state.lastTick===null?null:new Date(state.lastTick).toISOString(),
    activeTargets:SCHEDULE_MANIFEST.filter(t=>t.active).map(t=>({name:t.name,schedule:t.schedule,binding:t.binding,state:targetStates[t.name]}))},
    {status:raw?200:503,headers});
  } else if(url.pathname==='/receipt') {
   const id=url.searchParams.get('id')??'';
   if(id.length>255||!/^[a-z][a-z0-9-]*:(production|staging):\d+:(scheduled|drain)$/.test(id))return new Response(null,{status:400});
   const receipt=await env.SCHED_DB.prepare(`SELECT id,target,environment,repository_id,scheduled_at,mode,state,
     generation,attempt,started_at,finished_at,lease_until,source_sha,deadline,error_code,completed_items,pending_items
     FROM ops_runs WHERE id=?`).bind(id).first();
   response=Response.json({protocol:PROTOCOL,receipt},{status:receipt?200:404,headers});
  } else if(url.pathname==='/bookends') {
   const date=url.searchParams.get('date')??new Date().toISOString().slice(0,10);
   const cursor=Number(url.searchParams.get('cursor')??'0');
   if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isSafeInteger(cursor)||cursor<0)return new Response(null,{status:400});
   const result=await env.SCHED_DB.prepare('SELECT rowid AS cursor,target,phase,status,timestamp FROM bookends WHERE date=? AND rowid>? ORDER BY rowid LIMIT 101').bind(date,cursor)
    .all<{cursor:number;target:string;phase:string;status:string;timestamp:string}>();
   const rows=result.results??[],page=rows.slice(0,100);
   response=Response.json({date,count:page.length,nextCursor:rows.length>100?page[99].cursor:null,
    bookends:page.map(r=>`${r.timestamp}\t${r.target}\t-\t-\t${r.phase}\t${r.status}\n`)},{headers});
  } else return new Response('Not Found',{status:404});
  return req.method==='HEAD'?new Response(null,response):response;
 }
};
