/** Exercise the real Miniflare/workerd D1 binding, not a hand-written SQL mock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare} from 'miniflare';
import ts from 'typescript';
import {readFileSync,readdirSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const root=resolve(import.meta.dirname,'..');
test('real D1 preserves atomic claims, reservation rollback, and fenced receipts',{timeout:60000},async()=>{
 const build=mkdtempSync(join(tmpdir(),'ops-d1-'));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',
  compatibilityDate:'2024-09-23',d1Databases:{SCHED_DB:'test-scheduler'}});
 try {
  for(const name of readdirSync(join(root,'src')).filter(x=>x.endsWith('.ts'))) {
   const js=ts.transpileModule(readFileSync(join(root,'src',name),'utf8'),{
    compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},fileName:name,
   }).outputText.replace(/(from\s+['"]|import\(['"])(\.\/[\w-]+)(['"])/g,'$1$2.mjs$3');
   writeFileSync(join(build,name.replace(/\.ts$/,'.mjs')),js);
  }
  const {RunStore}=await import(pathToFileURL(join(build,'run-store.mjs')));
  const {SCHEDULE_MANIFEST}=await import(pathToFileURL(join(build,'manifest.mjs')));
  const db=await mf.getD1Database('SCHED_DB');
  const statements=JSON.parse(execFileSync('python3',['-c',
   'import sqlite3,json,pathlib,sys; out=[]; s=""\nfor p in sorted(pathlib.Path(sys.argv[1]).glob("*.sql")):\n for line in p.read_text().splitlines(True):\n  s+=line\n  if sqlite3.complete_statement(s): out.append(s); s=""\nassert not s.strip(); print(json.dumps(out))',join(root,'migrations')],{encoding:'utf8'}));
  for(const statement of statements)await db.prepare(statement).run();
  const now=Date.now(),sha='a'.repeat(40),store=new RunStore(db),target=structuredClone(SCHEDULE_MANIFEST[1]);
  target.ownership.maxInvocationsPerDay=1;
  await db.prepare("INSERT INTO ops_control VALUES('dispatcher',?,?,1)").bind(sha,now-1).run();
  assert.equal(await store.activation(sha),now-1);
  await store.enqueue([{target,payload:{target:target.name,scheduledTime:now,cron:target.schedule}}],now,sha);
  const [pending]=await store.candidates(now,[target]);
  assert.ok(pending);
  const claims=await Promise.all([store.claim(pending,target,now,sha),store.claim(pending,target,now,sha)]);
  assert.equal(claims.filter(Boolean).length,1);
  const run=claims.find(Boolean);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM bookends WHERE phase='start'").first()).n,1);
  assert.equal(await store.finish({...run,owner:'wrong-owner'},{ok:true,rid:run.id},now+1),false);
  assert.equal(await store.finish(run,{ok:true,rid:run.id},now+2),true);
  const state=JSON.parse((await db.prepare("SELECT payload FROM scheduler_state WHERE id='scheduler:state'").first()).payload);
  assert.equal(state.targetStates[target.name].lastRunId,run.id);
  assert.equal(state.targetStates[target.name].lastStatus,'success');
  await store.enqueue([{target,payload:{target:target.name,scheduledTime:now+60000,cron:target.schedule}}],now,sha);
  const next=await db.prepare("SELECT * FROM ops_runs WHERE state='pending'").first();
  assert.equal(await store.claim(next,target,now+60000,sha),null);
  assert.equal((await db.prepare("SELECT calls FROM ops_daily_dispatch WHERE scope='*'").first()).calls,1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM bookends WHERE phase='end'").first()).n,1);
 } finally {await mf.dispose();rmSync(build,{recursive:true,force:true});}
});
