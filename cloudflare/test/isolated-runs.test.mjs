import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const ts=require(process.env.TYPESCRIPT_PATH||'typescript');
const root=resolve(import.meta.dirname,'..'),build=mkdtempSync(join(tmpdir(),'ops-runtime-'));
for(const name of readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts'))) {
 const compiled=ts.transpileModule(readFileSync(join(root,'src',name),'utf8'),{
  compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},fileName:name,
 }).outputText.replace(/(from\s+['"]|import\(['"])(\.\/[\w-]+)(['"])/g,'$1$2.mjs$3');
 writeFileSync(join(build,name.replace(/\.ts$/,'.mjs')),compiled);
}
const {RunStore,MAX_INFLIGHT}=await import(pathToFileURL(join(build,'run-store.mjs')));
const {tick,default:worker}=await import(pathToFileURL(join(build,'index.mjs')));
const {SCHEDULE_MANIFEST}=await import(pathToFileURL(join(build,'manifest.mjs')));
const {invokeTarget}=await import(pathToFileURL(join(build,'invoker.mjs')));
const C=await import(pathToFileURL(join(build,'contracts.mjs')));
const baseline=structuredClone(SCHEDULE_MANIFEST),SHA='a'.repeat(40),NOW=Date.UTC(2026,8,25,2,30);
const actualNow=Date.now;
function fixture() {
 Date.now=()=>NOW;
 SCHEDULE_MANIFEST.splice(0,SCHEDULE_MANIFEST.length,...structuredClone(baseline));
 const sql=new DatabaseSync(':memory:');
 for(const file of readdirSync(join(root,'migrations')).sort())sql.exec(readFileSync(join(root,'migrations',file),'utf8'));
 sql.prepare("INSERT INTO ops_control VALUES('dispatcher',?,?,1)").run(SHA,NOW-1000);
 const counts={reads:0,writes:0,calls:0};
 const db={prepare(query){let values=[];return {
  bind(...v){values=v;return this;},
  async first(){counts.reads++;return sql.prepare(query).get(...values)??null;},
  async all(){counts.reads++;return {results:sql.prepare(query).all(...values),success:true};},
  async run(){counts.writes++;const result=sql.prepare(query).run(...values);return {success:true,meta:{changes:Number(result.changes)}};},
  exec(){if(/^\s*SELECT/.test(query))return {results:sql.prepare(query).all(...values),success:true};const result=sql.prepare(query).run(...values);return {results:[],success:true,meta:{changes:Number(result.changes)}};}
 }},async batch(statements){sql.exec('BEGIN');try{const result=statements.map(s=>s.exec());sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
 const env={SCHED_DB:db,OPS_RELEASE_SHA:SHA,OPS_CONTROLLER_ENV:'production',OP_SA_TOKEN:'fixture-only'};
 for(const t of SCHEDULE_MANIFEST)env[t.binding]={async fetch(){counts.calls++;return Response.json({ok:true,rid:'product-fixture'});}};
 return {sql,db,env,counts,store:new RunStore(db),target:SCHEDULE_MANIFEST.find(t=>t.name==='edgarflash')};
}
function only(f,name='edgarflash'){for(const t of SCHEDULE_MANIFEST)t.active=t.name===name;return SCHEDULE_MANIFEST.find(t=>t.name===name);}
async function queued(f,t=f.target,time=NOW){await f.store.enqueue([{target:t,payload:{target:t.name,scheduledTime:time,cron:t.schedule}}],NOW,SHA);return (await f.store.candidates(NOW,SCHEDULE_MANIFEST))[0];}
test.after(()=>{Date.now=actualNow;rmSync(build,{recursive:true,force:true});});

test('duplicate simultaneous scheduler ticks invoke a logical job once',async()=>{
 const f=fixture();only(f);await Promise.all([tick({scheduledTime:NOW},f.env),tick({scheduledTime:NOW},f.env)]);
 assert.equal(f.counts.calls,1);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM ops_runs WHERE state='completed'").get().n,1);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM bookends').get().n,2);
});
test('ordinary source deployment does not change logical idempotency identity',async()=>{
 const f=fixture();const key=C.logicalRunKey(f.target,NOW,'scheduled');await queued(f);
 await f.store.enqueue([{target:f.target,payload:{target:f.target.name,scheduledTime:NOW,cron:'* * * * *'}}],NOW,'b'.repeat(40));
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ops_runs').get().n,1);assert.equal(f.sql.prepare('SELECT id FROM ops_runs').get().id,key);
});
test('start bookend is durable BEFORE the product is invoked',async()=>{
 const f=fixture();only(f);f.env.EDGARFLASH.fetch=async()=>{
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM bookends WHERE phase='start'").get().n,1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM bookends WHERE phase='end'").get().n,0);
  return Response.json({ok:true});};await tick({scheduledTime:NOW},f.env);
});
test('one slow product does not delay another product receipt',async()=>{
 const f=fixture();for(const t of SCHEDULE_MANIFEST)t.active=['edgarflash','bountyscope'].includes(t.name);
 let finish,entered;const started=new Promise(r=>entered=r),slow=new Promise(r=>finish=r);
 f.env.BOUNTYSCOPE.fetch=async()=>{entered();await slow;return Response.json({ok:true});};
 const work=tick({scheduledTime:NOW},f.env);await started;await new Promise(r=>setTimeout(r,20));
 assert.equal(f.sql.prepare("SELECT last_status FROM ops_targets WHERE target='edgarflash'").get().last_status,'success');
 assert.equal(f.sql.prepare("SELECT state FROM ops_runs WHERE target='bountyscope'").get().state,'running');
 finish();await work;
});
test('expired execution retains its target lock and rejects stale completion',async()=>{
 const f=fixture();const run=await f.store.claim(await queued(f),f.target,NOW,SHA);
 await f.store.expire(NOW+f.target.ownership.maxDurationMs+30001);
 assert.equal(await f.store.finish(run,{ok:true,rid:run.id},NOW+1),false);
 await f.store.enqueue([{target:f.target,payload:{target:f.target.name,scheduledTime:NOW+60000,cron:f.target.schedule}}],NOW,SHA);
 assert.equal((await f.store.candidates(NOW+60000,SCHEDULE_MANIFEST)).length,0);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM ops_runs WHERE state='pending'").get().n,1);
});
test('wrong owner or fencing generation cannot finalize another execution',async()=>{
 const f=fixture();const run=await f.store.claim(await queued(f),f.target,NOW,SHA);
 for(const bad of [{...run,owner:'other'},{...run,generation:run.generation+1}])assert.equal(await f.store.finish(bad,{ok:true,rid:run.id},NOW+1),false);
 assert.equal(await f.store.finish(run,{ok:true,rid:run.id},NOW+1),true);
 assert.equal(await f.store.finish(run,{ok:true,rid:run.id},NOW+2),false);
});
test('one target cannot overlap with itself across distinct scheduled slots',async()=>{
 const f=fixture();await queued(f);const first=(await f.store.candidates(NOW,SCHEDULE_MANIFEST))[0];await f.store.claim(first,f.target,NOW,SHA);
 await f.store.enqueue([{target:f.target,payload:{target:f.target.name,scheduledTime:NOW+60000,cron:f.target.schedule}}],NOW,SHA);
 const next=f.sql.prepare("SELECT * FROM ops_runs WHERE state='pending'").get();
 assert.equal(await f.store.claim(next,f.target,NOW+60000,SHA),null);
});
test('global in-flight bound survives concurrent tick claimers',async()=>{
 const f=fixture();const due=SCHEDULE_MANIFEST.map(target=>({target,payload:{target:target.name,scheduledTime:NOW,cron:target.schedule}}));
 await f.store.enqueue(due,NOW,SHA);const rows=f.sql.prepare('SELECT * FROM ops_runs').all();
 const claims=await Promise.all(rows.map(run=>f.store.claim(run,SCHEDULE_MANIFEST.find(t=>t.name===run.target),NOW,SHA)));
 assert.equal(claims.filter(Boolean).length,MAX_INFLIGHT);
});
test('target daily dispatch exhaustion preserves queued work without spending other allocations',async()=>{
 const f=fixture();f.target.ownership.maxInvocationsPerDay=1;
 let run=await f.store.claim(await queued(f),f.target,NOW,SHA);await f.store.finish(run,{ok:true,rid:run.id},NOW+1);
 await f.store.enqueue([{target:f.target,payload:{target:f.target.name,scheduledTime:NOW+60000,cron:f.target.schedule}}],NOW,SHA);
 run=f.sql.prepare("SELECT * FROM ops_runs WHERE state='pending'").get();
 assert.equal(await f.store.claim(run,f.target,NOW+60000,SHA),null);
 assert.equal(f.sql.prepare("SELECT calls FROM ops_daily_dispatch WHERE scope='*'").get().calls,1);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM ops_runs WHERE state='pending'").get().n,1);
});
test('a fleet reservation failure rolls back the preceding target reservation',async()=>{
 const f=fixture();const run=await queued(f);f.sql.prepare("INSERT INTO ops_daily_dispatch VALUES('2026-09-25','*',2000)").run();
 assert.equal(await f.store.claim(run,f.target,NOW,SHA),null);
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM ops_daily_dispatch WHERE scope='edgarflash'").get().n,0);
 assert.equal(f.sql.prepare("SELECT state FROM ops_runs").get().state,'pending');
});
test('healthy and uncertain target state updates do not overwrite each other',async()=>{
 const f=fixture();for(const t of SCHEDULE_MANIFEST)t.active=['edgarflash','bountyscope'].includes(t.name);
 f.env.BOUNTYSCOPE.fetch=async()=>new Response('',{status:503});await tick({scheduledTime:NOW},f.env);
 const state=JSON.parse(f.sql.prepare("SELECT payload FROM scheduler_state WHERE id='scheduler:state'").get().payload);
 assert.equal(state.targetStates.edgarflash.lastStatus,'success');assert.equal(state.targetStates.bountyscope.lastStatus,'uncertain');
});
test('accepted is not completed and keeps its execution lock',async()=>{
 const f=fixture();only(f);f.env.EDGARFLASH.fetch=async()=>Response.json({ok:true,state:'accepted'});await tick({scheduledTime:NOW},f.env);
 assert.equal(f.sql.prepare('SELECT state FROM ops_runs').get().state,'accepted');
 assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM bookends WHERE phase='end'").get().n,0);
});
test('timeout remains ambiguous and the timer covers a stalled response body',async()=>{
 const f=fixture();f.target.ownership.maxDurationMs=10;
 f.env.EDGARFLASH.fetch=async()=>new Response(new ReadableStream({start(){}}));
 const result=await invokeTarget(f.env,f.target,{target:f.target.name,scheduledTime:NOW,cron:f.target.schedule});
 assert.equal(result.result.outcome,'uncertain');assert.equal(result.result.error,'timeout');
});
test('invalid receipt and oversized response cannot produce success',async()=>{
 const f=fixture();for(const data of [{ok:'yes'},'x'.repeat(20000)]){
  f.env.EDGARFLASH.fetch=async()=>Response.json(data);const result=await invokeTarget(f.env,f.target,{target:f.target.name,scheduledTime:NOW,cron:f.target.schedule});
  assert.equal(result.result.ok,false);
 }
});
test('a staged or unidentified controller cannot invoke production',async()=>{
 const f=fixture();for(const mode of ['staging','disabled',undefined]){
  f.env.OPS_CONTROLLER_ENV=mode;await assert.rejects(tick({scheduledTime:NOW},f.env));
 }assert.equal(f.counts.calls,0);
});
test('unadmitted release source performs no job effects',async()=>{
 const f=fixture();f.env.OPS_RELEASE_SHA='b'.repeat(40);await assert.rejects(tick({scheduledTime:NOW},f.env),/release_not_admitted/);assert.equal(f.counts.calls,0);
});
test('activation delay queues due work but does not invoke it early',async()=>{
 const f=fixture();only(f);f.sql.prepare('UPDATE ops_control SET activate_after=?').run(NOW+60000);
 await tick({scheduledTime:NOW},f.env);assert.equal(f.counts.calls,0);assert.equal(f.sql.prepare('SELECT state FROM ops_runs').get().state,'pending');
});
test('named capability does not receive the fleet bearer credential',async()=>{
 const f=fixture(),t=SCHEDULE_MANIFEST.find(t=>t.name==='ucc-staging');let headers;
 f.env.UCC_STAGING.fetch=async(_url,init)=>{headers=new Headers(init.headers);return Response.json({ok:true});};
 await invokeTarget(f.env,t,{target:t.name,scheduledTime:NOW,cron:t.schedule,drainOnly:true});assert.equal(headers.has('Authorization'),false);
});
test('public liveness has zero storage reads or writes and no execution effects',async()=>{
 const f=fixture();for(let i=0;i<10000;i++)assert.equal((await worker.fetch(new Request('https://ops/healthz'),f.env)).status,200);
 assert.deepEqual(f.counts,{reads:0,writes:0,calls:0});
});
test('public HTTP cannot execute jobs or update registrations',async()=>{
 const f=fixture();for(const path of ['/internal/run-scheduled','/register','/status'])assert.equal((await worker.fetch(new Request('https://ops'+path,{method:'POST'}),f.env)).status,405);
 assert.equal(f.counts.calls,0);assert.equal(f.counts.writes,0);
});
test('unknown and conflicting resource owners fail registration validation',()=>{
 const f=fixture();const t=structuredClone(f.target);t.ownership.repositoryId=0;assert.throws(()=>C.validateTargets([t]),/owner/);
 const other=structuredClone(f.target);other.name='other';other.binding='OTHER';other.ownership.repositoryId++;
 assert.throws(()=>C.validateTargets([f.target,other]),/conflicting_resource_owner/);
});
test('new registrations cannot use unmeasured budgets or the legacy shared bearer',()=>{
 const f=fixture();assert.throws(()=>C.validateNewRegistration(f.target));
});
test('account admission rejects unmeasured callers and allocations above reserved headroom',()=>{
 const f=fixture();const zero=Object.fromEntries(C.METRICS.map(k=>[k,0]));assert.throws(()=>C.validateAllocation([f.target],C.FREE_ALLOWANCE,zero),/not_fully_measured/);
 const t=structuredClone(f.target);t.ownership.authorization='named-entrypoint';t.ownership.capability='Scheduled';
 t.ownership.resourceBudget={state:'bounded',perInvocation:{...zero},perDay:{...zero,kvWrite:801}};
 assert.throws(()=>C.validateAllocation([t],C.FREE_ALLOWANCE,zero),/allocation_exceeded/);
 t.ownership.resourceBudget.perDay.kvWrite=800;C.validateAllocation([t],C.FREE_ALLOWANCE,zero);
});
test('logical keys separate environments, modes, and scheduled slots but not retry/source',()=>{
 const f=fixture(),t=structuredClone(f.target);const key=C.logicalRunKey(t,NOW,'scheduled');
 assert.notEqual(C.logicalRunKey(t,NOW,'drain'),key);assert.notEqual(C.logicalRunKey(t,NOW+60000,'scheduled'),key);
 t.ownership.environment='staging';assert.notEqual(C.logicalRunKey(t,NOW,'scheduled'),key);
 assert.throws(()=>C.logicalRunKey(t,NaN,'scheduled'));
});

test('inactive queued targets cannot starve an eligible product',async()=>{
 const f=fixture();await f.store.enqueue(SCHEDULE_MANIFEST.map(target=>({target,payload:{target:target.name,scheduledTime:NOW,cron:target.schedule}})),NOW,SHA);
 only(f,'ucc-production');const candidates=await f.store.candidates(NOW,SCHEDULE_MANIFEST);
 assert.equal(candidates.length,1);assert.equal(candidates[0].target,'ucc-production');
});
test('claim scope cannot substitute another environment or resource',async()=>{
 const f=fixture(),run=await queued(f);const wrong=structuredClone(f.target);wrong.ownership.environment='staging';
 await assert.rejects(f.store.claim(run,wrong,NOW,SHA),/claim_scope_mismatch/);
 assert.equal(f.sql.prepare('SELECT state FROM ops_runs').get().state,'pending');
});
test('new work rotates behind the least-recently-served eligible target',async()=>{
 const f=fixture();await queued(f);const run=await f.store.claim((await f.store.candidates(NOW,SCHEDULE_MANIFEST))[0],f.target,NOW,SHA);
 await f.store.finish(run,{ok:true,rid:run.id},NOW+1);
 await f.store.enqueue(SCHEDULE_MANIFEST.filter(t=>['edgarflash','bountyscope'].includes(t.name)).map(target=>({target,payload:{target:target.name,scheduledTime:NOW+60000,cron:target.schedule}})),NOW,SHA);
 assert.equal((await f.store.candidates(NOW+60000,SCHEDULE_MANIFEST))[0].target,'bountyscope');
});
test('invalid cron syntax is not admitted as a silently missing job',()=>{
 const f=fixture();for(const schedule of ['61 * * * *','*/0 * * * *','1junk * * * *','* * *']){
  const t=structuredClone(f.target);t.schedule=schedule;assert.throws(()=>C.validateTargets([t]));
 }
});

test('queued provenance cannot be silently retargeted by a changed manifest',async()=>{
 const f=fixture(),run=await queued(f);
 for(const [key,value] of [['service','another-worker'],['accountRef','another-account'],['repositoryId',1],['contractVersion',2]]){
  const changed=structuredClone(f.target);changed.ownership[key]=value;
  await assert.rejects(f.store.claim(run,changed,NOW,SHA),/claim_scope_mismatch/);
 }
 assert.equal(f.sql.prepare('SELECT state FROM ops_runs').get().state,'pending');
});
test('a receipt parsing failure after dispatch is an uncertain outcome',async()=>{
 const f=fixture();f.env.EDGARFLASH.fetch=async()=>new Response('not JSON');
 const result=await invokeTarget(f.env,f.target,{target:f.target.name,scheduledTime:NOW,cron:f.target.schedule});
 assert.equal(result.result.outcome,'uncertain');
});

test('spare bounded tick capacity drains backlog instead of retaining permanent lag',async()=>{
 const f=fixture();only(f);
 for(let minute=3;minute>0;minute--)await f.store.enqueue([{target:f.target,payload:{target:f.target.name,scheduledTime:NOW-minute*60000,cron:f.target.schedule}}],NOW,SHA);
 await tick({scheduledTime:NOW},f.env);
 assert.equal(f.counts.calls,4);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM ops_runs WHERE state='pending'").get().n,0);
});

test('exhausted targets do not occupy the fair selection window',async()=>{
 const f=fixture();await f.store.enqueue(SCHEDULE_MANIFEST.map(target=>({target,payload:{target:target.name,scheduledTime:NOW,cron:target.schedule}})),NOW,SHA);
 for(const t of SCHEDULE_MANIFEST.filter(t=>t.name!=='ucc-production'))f.sql.prepare("INSERT INTO ops_daily_dispatch VALUES('2026-09-25',?,?)").run(t.name,t.ownership.maxInvocationsPerDay);
 const rows=await f.store.candidates(NOW,SCHEDULE_MANIFEST);assert.equal(rows.length,1);assert.equal(rows[0].target,'ucc-production');
});
test('current lower admission allowance applies to old queued work',async()=>{
 const f=fixture();await queued(f);f.target.ownership.maxInvocationsPerDay=1;
 f.sql.prepare("INSERT INTO ops_daily_dispatch VALUES('2026-09-25','edgarflash',1)").run();
 assert.equal((await f.store.candidates(NOW,SCHEDULE_MANIFEST)).length,0);
});
test('status projects only known fields and retains the existing read interface',async()=>{
 const f=fixture();f.sql.prepare("INSERT INTO scheduler_state VALUES('scheduler:state',?)").run(JSON.stringify({lastTick:NOW,secret:'private-secret',targetStates:{edgarflash:{lastStatus:'success',lastCompletedAt:NOW,token:'private-token'}}}));
 const response=await worker.fetch(new Request('https://ops/status'),f.env);const body=await response.json();
 assert.equal(body.activeTargets.length,6);assert.equal(body.state.targetStates.edgarflash.lastStatus,'success');assert.ok(!JSON.stringify(body).includes('private-'));
 assert.equal(f.counts.reads,1);assert.equal(f.counts.writes,0);
});
test('successive backlog work never starts beyond the per-tick wall budget',async()=>{
 const f=fixture();only(f);for(let minute=5;minute>0;minute--)await f.store.enqueue([{target:f.target,payload:{target:f.target.name,scheduledTime:NOW-minute*60000,cron:f.target.schedule}}],NOW,SHA);
 let count=0;f.env.EDGARFLASH.fetch=async()=>{count++;Date.now=()=>NOW+count*110000;return Response.json({ok:true});};
 await tick({scheduledTime:NOW},f.env);assert.equal(count,3);assert.equal(f.sql.prepare("SELECT COUNT(*) n FROM ops_runs WHERE state='pending'").get().n,3);
});

test('independent observers can read a source-bound result without execution authority',async()=>{
 const f=fixture();only(f);await tick({scheduledTime:NOW},f.env);
 const status=await (await worker.fetch(new Request('https://ops/status'),f.env)).json();
 const id=status.state.targetStates.edgarflash.lastRunId;assert.ok(id);
 const receipt=await (await worker.fetch(new Request('https://ops/receipt?id='+encodeURIComponent(id)),f.env)).json();
 assert.equal(receipt.receipt.state,'completed');assert.equal(receipt.receipt.source_sha,SHA);assert.equal(receipt.receipt.attempt,1);
 assert.equal('owner' in receipt.receipt,false);assert.equal(f.counts.calls,1);
});
test('the receipt interface refuses arbitrary selectors and handles missing jobs honestly',async()=>{
 const f=fixture();assert.equal((await worker.fetch(new Request('https://ops/receipt?id=arbitrary'),f.env)).status,400);
 assert.equal((await worker.fetch(new Request('https://ops/receipt?id=edgarflash:production:123:scheduled'),f.env)).status,404);
 assert.equal(f.counts.calls,0);
});
test('two names cannot register the same resource capability twice',()=>{
 const f=fixture(),other=structuredClone(f.target);other.name='another-name';other.binding='ANOTHER';
 assert.throws(()=>C.validateTargets([f.target,other]),/duplicate_resource_capability/);
});
