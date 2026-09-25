import unittest
import release as r
class DiagnosticsTests(unittest.TestCase):
 def test_redaction(self):
  message=r.provider_failure(400,b'{"errors":[{"code":7500,"message":"private-secret incomplete input private-account"}]}')
  self.assertEqual(message,'provider_http_400:incomplete_input:codes_7500')
 def test_bad_shape_cannot_escape(self):
  for raw in (b'private-secret',b'[]',b'{"errors":[null,7]}',b'x'*65537):
   self.assertNotIn('private',r.provider_failure(400,raw))
 def test_sql_diagnosis_has_no_sql_or_parameters(self):
  client=r.Client('test-only');client.account='a'*32;client.db='b'*36
  from unittest.mock import patch
  with patch.object(client,'request',side_effect=r.SafeError('provider_http_400:syntax:codes_7500')):
   with self.assertRaises(r.SafeError) as error:client.sql("SELECT private_column FROM private_table",('private-secret',))
  self.assertNotIn('private',str(error.exception));self.assertIn(':sql_',str(error.exception))
 def test_sql_transport_preserves_quoted_text_and_semantics(self):
  sql="-- comment\n SELECT 'a--b  c', 'it''s exact', \"a b\" FROM [a table] /* x */;"
  self.assertEqual(r.transport_sql(sql),"SELECT 'a--b  c', 'it''s exact', \"a b\" FROM [a table] ;")
 def test_all_reviewed_triggers_transport_as_complete_single_statements(self):
  import sqlite3
  database=sqlite3.connect(':memory:')
  database.executescript((r.ROOT/'migrations/0001_initial.sql').read_text())
  statement=''
  for line in (r.ROOT/'migrations/0002_isolated_runs.sql').read_text().splitlines(True):
   statement+=line
   if sqlite3.complete_statement(statement):
    transported=r.transport_sql(statement)
    self.assertNotIn('\n',transported)
    database.execute(transported);statement=''
  self.assertEqual(statement.strip(),'')
  self.assertEqual(database.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger'").fetchone()[0],6)
 def test_unterminated_sql_refused(self):
  for text in ("SELECT 'oops",'/* unfinished'):
   with self.assertRaises(r.SafeError):r.transport_sql(text)
