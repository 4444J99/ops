import json
import unittest
import runtime_evidence as r

class EvidenceTests(unittest.TestCase):
 def test_integer_rejects_strings_boolean_nonfinite_and_negative(self):
  for value in (True, 'private-secret', float('nan'), float('inf'), -1, 1.5):
   self.assertIsNone(r.integer(value))
  self.assertEqual(r.integer(123),123)
 def test_ids_are_target_bound(self):
  self.assertIsNone(r.run_id('other:production:1:scheduled'))
  self.assertIsNone(r.run_id('edgarflash:production:1:scheduled','vulnpulse'))
  self.assertEqual(r.run_id('edgarflash:production:1:scheduled'),'edgarflash:production:1:scheduled')
 def test_ack_redaction(self):
  result=r.project_ack([{'payload':json.dumps({'ok':True,'scheduled_at':1,'completed_at':2,'secret':'private-secret'}),'updated_at':3}])
  self.assertNotIn('private',json.dumps(result));self.assertTrue(result['ok']);self.assertEqual(result['scheduled_at'],1)
 def test_ack_does_not_invent_completion(self):
  for payload in ('[]','null','{', 'x'*5000):self.assertEqual(r.project_ack([{'payload':payload}])['state'],'invalid')
  self.assertEqual(r.project_ack([])['state'],'unobserved')
 def test_actual_run_status_and_error_are_redacted(self):
  result=r.project_run({'id':'edgarflash:production:1:scheduled','target':'edgarflash','state':'uncertain','error_code':'private-secret','owner':'private-token'})
  self.assertEqual(result['state'],'uncertain');self.assertEqual(result['error_code'],'unclassified');self.assertNotIn('private',json.dumps(result))
 def test_query_scope_is_fixed_and_read_only(self):
  queries=[]
  class Client:
   def sql(self,statement,params=()):
    queries.append((statement,params))
    if statement==r.CONTROL:return [{'source_sha':'a'*40,'activate_after':1,'enabled':1}]
    return []
  report=r.inspect(Client())
  self.assertEqual(report['mutations'],0)
  self.assertEqual(len(queries),7)
  self.assertTrue(all(q.startswith('SELECT ') for q,_ in queries))
  self.assertEqual([p for q,p in queries if q==r.ACK],[('edgarflash',),('trendpulse',),('vulnpulse',)])
 def test_truncated_or_unknown_rows_refused(self):
  with self.assertRaises(ValueError):r.rows([{}]*257,257)
  with self.assertRaises(ValueError):r.project_run({'id':'private','target':'unknown','state':'running'})

 def test_readback_survives_failed_preflight_but_requires_validation(self):
  from pathlib import Path
  text=(Path(__file__).resolve().parents[2]/'.github/workflows/cloudflare-owner-release.yml').read_text()
  self.assertIn('id: validate_owner',text)
  block=text.split('- name: Read per-run custody and product acknowledgement evidence',1)[1].split('- uses:',1)[0]
  self.assertIn("if: always() && !cancelled() && steps.validate_owner.outcome == 'success'",block)
  self.assertNotIn('continue-on-error',text)
