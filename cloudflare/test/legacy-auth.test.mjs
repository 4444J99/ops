import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require(process.env.TYPESCRIPT_PATH||'typescript');
const root=resolve(import.meta.dirname,'..');
function moduleURL(file){
 let js=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 js=js.replace(/from (['"])(\.\/[\w-]+)\1/g,(_all,quote,path)=>'from '+quote+moduleURL(resolve(dirname(file),path+'.ts'))+quote);
 return 'data:text/javascript;base64,'+Buffer.from(js).toString('base64');
}
const {invokeTarget}=await import(moduleURL(resolve(root,'src/invoker.ts')));
const {SCHEDULE_MANIFEST}=await import(moduleURL(resolve(root,'src/manifest.ts')));
const target=SCHEDULE_MANIFEST.find(t=>t.name==='edgarflash');
const payload={target:target.name,scheduledTime:Date.now(),cron:target.schedule};
test('missing legacy fleet material never fabricates a bearer or bypasses target rejection',async()=>{
 let headers;
 const env={OPS_CONTROLLER_ENV:'production',EDGARFLASH:{async fetch(_url,init){headers=new Headers(init.headers);return new Response(null,{status:401});}}};
 const result=await invokeTarget(env,target,payload);
 assert.equal(headers.has('Authorization'),false);assert.equal(result.result.ok,false);assert.equal(result.result.error,'authorization');
});
test('configured legacy bearer is preserved but absent from result evidence',async()=>{
 let headers;
 const env={OPS_CONTROLLER_ENV:'production',OP_SA_TOKEN:'fixture-only',EDGARFLASH:{async fetch(_url,init){headers=new Headers(init.headers);return Response.json({ok:true});}}};
 const result=await invokeTarget(env,target,payload);
 assert.equal(headers.get('Authorization'),'Bearer fixture-only');assert.equal(JSON.stringify(result).includes('fixture-only'),false);
});
