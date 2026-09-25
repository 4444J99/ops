#!/usr/bin/env python3
"""Single-resource owner release: exact source, strict binding custody, additive SQL.

Default operation is a read-only preflight. Apply requires both --apply and an
exact OPS_APPLY_SOURCE match. No credentials, source, or raw settings are emitted.
"""
from __future__ import annotations
import argparse, hashlib, json, math, os, re, sqlite3, subprocess, sys, time, urllib.error, urllib.request, uuid
from email import policy
from email.parser import BytesParser
from pathlib import Path
API='https://api.cloudflare.com/client/v4'
ROOT=Path(__file__).resolve().parents[1]
WORKER='ops-scheduler-production'
LEGACY='982048aebacde2af449ed0ff1cb26dcf4c4bb74a36abd7ca09f1f0871e6d5808'
HELPERS={'finishline.mjs':'7efe3e34d925c63eb972fd5c4d42be9668919c03','diagnosis.mjs':'ce5ae0aa93be70a7c4c836a99d7870608fc66fd7'}
CONTROL="SELECT source_sha,activate_after,enabled FROM ops_control WHERE id='dispatcher'"
INSTALL="INSERT INTO ops_control(id,source_sha,activate_after,enabled) VALUES('dispatcher',?,?,1) ON CONFLICT(id) DO UPDATE SET source_sha=excluded.source_sha,activate_after=excluded.activate_after,enabled=1"
class SafeError(RuntimeError):pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise SafeError('redirect_refused')
OPENER=urllib.request.build_opener(NoRedirect())
def blob(raw):return hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest()
def digest(raw):return hashlib.sha256(raw).hexdigest()
def decode(raw):
 try:return json.loads(raw)
 except Exception:raise SafeError('invalid_provider_json') from None
def modules(kind,raw):
 if not kind.lower().startswith('multipart/'):return {'index.js':raw}
 msg=BytesParser(policy=policy.default).parsebytes(('Content-Type: '+kind+'\r\n\r\n').encode()+raw)
 result={}
 for part in msg.iter_parts():
  name=part.get_filename() or part.get_param('name',header='content-disposition')
  if name=='metadata':continue
  if name not in ('index.js',*HELPERS) or name in result:raise SafeError('unexpected_live_module')
  result[name]=part.get_payload(decode=True) or b''
 if 'index.js' not in result:raise SafeError('live_main_missing')
 return result
