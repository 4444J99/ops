import importlib.util
import io
import json
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('owner_release',Path(__file__).with_name('release.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Fake:
 def __init__(self,settings=None):
  self.db=sqlite3.connect(':memory:');self.db.row_factory=sqlite3.Row
  self.db.executescript((m.ROOT/'migrations/0001_initial.sql').read_text())
  self.files={'index.js':b'old'};self.configuration=settings or {'bindings':[]}
  self.calls=[];self.failed=False
 def sql(self,statement,params=()):
  self.calls.append(statement)
  return [dict(row) for row in self.db.execute(statement,params).fetchall()]
 def source(self):return self.files
 def settings(self,name):return self.configuration
 def crons(self,name):return ['* * * * *']
 def upload(self,settings,bundle,sha):
  if self.failed:raise m.SafeError('provider_http_500')
  self.files={'index.js':bundle}
  self.configuration={'bindings':settings['bindings']+[{'name':'OPS_RELEASE_SHA','type':'plain_text','text':sha},{'name':'OPS_CONTROLLER_ENV','type':'plain_text','text':'production'}]}

class ReleaseTests(unittest.TestCase):
 def test_request_allowlist_rejects_other_worker_or_resource_mutation(self):
  client=m.Client('test-token');client.account='a'*32;client.db='b'*36
  for path,method in [('/accounts','POST'),('/accounts/'+client.account+'/workers/scripts/edgarflash','PUT'),('/accounts/'+client.account+'/workers/scripts/ops-scheduler-production/schedules','PUT')]:
   with self.assertRaisesRegex(m.SafeError,'release_endpoint_refused'):client.request(path,method)
 def test_missing_credential(self):
  with self.assertRaisesRegex(m.SafeError,'credential_missing'):m.Client('')
 def test_redirect_cannot_forward_authorization(self):
  with self.assertRaisesRegex(m.SafeError,'redirect_refused'):m.NoRedirect().redirect_request(None,None,302,None,None,'https://other')
 def test_source_ref_requires_exact_owner_revision(self):
  with patch.object(m.subprocess,'check_output',return_value='a'*40),patch.dict(m.os.environ,{'OPS_SOURCE_SHA':'b'*40}):
   with self.assertRaisesRegex(m.SafeError,'owner_source_identity_mismatch'):m.source_identity()
 def test_another_repository_cannot_reuse_owner_release(self):
  with patch.object(m.subprocess,'check_output',side_effect=['a'*40,'https://github.com/other/ops.git']),patch.dict(m.os.environ,{'OPS_SOURCE_SHA':'a'*40}):
   with self.assertRaisesRegex(m.SafeError,'source_repository_mismatch'):m.source_identity()
 def test_additive_install_preserves_legacy_data_and_queues(self):
  f=Fake();f.db.execute("INSERT INTO scheduler_state VALUES('scheduler:state','{\"lastTick\":1,\"targetStates\":{}}')")
  result=m.apply(f,{'bindings':[]},f.files,{'targetStates':{}},b'new',[{'name':'edgarflash'}],'a'*40)
  self.assertEqual(result['state'],'DEPLOYED_AWAITING_ACTIVATION')
  self.assertIsNotNone(f.db.execute('SELECT * FROM scheduler_state').fetchone())
  self.assertEqual(f.db.execute('SELECT COUNT(*) FROM ops_targets').fetchone()[0],1)
  row=f.db.execute('SELECT * FROM ops_control').fetchone()
  self.assertGreater(row['activate_after'],m.time.time()*1000+15*60000)
 def test_upload_failure_never_admits(self):
  f=Fake();f.failed=True
  with self.assertRaisesRegex(m.SafeError,'upload_failed'):
   m.apply(f,{'bindings':[]},f.files,{'targetStates':{}},b'new',[],'a'*40)
  self.assertEqual(f.files,{'index.js':b'old'})
  self.assertIsNone(f.db.execute('SELECT * FROM ops_control').fetchone())
 def test_readback_failure_never_admits(self):
  f=Fake()
  original=f.upload
  def tampered(settings,bundle,sha):
   original(settings,bundle,sha)
   f.configuration={'bindings':f.configuration['bindings']+[{'name':'UNEXPECTED','type':'kv'}]}
  f.upload=tampered
  with self.assertRaisesRegex(m.SafeError,'binding_or_clock_readback_failed'):
   m.apply(f,{'bindings':[]},f.files,{'targetStates':{}},b'new',[],'a'*40)
  self.assertIsNone(f.db.execute('SELECT * FROM ops_control').fetchone())
 def test_successful_apply_records_admission(self):
  f=Fake()
  m.apply(f,{'bindings':[]},f.files,{'targetStates':{}},b'new',[],'a'*40)
  row=f.db.execute("SELECT bundle_sha256 FROM ops_admissions WHERE source_sha=?",('a'*40,)).fetchone()
  self.assertEqual(row['bundle_sha256'],m.digest(b'new'))
 def test_idempotent_same_release_does_not_reset_activation(self):
  f=Fake();m.apply(f,{'bindings':[]},f.files,{'targetStates':{}},b'new',[],'a'*40)
  before=f.db.execute('SELECT activate_after FROM ops_control').fetchone()[0]
  result=m.apply(f,f.configuration,f.files,{'targetStates':{}},b'new',[],'a'*40)
  self.assertEqual(result['state'],'ALREADY_DEPLOYED');self.assertEqual(before,result['activate_after'])
 def test_corrupt_legacy_counter_does_not_create_success(self):
  f=Fake()
  with self.assertRaisesRegex(m.SafeError,'legacy_state_invalid'):
   m.apply(f,{'bindings':[]},f.files,{'targetStates':{'x':{'lastInvokedAt':float('nan')}}},b'new',[{'name':'x'}],'a'*40)
  self.assertEqual(f.files,{'index.js':b'old'})
 def test_arbitrary_modules_are_not_released(self):
  raw=b'--X\r\nContent-Disposition: form-data; name="extra.js"; filename="extra.js"\r\n\r\nx\r\n--X--\r\n'
  with self.assertRaisesRegex(m.SafeError,'unexpected_live_module'):m.modules('multipart/form-data; boundary=X',raw)
 def test_output_never_echoes_unexpected_error(self):
  with patch.object(m,'source_identity',side_effect=RuntimeError('private-secret')),patch('sys.argv',['release.py']),patch('sys.stdout',new_callable=io.StringIO) as out,patch.dict(m.os.environ,{},clear=True):
   self.assertEqual(m.main(),1)
   self.assertNotIn('private-secret',out.getvalue());self.assertEqual(json.loads(out.getvalue())['state'],'UNOBSERVED')

class DormantTests(unittest.TestCase):
 def test_canonical_clock_cannot_be_paused(self):
  client=m.Client('test-only')
  with self.assertRaisesRegex(m.SafeError,'canonical_clock_pause_refused'):client.pause(m.WORKER)
 def test_containment_preserves_data_bindings_and_removes_only_product_capabilities(self):
  class Carrier:
   def __init__(self):
    self.files={'index.js':b'old'};self.cron=['* * * * *']
    self.config={'bindings':[{'name':'SCHED_DB','type':'d1','database_id':'test-only'}, {'name':'PRODUCT','type':'service','service':'fixture'}]}
   def source_of(self,name):return self.files
   def settings(self,name):return self.config
   def crons(self,name):return self.cron
   def pause(self,name):self.cron=[]
   def remove_product_bindings(self,name,settings):
    self.config={'bindings':[b for b in settings['bindings'] if b['type']!='service']}
  client=Carrier();name='ops-scheduler-staging'
  snapshot={name:{'files':client.files,'settings':client.config,'crons':client.cron}}
  result=m.contain(client,snapshot,b'new','a'*40)
  self.assertEqual(result[name]['product_bindings'],0)
  self.assertEqual(client.config['bindings'][0]['name'],'SCHED_DB')
 def test_dormant_drift_is_refused_before_any_write(self):
  class Carrier:
   def source_of(self,name):return {'index.js':b'changed'}
   def pause(self,name):raise AssertionError('must not mutate')
  with self.assertRaisesRegex(m.SafeError,'dormant_prewrite_drift'):
   m.contain(Carrier(),{'ops-scheduler':{'files':{'index.js':b'old'},'settings':{},'crons':[]}},b'new','a'*40)

class UploadTests(unittest.TestCase):
 def test_upload_names_worker_not_last_multipart_file(self):
  client=m.Client('test-only');client.account='a'*32
  settings={'bindings':[{'name':'DB','type':'d1','database_id':'fixture'},{'name':'PRODUCT','type':'service','service':'fixture'}]}
  for name in (m.WORKER,):
   with patch.object(client,'request',return_value={}) as send:
    client.upload(settings,b'export default {}','a'*40,name)
   self.assertTrue(send.call_args.args[0].endswith('/'+name+'?bindings_inherit=strict'))
   raw=send.call_args.args[2]
   self.assertIn(b'name="index.js"',raw)
   self.assertEqual(b'"name": "PRODUCT"' in raw,name==m.WORKER)

class MetadataContainmentTests(unittest.TestCase):
 def test_unknown_dormant_source_is_preserved_not_overwritten(self):
  class Carrier:
   files={'index.js':b'new independent source never approved for execution'}
   config={'bindings':[]}
   def source_of(self,name):return self.files
   def settings(self,name):return self.config
   def crons(self,name):return []
   def upload(self,*args):raise AssertionError('must not replace source')
  client=Carrier()
  result=m.contain(client,{'ops-scheduler-staging':{'files':client.files,'settings':client.config,'crons':[]}},b'new','a'*40)
  self.assertTrue(result['ops-scheduler-staging']['source_preserved'])
 def test_unregistered_service_is_not_silently_removed(self):
  with self.assertRaisesRegex(m.SafeError,'dormant_unregistered_capability'):
   m.validate_dormant_bindings({'bindings':[{'name':'OTHER','type':'service','service':'unrelated'}]},[])
 def test_registered_service_can_be_reduced_without_reading_secret_values(self):
  m.validate_dormant_bindings({'bindings':[{'name':'EF','type':'service','service':'edgarflash'},{'name':'PRIVATE','type':'secret_text'}]},[{'binding':'EF','ownership':{'service':'edgarflash'}}])
 def test_dormant_patch_has_only_settings_and_preserves_nonservice_bindings(self):
  client=m.Client('test-only');client.account='a'*32
  settings={'bindings':[{'name':'DB','type':'d1','database_id':'private-id'}, {'name':'SECRET','type':'plain_text','text':'private-secret'}, {'name':'PRODUCT','type':'service','service':'fixture'}]}
  with patch.object(client,'request',return_value={}) as send:
   client.remove_product_bindings('ops-scheduler-staging',settings)
  path,method,data,kind=send.call_args.args
  self.assertEqual(method,'PATCH');self.assertTrue(path.endswith('/ops-scheduler-staging/settings'))
  self.assertIn(b'name="settings"',data);self.assertNotIn(b'private-',data);self.assertNotIn(b'PRODUCT',data)
  self.assertIn(b'"name": "SECRET", "type": "inherit"',data)
 def test_dormant_code_upload_is_not_authorized(self):
  client=m.Client('test-only')
  for name in m.DORMANT:
   with self.assertRaisesRegex(m.SafeError,'upload_target_refused'):client.upload({'bindings':[]},b'new','a'*40,name)
  with self.assertRaisesRegex(m.SafeError,'canonical_binding_removal_refused'):client.remove_product_bindings(m.WORKER,{'bindings':[]})

class PredecessorTests(unittest.TestCase):
 def recorded(self,sha,digest_value):
  f=Fake();m.migrate(f)
  f.db.execute("INSERT INTO ops_control VALUES('dispatcher',?,?,1)",(sha,0))
  if digest_value is not None:
   f.db.execute("INSERT INTO ops_admissions VALUES(?,?,?)",(sha,digest_value,0))
  return f
 def test_recorded_predecessor_accepts(self):
  f=self.recorded('b'*40,m.digest(b'old-live'))
  self.assertTrue(m.verify_predecessor(f,{'index.js':b'old-live'},'a'*40))
 def test_recorded_predecessor_rejects_mismatch(self):
  f=self.recorded('b'*40,m.digest(b'something-else'))
  self.assertFalse(m.verify_predecessor(f,{'index.js':b'old-live'},'a'*40))
 def test_rebuild_fallback_used_when_no_record(self):
  f=self.recorded('b'*40,None)
  with patch.object(m,'rebuild_predecessor_bundle',return_value=m.digest(b'old-live')):
   self.assertTrue(m.verify_predecessor(f,{'index.js':b'old-live'},'a'*40))
  with patch.object(m,'rebuild_predecessor_bundle',return_value=m.digest(b'something-else')):
   self.assertFalse(m.verify_predecessor(f,{'index.js':b'old-live'},'a'*40))
 def test_same_revision_mismatch_is_not_a_predecessor(self):
  f=self.recorded('a'*40,None)
  with patch.object(m,'rebuild_predecessor_bundle',side_effect=AssertionError('must not rebuild')):
   self.assertFalse(m.verify_predecessor(f,{'index.js':b'other'},'a'*40))
 def test_multimodule_live_is_not_a_predecessor(self):
  f=self.recorded('b'*40,m.digest(b'old-live'))
  self.assertFalse(m.verify_predecessor(f,{'index.js':b'old-live','extra.js':b'x'},'a'*40))

class LiveBindingTests(unittest.TestCase):
 def settings(self,*bindings):return {'bindings':list(bindings)}
 def targets(self):return [{'binding':'EDGARFLASH'}]
 def test_exact_expected_set_passes(self):
  m.validate_live_bindings(self.settings({'name':'EDGARFLASH','type':'service'},{'name':'SCHED_DB','type':'d1'},{'name':'OP_SA_TOKEN','type':'secret_text'}),self.targets())
 def test_unexpected_binding_refused(self):
  with self.assertRaisesRegex(m.SafeError,'unexpected_live_binding'):
   m.validate_live_bindings(self.settings({'name':'EDGARFLASH','type':'service'},{'name':'SCHED_DB','type':'d1'},{'name':'EXTRA','type':'kv'}),self.targets())
 def test_unexpected_service_refused(self):
  with self.assertRaisesRegex(m.SafeError,'live_capability_set_drift'):
   m.validate_live_bindings(self.settings({'name':'EDGARFLASH','type':'service'},{'name':'OTHER','type':'service'},{'name':'SCHED_DB','type':'d1'}),self.targets())
 def test_binding_type_drift_refused(self):
  with self.assertRaisesRegex(m.SafeError,'live_binding_type_drift'):
   m.validate_live_bindings(self.settings({'name':'EDGARFLASH','type':'service'},{'name':'SCHED_DB','type':'kv'}),self.targets())

if __name__=='__main__':unittest.main()
