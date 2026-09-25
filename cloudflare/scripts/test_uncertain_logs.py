import json
import unittest
from unittest.mock import patch, MagicMock
import uncertain_logs as m

class LogTests(unittest.TestCase):
 def test_window_is_bounded_read_only_query(self):
  body=m.request_payload('edgarflash',{'started_at':1000000})
  self.assertTrue(body['dry']);self.assertEqual(body['timeframe'],{'from':940000,'to':2200000})
  self.assertEqual(body['limit'],100)
  for service in ('limen-runtime','https://evil.test'):
   with self.assertRaises(m.r.SafeError):m.request_payload(service,{'started_at':1})
 def test_redacts_payloads_messages_and_provider_ids(self):
  event={'timestamp':123,'$workers':{'outcome':'exceededCpu','cpuTimeMs':12,'wallTimeMs':120},
   'message':'private-token CPU time limit exceeded','account':'private-account','body':'private-customer'}
  result=m.project_event(event,'edgarflash:production:1:scheduled')
  self.assertNotIn('private-',json.dumps(result));self.assertEqual(result['outcome'],'exceededCpu')
  self.assertIn('cpu_limit',result['signals'])
 def test_run_correlation_is_explicit_not_inferred(self):
  key='edgarflash:production:1:scheduled'
  self.assertTrue(m.project_event({'message':key},key)['mentions_logical_run'])
  self.assertFalse(m.project_event({'message':'edgarflash'},key)['mentions_logical_run'])
 def test_uncertain_only_and_no_mutation_client_calls(self):
  class Client:account='a'*32;token='test-only'
  response=MagicMock();response.__enter__.return_value=response
  response.read.return_value=b'{"success":true,"result":{"events":{"events":[]}}}'
  runs=[{'id':'edgarflash:production:1:scheduled','target':'edgarflash','state':'uncertain','started_at':1000000},
        {'id':'x','target':'vulnpulse','state':'completed'}]
  with patch.object(m.r.OPENER,'open',return_value=response) as call:
   out=m.collect(Client(),runs)
  self.assertEqual(len(out),2);self.assertEqual(call.call_count,2)
  self.assertTrue(all(json.loads(c.args[0].data)['dry'] for c in call.call_args_list))
 def test_provider_failure_never_leaks(self):
  class Client:account='a'*32;token='private-token'
  runs=[{'id':'edgarflash:production:1:scheduled','target':'edgarflash','state':'uncertain','started_at':1000000}]
  with patch.object(m.r.OPENER,'open',side_effect=ValueError('private-error')):
   result=m.collect(Client(),runs)
  self.assertNotIn('private-',json.dumps(result));self.assertTrue(all(x['state']=='unobserved' for x in result))
