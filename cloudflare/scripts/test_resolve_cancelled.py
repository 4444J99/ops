import copy,json,sqlite3,unittest
from pathlib import Path
import resolve_cancelled as m

class ResolutionTests(unittest.TestCase):
 def fixture(self):
  db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
  for path in sorted((Path(__file__).parents[1]/'migrations').glob('*.sql')):db.executescript(path.read_text())
  db.execute("INSERT INTO ops_control VALUES('dispatcher',?,0,1)",(m.SOURCE_SHA,))
  db.execute("INSERT INTO ops_runs(id,target,environment,repository_id,service,account_ref,contract_version,scheduled_at,mode,state,created_at,source_sha,call_limit,deadline) VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,?,?)",
   (m.RUN_ID,'edgarflash','production',1228965461,'edgarflash','primary-cloudflare',1,1790332980000,'scheduled',1790332980000,m.SOURCE_SHA,1440,1790333580000))
  db.execute("UPDATE ops_runs SET state='running',generation=440,owner='exact-owner',attempt=1,started_at=1790333044256,lease_until=1790333184256")
  db.execute("UPDATE ops_runs SET state='uncertain',error_code='lease_expired'")
  class Client:
   def sql(self,statement,params=()):return [dict(row) for row in db.execute(statement,params).fetchall()]
  return db,Client(),dict(db.execute('SELECT * FROM ops_runs').fetchone())
 def test_real_sql_preserves_failed_history_and_never_records_success(self):
  db,c,run=self.fixture();result=m.apply_resolution(c,run,1790357460000)
  self.assertEqual(result['state'],'failed');self.assertEqual(result['error_code'],m.CODE)
  self.assertEqual(db.execute('SELECT last_completed FROM ops_targets').fetchone()[0],0)
  self.assertEqual(db.execute("SELECT status FROM bookends WHERE phase='end'").fetchone()[0],'failure')
  self.assertEqual(db.execute('SELECT COUNT(*) FROM ops_runs').fetchone()[0],1)
 def test_changed_generation_owner_or_source_cannot_be_finalized(self):
  for field,value in [('owner','new-owner'),('generation',441),('source_sha','b'*40)]:
   db,c,run=self.fixture();db.execute(f'UPDATE ops_runs SET {field}=?',(value,))
   with self.assertRaises(m.r.SafeError):m.apply_resolution(c,run,1790357460000)
   self.assertEqual(db.execute('SELECT state FROM ops_runs').fetchone()[0],'uncertain')
 def test_expired_lease_alone_is_not_a_cancellation_proof(self):
  _,_,run=self.fixture()
  for events in [[],[{'outcome':'ok','mentions_logical_run':True}],
   [{'outcome':'canceled','mentions_logical_run':False}]]:
   with self.assertRaises(m.r.SafeError):m.cancellation_proof([{'service':'edgarflash','run_id':m.RUN_ID,'state':'observed','limited':False,'events':events}],run)
 def test_only_correlated_product_cancellation_is_accepted(self):
  _,_,run=self.fixture();event={'outcome':'canceled','mentions_logical_run':True,'timestamp':run['started_at']+372,'event_sha256':'a'*64}
  evidence=[{'service':'edgarflash','run_id':m.RUN_ID,'state':'observed','limited':False,'events':[event]}]
  self.assertEqual(m.cancellation_proof(evidence,run),['a'*64])
  for field,value in [('service','ucc-mca-edge-staging'),('limited',True),('run_id','other')]:
   bad=copy.deepcopy(evidence);bad[0][field]=value
   with self.assertRaises(m.r.SafeError):m.cancellation_proof(bad,run)
 def test_matching_product_ack_is_not_overwritten_by_cancelled_diagnosis(self):
  _,_,run=self.fixture()
  with self.assertRaises(m.r.SafeError):m.reject_matching_ack([{'payload':json.dumps({'scheduled_at':run['scheduled_at'],'ok':True})}],run)
  m.reject_matching_ack([{'payload':json.dumps({'scheduled_at':run['scheduled_at']-60000,'ok':True})}],run)
 def test_running_recent_unknown_target_and_repeated_resolution_are_refused(self):
  _,c,run=self.fixture()
  for key,value in [('state','running'),('target','ucc-staging'),('attempt',2)]:
   with self.assertRaises(m.r.SafeError):m.validate_run({**run,key:value},1790357460000)
  with self.assertRaises(m.r.SafeError):m.validate_run(run,run['lease_until']+1)
  m.apply_resolution(c,run,1790357460000)
  with self.assertRaises(m.r.SafeError):m.apply_resolution(c,run,1790357460000)

if __name__=='__main__':unittest.main()
