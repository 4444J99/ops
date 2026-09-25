"""Bounded, value-free runtime readback owned by ops; SELECT statements only."""
from __future__ import annotations
import datetime as dt
import json
import math
import re

TARGETS = ('bountyscope', 'edgarflash', 'trendpulse', 'vulnpulse', 'ucc-staging', 'ucc-production')
STATES = frozenset(('pending', 'running', 'completed', 'failed', 'uncertain', 'accepted'))
ERRORS = frozenset(('authorization', 'timeout', 'lease_expired', 'binding_missing', 'product_failed',
    'invocation_failed', 'invocation_request_limit', 'kv_quota', 'invalid_receipt'))
CONTROL = "SELECT source_sha,activate_after,enabled FROM ops_control WHERE id='dispatcher'"
TARGET_STATE = 'SELECT target,generation,last_started,last_completed,last_status,consecutive_failures,next_allowed,last_run_id,failure_code FROM ops_targets ORDER BY target LIMIT 257'
RUNS = "SELECT id,target,environment,scheduled_at,mode,state,generation,attempt,started_at,finished_at,lease_until,source_sha,error_code,completed_items,pending_items FROM ops_runs WHERE state IN('running','uncertain','accepted') ORDER BY started_at LIMIT 257"
QUEUE = "SELECT target,state,COUNT(*) AS count,MIN(scheduled_at) AS oldest FROM ops_runs WHERE state IN('pending','running','uncertain','accepted') GROUP BY target,state LIMIT 1025"
ACK = "SELECT payload,updated_at FROM cf_kv_recovery WHERE product=? AND key='last_job'"

# Deliberately do not stringify arbitrary provider values into a public receipt.
def integer(value):
    return value if type(value) is int and 0 <= value <= 8640000000000000 else None

def run_id(value, target=None):
    if not isinstance(value, str) or len(value) > 255:
        return None
    match = re.fullmatch(r'([a-z][a-z0-9-]*):(production|staging):(\d+):(scheduled|drain)', value)
    return value if match and match[1] in TARGETS and (target is None or match[1] == target) else None

def sha(value):
    return value if isinstance(value, str) and re.fullmatch('[a-f0-9]{40}', value) else None

def error_code(value):
    if value is None:
        return None
    return value if isinstance(value, str) and (value in ERRORS or re.fullmatch(r'http_[1-5]\d\d', value)) else 'unclassified'

def rows(value, limit):
    if not isinstance(value, list) or len(value) >= limit or any(not isinstance(v, dict) for v in value):
        raise ValueError('runtime_evidence_incomplete')
    return value

def project_run(value):
    target = value.get('target')
    if target not in TARGETS or not run_id(value.get('id'), target) or value.get('state') not in STATES:
        raise ValueError('runtime_run_identity_invalid')
    result = {k: integer(value.get(k)) for k in ('scheduled_at', 'generation', 'attempt', 'started_at',
        'finished_at', 'lease_until', 'completed_items', 'pending_items')}
    result.update(id=value['id'], target=target, state=value['state'], source_sha=sha(value.get('source_sha')),
        error_code=error_code(value.get('error_code')))
    return result

def project_ack(value):
    if len(value) != 1 or not isinstance(value[0], dict):
        return {'state': 'unobserved'}
    try:
        raw = value[0].get('payload')
        if not isinstance(raw, str) or len(raw) > 4096:
            return {'state': 'invalid'}
        data = json.loads(raw)
        if not isinstance(data, dict):
            return {'state': 'invalid'}
        return {'state': 'observed', 'ok': data.get('ok') if type(data.get('ok')) is bool else None,
            'scheduled_at': integer(data.get('scheduled_at')), 'completed_at': integer(data.get('completed_at')),
            'updated_at': integer(value[0].get('updated_at')), 'run_id': run_id(data.get('run_id'))}
    except (ValueError, TypeError):
        return {'state': 'invalid'}

def inspect(client):
    result = {'observed_at': dt.datetime.now(dt.timezone.utc).isoformat(), 'mode': 'read_only',
        'mutations': 0, 'acknowledgement_policy': 'correlation evidence only; never automatic proof of completed business effects'}
    control = rows(client.sql(CONTROL), 2)
    if len(control) != 1:
        raise ValueError('runtime_control_unobserved')
    result['control'] = {'source_sha': sha(control[0].get('source_sha')),
        'activate_after': integer(control[0].get('activate_after')), 'enabled': control[0].get('enabled') == 1}
    targets = {}
    for value in rows(client.sql(TARGET_STATE), 257):
        name = value.get('target')
        if name not in TARGETS:
            raise ValueError('unknown_runtime_target')
        targets[name] = {k: integer(value.get(k)) for k in ('generation', 'last_started', 'last_completed',
            'consecutive_failures', 'next_allowed')}
        targets[name].update(state=value['last_status'] if value.get('last_status') in STATES | {'success', 'failure', 'timeout', 'skipped'} else 'unknown',
            last_run_id=run_id(value.get('last_run_id'), name), failure_code=error_code(value.get('failure_code')))
    result['targets'] = targets
    result['inflight'] = [project_run(v) for v in rows(client.sql(RUNS), 257)]
    queue = []
    for value in rows(client.sql(QUEUE), 1025):
        if value.get('target') not in TARGETS or value.get('state') not in STATES:
            raise ValueError('unknown_queue_scope')
        queue.append({'target': value['target'], 'state': value['state'], 'count': integer(value.get('count')),
            'oldest_scheduled_at': integer(value.get('oldest'))})
    result['queue'] = queue
    result['product_acknowledgements'] = {name: project_ack(client.sql(ACK, (name,)))
        for name in ('edgarflash', 'trendpulse', 'vulnpulse')}
    return result


def main():
    import os
    from pathlib import Path
    import release as r
    try:
        client = r.Client(os.environ.get('CLOUDFLARE_API_TOKEN', ''))
        client.resolve_account()
        settings = client.settings(r.WORKER)
        databases = [b for b in settings['bindings'] if b.get('name') == 'SCHED_DB' and b.get('type') == 'd1']
        if len(databases) != 1 or databases[0].get('database_id') != 'f1ce9d34-bd31-4573-b752-332bc6313efd':
            raise ValueError('runtime_database_identity_drift')
        client.db = databases[0]['database_id']
        report = inspect(client)
    except Exception:
        report = {'state': 'UNOBSERVED', 'error': 'runtime_readback_failed', 'mode': 'read_only', 'mutations': 0}
    text = json.dumps(report, indent=2, sort_keys=True)
    print(text)
    if os.environ.get('RUNNER_TEMP'):
        (Path(os.environ['RUNNER_TEMP']) / 'ops-owner-runtime.json').write_text(text)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as handle:
            handle.write('## Ops runtime evidence (not a readiness verdict)\n```json\n' + text + '\n```\n')
    return int('error' in report)

if __name__ == '__main__':
    raise SystemExit(main())
