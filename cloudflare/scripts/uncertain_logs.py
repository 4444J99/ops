"""Bounded provider-log evidence for an existing uncertain run; never replay it."""
from __future__ import annotations
import hashlib
import json
import re
import urllib.error
import urllib.request
import release as r

SERVICES = {'edgarflash': 'edgarflash', 'trendpulse': 'trendpulse', 'vulnpulse': 'vulnpulse',
            'bountyscope': 'bountyscope', 'ucc-staging': 'ucc-mca-edge-staging', 'ucc-production': 'ucc-mca-edge-production'}
OUTCOMES = frozenset(('ok', 'exception', 'exceededCpu', 'exceededMemory', 'canceled', 'unknown',
    'responseStreamDisconnected', 'scriptNotFound', 'exceededDuration', 'internalError'))
SIGNALS = {'cpu_limit': r'exceed.*cpu|cpu.*limit', 'memory_limit': r'exceed.*memory|memory.*limit',
    'context_cancelled': r'context.*cancel|cancel.*context|script will never generate a response',
    'request_limit': r'too many.*requests|subrequest.*limit', 'lease_expired': r'lease_expired',
    'receipt_write_failed': r'receipt_write_failed|stale_completion_refused',
    'network': r'network connection lost|fetch failed', 'database': r'D1_ERROR|SQLITE_ERROR',
    'timeout': r'timed? ?out|timeout|aborted', 'authorization': r'unauthori[sz]ed|HTTP 401'}

def request_payload(service, run):
    start = run.get('started_at')
    if service not in (*SERVICES.values(), r.WORKER) or type(start) is not int or not 0 < start < 8640000000000000 - 1200000:
        raise r.SafeError('log_scope_invalid')
    return {'queryId': 'ops-uncertain-run-evidence-v1', 'dry': True, 'view': 'events', 'limit': 100,
        'timeframe': {'from': start - 60000, 'to': start + 1200000},
        'parameters': {'datasets': [], 'filters': [
            {'key': '$metadata.service', 'operation': 'eq', 'type': 'string', 'value': service}],
            'filterCombination': 'and'}}

def safe_number(value):
    return value if type(value) in (int, float) and 0 <= value <= 8640000000000000 else None

def project_event(event, run_id):
    if not isinstance(event, dict):
        raise r.SafeError('log_event_invalid')
    # Search text only in memory; publish neither payloads nor exception bodies.
    raw = json.dumps(event, sort_keys=True, ensure_ascii=True)
    signals = sorted(key for key, pattern in SIGNALS.items() if re.search(pattern, raw, re.I))
    worker = event.get('$workers', {})
    if not isinstance(worker, dict): worker = {}
    source = event.get('source', {})
    if isinstance(source, dict) and isinstance(source.get('$workers'), dict): worker = source['$workers']
    outcome = worker.get('outcome')
    return {'timestamp': safe_number(event.get('timestamp')), 'outcome': outcome if outcome in OUTCOMES else 'unreported',
        'cpu_ms': safe_number(worker.get('cpuTimeMs')), 'wall_ms': safe_number(worker.get('wallTimeMs')),
        'mentions_logical_run': run_id in raw, 'signals': signals,
        'event_sha256': hashlib.sha256(raw.encode()).hexdigest()}

def collect(client, inflight):
    results = []
    for run in [x for x in inflight if x['state'] == 'uncertain'][:2]:
        for service in (r.WORKER, SERVICES[run['target']]):
            item = {'run_id': run['id'], 'service': service}
            try:
                payload = request_payload(service, run)
                req = urllib.request.Request(r.API + f'/accounts/{client.account}/workers/observability/telemetry/query',
                    data=json.dumps(payload).encode(), headers={'Authorization': 'Bearer ' + client.token,
                    'Content-Type': 'application/json', 'User-Agent': 'ops-owner-evidence/1'})
                with r.OPENER.open(req, timeout=30) as response:
                    raw = response.read(2000001)
                if len(raw) > 2000000: raise r.SafeError('logs_too_large')
                body = r.decode(raw)
                if not isinstance(body, dict) or body.get('success') is False or body.get('errors'):
                    raise r.SafeError('logs_query_rejected')
                events = body.get('result', {}).get('events', {}).get('events')
                if not isinstance(events, list) or len(events) > 100: raise r.SafeError('logs_shape_invalid')
                item.update(state='observed', limited=len(events) == 100,
                    events=[project_event(event, run['id']) for event in events],
                    qualification='provider logs may be sampled; absence and outcome ok do not prove business completion')
            except Exception:
                item.update(state='unobserved', error='provider_logs_unavailable')
            results.append(item)
    return results


def main():
    import os
    from pathlib import Path
    import runtime_evidence as evidence
    try:
        path = Path(os.environ['RUNNER_TEMP']) / 'ops-owner-runtime.json'
        if path.stat().st_size > 262144: raise r.SafeError('evidence_too_large')
        saved = json.loads(path.read_text())
        runs = [evidence.project_run(row) for row in evidence.rows(saved['inflight'], 257)]
        client = r.Client(os.environ.get('CLOUDFLARE_API_TOKEN', ''))
        client.resolve_account()
        report = {'mode':'existing_log_observation', 'mutations':0, 'runs':collect(client, runs)}
    except Exception:
        report = {'mode':'existing_log_observation', 'mutations':0, 'state':'unobserved'}
    text = json.dumps(report, sort_keys=True, indent=2)
    print(text)
    (Path(os.environ['RUNNER_TEMP']) / 'ops-owner-logs.json').write_text(text)
    return int(report.get('state') == 'unobserved')

if __name__ == '__main__':
    raise SystemExit(main())
