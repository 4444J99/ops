/** Bounded capability invocation. The timeout covers headers AND body parsing. */
import type { Env, Target, ScheduledPayload, RunResult, InvocationResult } from './types';
import { assertController } from './contracts';
const INTERNAL_PATH='/internal/run-scheduled';
export function failureCode(error:unknown):string {
 const text=String(error??'');
 if(/abort|timeout/i.test(text))return 'timeout';
 if(/subrequests|too many api requests/i.test(text))return 'invocation_request_limit';
 if(/kv.*(?:limit|quota)/i.test(text))return 'kv_quota';
 return 'invocation_failed';
}
async function readBounded(response:Response):Promise<unknown> {
 const reader=response.body?.getReader();
 if(!reader)throw new Error('response_missing');
 const chunks:Uint8Array[]=[];let total=0;
 try {
  for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;
   if(total>16384)throw new Error('response_limit');chunks.push(value);}
 } finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 return JSON.parse(new TextDecoder().decode(bytes));
}
export async function invokeTarget(env:Env,target:Target,payload:ScheduledPayload):Promise<InvocationResult> {
 const rid=payload.runId??crypto.randomUUID(),started=Date.now();
 let timer:ReturnType<typeof setTimeout>|undefined;
 let aborted=false,dispatched=false;
 const controller=new AbortController();
 let result:RunResult;
 try {
  assertController(target,env.OPS_CONTROLLER_ENV);
  if(payload.target!==target.name || !Number.isSafeInteger(payload.scheduledTime))throw new Error('invalid_dispatch');
  const binding=env[target.binding] as Fetcher;
  if(!binding?.fetch)throw new Error('binding_missing');
  const headers:Record<string,string>={'Content-Type':'application/json','X-Scheduler-RID':rid};
  if(target.ownership.authorization==='legacy-bearer') {
   if(typeof env.OP_SA_TOKEN!=='string'||!env.OP_SA_TOKEN) throw new Error('credential_missing');
   headers.Authorization='Bearer '+env.OP_SA_TOKEN;
  }
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
   aborted=true;controller.abort();reject(new Error('timeout'));
  },target.ownership.maxDurationMs);});
  const operation=(async()=>{
   dispatched=true;
   const response=await binding.fetch('https://internal'+INTERNAL_PATH,{
    method:'POST',headers,body:JSON.stringify(payload),signal:controller.signal});
   if(!response.ok) {
    await response.body?.cancel().catch(()=>{});
    return {ok:false,rid,error:response.status===401||response.status===403?'authorization':`http_${response.status}`,outcome:'failed'} as RunResult;
   }
   const body=await readBounded(response) as Record<string,unknown>;
   if(!body || typeof body!=='object' || typeof body.ok!=='boolean') return {ok:false,rid,error:'invalid_receipt',outcome:'uncertain'} as RunResult;
   // Legacy v1's ok=true means its bounded invocation completed, not backlog empty.
   const accepted=body.state==='accepted'||body.status==='accepted'||body.accepted===true;
   const outcome=accepted?'accepted':body.ok?'completed':'failed';
   const result:RunResult={ok:body.ok,rid,outcome,...(!body.ok?{error:'product_failed'}:{})};
   for(const key of ['completedItems','pendingItems'] as const)
    if(Number.isSafeInteger(body[key]) && (body[key] as number)>=0) result[key]=body[key] as number;
   return result;
  })();
  result=await Promise.race([operation,timeout]);
 } catch(error) {
  const code=failureCode(error);
  result={ok:false,rid,error:aborted?'timeout':code,outcome:dispatched?'uncertain':'failed'};
 } finally {if(timer!==undefined)clearTimeout(timer);}
 return {targetName:target.name,bindingName:target.binding,result:{...result,durationMs:Date.now()-started}};
}
/** Compatibility helper; bounded to two in-flight operations in one invocation. */
export async function invokeAllTargets(env:Env,due:{target:Target;payload:ScheduledPayload}[]):Promise<InvocationResult[]> {
 const results:InvocationResult[]=new Array(due.length);let next=0;
 async function lane(){for(;;){const i=next++;if(i>=due.length)return;results[i]=await invokeTarget(env,due[i].target,due[i].payload);}}
 await Promise.all([lane(),lane()]);return results;
}