class Client:
 def __init__(self,token):
  if not token:raise SafeError('credential_missing')
  self.token=token;self.account=None;self.db=None
 def request(self,path,method='GET',data=None,kind='application/json',raw=False):
  base='/accounts/'+str(self.account)
  readable=(path=='/accounts?per_page=50' or bool(re.fullmatch(r'/accounts/[a-f0-9]{32}/workers/subdomain',path)) or
    path in [base+'/workers/scripts/'+name+'/'+part for name in ('ops-scheduler','ops-scheduler-staging',WORKER)
             for part in ('settings','schedules','content/v2','deployments')])
  writable=method=='PUT' and path==base+'/workers/scripts/'+WORKER+'?bindings_inherit=strict'
  query=method=='POST' and self.db and path==base+'/d1/database/'+self.db+'/query'
  if not ((method=='GET' and readable) or writable or query):raise SafeError('release_endpoint_refused')
  req=urllib.request.Request(API+path,method=method,data=data,headers={
   'Authorization':'Bearer '+self.token,'Content-Type':kind,'User-Agent':'ops-owner-release/2'})
  try:
   with OPENER.open(req,timeout=45) as response:
    content=response.read(2000001);content_type=response.headers.get('Content-Type','')
  except urllib.error.HTTPError as error:raise SafeError('provider_http_'+str(error.code)) from None
  except (urllib.error.URLError,TimeoutError):raise SafeError('provider_network_failure') from None
  if len(content)>2000000:raise SafeError('provider_response_too_large')
  if raw:return content_type,content
  result=decode(content)
  if not isinstance(result,dict) or result.get('success') is not True or result.get('errors'):raise SafeError('provider_read_or_write_failed')
  return result
 def result(self,path):return self.request(path)['result']
 def resolve_account(self):
  response=self.request('/accounts?per_page=50')
  if response.get('result_info',{}).get('total_pages',1)>1:raise SafeError('account_discovery_incomplete')
  matches=[]
  for row in response['result']:
   aid=row.get('id','')
   if not re.fullmatch('[a-f0-9]{32}',aid):raise SafeError('invalid_account_identity')
   try:value=self.result('/accounts/'+aid+'/workers/subdomain')
   except SafeError:continue
   if value.get('subdomain')=='ivixivi':matches.append(aid)
  if len(matches)!=1:raise SafeError('account_identity_unresolved')
  self.account=matches[0]
 def settings(self,name):return self.result(f'/accounts/{self.account}/workers/scripts/{name}/settings')
 def crons(self,name):return [r['cron'] for r in self.result(f'/accounts/{self.account}/workers/scripts/{name}/schedules')['schedules']]
 def source(self):return modules(*self.request(f'/accounts/{self.account}/workers/scripts/{WORKER}/content/v2',raw=True))
 def sql(self,statement,params=()):
  result=self.request(f'/accounts/{self.account}/d1/database/{self.db}/query','POST',json.dumps({'sql':statement,'params':list(params)}).encode())['result']
  if len(result)!=1 or result[0].get('success') is not True:raise SafeError('sql_failed')
  return result[0].get('results',[])
 def upload(self,settings,bundle,sha):
  metadata={k:v for k,v in settings.items() if k in ('compatibility_date','compatibility_flags','usage_model','logpush','observability','placement','tail_consumers','tags','limits') and v is not None}
  metadata.update(main_module='index.js',bindings=[{'name':b['name'],'type':'inherit'} for b in settings['bindings'] if b['name'] not in ('OPS_CONTROLLER_ENV','OPS_RELEASE_SHA')]+[
   {'name':'OPS_CONTROLLER_ENV','type':'plain_text','text':'production'},
   {'name':'OPS_RELEASE_SHA','type':'plain_text','text':sha}],
   annotations={'workers/message':'ops owner release '+sha,'workers/tag':'ops-isolated-runs-v2'})
  boundary='ops-'+uuid.uuid4().hex;parts=[]
  for name,kind,content in [('metadata','application/json',json.dumps(metadata).encode()),('index.js','application/javascript+module',bundle)]:
   parts.append((f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{name}"\r\nContent-Type: {kind}\r\n\r\n').encode()+content+b'\r\n')
  parts.append(f'--{boundary}--\r\n'.encode())
  self.request(f'/accounts/{self.account}/workers/scripts/{WORKER}?bindings_inherit=strict','PUT',b''.join(parts),'multipart/form-data; boundary='+boundary)
def source_identity():
 sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
 expected=os.environ.get('OPS_SOURCE_SHA','')
 if not re.fullmatch('[a-f0-9]{40}',sha) or sha!=expected:raise SafeError('owner_source_identity_mismatch')
 remote=subprocess.check_output(['git','remote','get-url','origin'],cwd=ROOT,text=True).strip().removesuffix('.git')
 if remote!='https://github.com/4444J99/ops':raise SafeError('source_repository_mismatch')
 return sha

def preflight(client,bundle,targets):
 client.resolve_account();settings=client.settings(WORKER);files=client.source()
 if files=={'index.js':bundle}:source='same_artifact'
 elif digest(files['index.js'])==LEGACY and set(files)=={'index.js',*HELPERS} and all(blob(files[k])==v for k,v in HELPERS.items()):source='verified_incident_baseline'
 else:raise SafeError('live_source_drift')
 crons={n:client.crons(n) for n in ('ops-scheduler','ops-scheduler-staging',WORKER)}
 if crons[WORKER]!=['* * * * *'] or crons['ops-scheduler'] or crons['ops-scheduler-staging']:raise SafeError('duplicate_or_missing_live_clock')
 bindings=settings.get('bindings',[])
 services={b['name']:b for b in bindings if b.get('type')=='service'}
 if set(services)!={t['binding'] for t in targets}:raise SafeError('live_capability_set_drift')
 for t in targets:
  b=services[t['binding']];o=t['ownership']
  if b.get('service')!=o['service'] or (b.get('entrypoint') or 'default')!=o['capability']:raise SafeError('live_capability_identity_drift')
 db=[b for b in bindings if b.get('name')=='SCHED_DB' and b.get('type')=='d1']
 if len(db)!=1:raise SafeError('scheduler_database_missing')
 client.db=db[0]['database_id']
 if client.db!='f1ce9d34-bd31-4573-b752-332bc6313efd':raise SafeError('scheduler_database_identity_drift')
 token_present=any(b.get('name')=='OP_SA_TOKEN' and b.get('type') in ('secret_text','plain_text') for b in bindings)
 if not token_present:raise SafeError('legacy_invocation_credential_unreconciled')
 legacy=client.sql("SELECT payload FROM scheduler_state WHERE id='scheduler:state'")
 if len(legacy)!=1:raise SafeError('legacy_state_missing')
 state=decode(legacy[0]['payload'])
 if not isinstance(state,dict) or not isinstance(state.get('targetStates'),dict):raise SafeError('legacy_state_invalid')
 tick=state.get('lastTick');now=time.time()*1000
 waiting=False
 if source=='same_artifact':
  control=client.sql(CONTROL)
  waiting=bool(control and control[0].get('enabled')==1 and isinstance(control[0].get('activate_after'),(int,float)) and now<control[0]['activate_after']+120000)
 if not waiting and (isinstance(tick,bool) or not isinstance(tick,(int,float)) or not 0<=now-tick<600000):raise SafeError('scheduler_tick_stale')
 return settings,files,state,{'source_relation':source,'clocks_verified':True,'capabilities_verified':True,'legacy_bearer_binding_present':token_present,'product_targets':len(targets)}

def apply(client,settings,files,state,bundle,targets,sha):
 # Apply only complete statements from the reviewed additive migration.
 statement=''
 for line in (ROOT/'migrations/0002_isolated_runs.sql').read_text().splitlines(True):
  statement+=line
  if sqlite3.complete_statement(statement):client.sql(statement);statement=''
 if statement.strip():raise SafeError('incomplete_migration_statement')
 for t in targets:
  old=state.get('targetStates',{}).get(t['name'],{})
  values=[old.get('lastInvokedAt',0),old.get('lastCompletedAt',0),old.get('consecutiveFailures',0)]
  if any(isinstance(v,bool) or not isinstance(v,(int,float)) or not math.isfinite(v) or v<0 for v in values):raise SafeError('legacy_state_invalid')
  status=old.get('lastStatus','skipped')
  if status not in ('success','failure','skipped','timeout'):status='skipped'
  client.sql('INSERT OR IGNORE INTO ops_targets(target,last_started,last_completed,last_status,consecutive_failures) VALUES(?,?,?,?,?)',
    (t['name'],values[0],values[1],status,values[2]))
 current=client.sql(CONTROL)
 if files=={'index.js':bundle}:
  if not current or current[0]['source_sha']!=sha or current[0]['enabled']!=1:raise SafeError('deployed_control_requires_reconciliation')
  return {'state':'ALREADY_DEPLOYED','activate_after':current[0]['activate_after']}
 if client.source()!=files or client.settings(WORKER)!=settings:raise SafeError('preupload_drift')
 # Grace exceeds the previous cron invocation's documented 15-minute lifetime.
 # New code persists due jobs while waiting; no old/new execution overlap is assumed safe.
 activate=int(time.time()*1000)+16*60000
 client.sql(INSTALL,(sha,activate))
 try:
  client.upload(settings,bundle,sha)
 except Exception:
  # Restore admission only when the old artifact is still exact. An ambiguous
  # provider result is never treated as proof that upload did not happen.
  if client.source()==files:
   previous=current[0] if current else {'source_sha':sha,'activate_after':activate,'enabled':0}
   client.sql('UPDATE ops_control SET source_sha=?,activate_after=?,enabled=? WHERE id=\'dispatcher\' AND source_sha=? AND activate_after=?',
     (previous['source_sha'],previous['activate_after'],previous['enabled'],sha,activate))
  raise SafeError('upload_failed_control_reconciled_if_old_source_verified') from None
 if client.source()!={'index.js':bundle}:raise SafeError('source_readback_failed')
 after=client.settings(WORKER)
 before={b['name']:b for b in settings['bindings'] if b['name'] not in ('OPS_CONTROLLER_ENV','OPS_RELEASE_SHA')}
 now={b['name']:b for b in after['bindings'] if b['name'] not in ('OPS_CONTROLLER_ENV','OPS_RELEASE_SHA')}
 if before!=now or client.crons(WORKER)!=['* * * * *']:raise SafeError('binding_or_clock_readback_failed')
 return {'state':'DEPLOYED_AWAITING_ACTIVATION','activate_after':activate,'source_verified':True,'bindings_preserved':True}

def main():
 args=argparse.ArgumentParser();args.add_argument('--apply',action='store_true');opts=args.parse_args()
 report={'mode':'apply' if opts.apply else 'preflight','new_resources':0,'paid_changes':0}
 try:
  sha=source_identity();bundle=(ROOT/'dist/index.js').read_bytes();targets=json.loads((ROOT/'dist/admitted-targets.json').read_text())
  if opts.apply and os.environ.get('OPS_APPLY_SOURCE')!=sha:raise SafeError('apply_source_not_authorized')
  client=Client(os.environ.get('CLOUDFLARE_API_TOKEN',''))
  settings,files,state,result=preflight(client,bundle,targets);report.update(result,source_sha=sha,bundle_sha256=digest(bundle))
  if opts.apply:report.update(apply(client,settings,files,state,bundle,targets,sha))
  else:report['state']='PREFLIGHT_VERIFIED'
 except SafeError as error:report.update(state='ACTION_REQUIRED',error=str(error))
 except Exception:report.update(state='UNOBSERVED',error='release_failed')
 text=json.dumps(report,indent=2,sort_keys=True);print(text)
 if os.environ.get('GITHUB_STEP_SUMMARY'):
  with open(os.environ['GITHUB_STEP_SUMMARY'],'a') as f:f.write('## Ops owner release\n```json\n'+text+'\n```\n')
 if os.environ.get('RUNNER_TEMP'):(Path(os.environ['RUNNER_TEMP'])/'ops-owner-release.json').write_text(text)
 return int('error' in report)
if __name__=='__main__':sys.exit(main())
