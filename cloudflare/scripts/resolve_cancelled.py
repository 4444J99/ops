"""One explicit cancelled-poll reconciliation. Never reports business completion."""
from __future__ import annotations
import datetime as dt
import json
import os
from pathlib import Path
import time
import release as r

RUN_ID = 'edgarflash:production:1790332980000:scheduled'
SOURCE_SHA = '6886db7a7f6d4f84aff0375847fdb200155bcb90'
BUNDLE_SHA = '3e01009a298a23ff91431bf8615f0e2b06df0388ed63bb91f2b3781bf6b7451b'
DATABASE_ID = 'f1ce9d34-bd31-4573-b752-332bc6313efd'
READ = 'SELECT * FROM ops_runs WHERE id=?'
ACK = "SELECT payload FROM cf_kv_recovery WHERE product='edgarflash' AND key='last_job'"
CODE = 'provider_cancelled_effects_unknown'
RESOLVE = """UPDATE ops_runs SET state='failed',finished_at=?,error_code=?
 WHERE id=? AND state='uncertain' AND owner=? AND generation=? AND source_sha=?
 AND started_at=? AND lease_until=? AND error_code='lease_expired'
 AND EXISTS(SELECT 1 FROM ops_targets WHERE target=ops_runs.target
   AND generation=ops_runs.generation AND last_run_id=ops_runs.id)
 AND EXISTS(SELECT 1 FROM ops_control WHERE id='dispatcher' AND enabled=1 AND source_sha=?)
 RETURNING id,state,generation,error_code"""


def validate_run(run, now):
    if (run.get('id') != RUN_ID or run.get('target') != 'edgarflash'
        or run.get('environment') != 'production' or run.get('mode') != 'scheduled'
        or run.get('source_sha') != SOURCE_SHA or run.get('generation') != 440
        or run.get('attempt') != 1 or run.get('state') != 'uncertain'
        or run.get('error_code') != 'lease_expired'
        or not isinstance(run.get('owner'), str)):
        raise r.SafeError('cancelled_run_identity_drift')
    if any(type(run.get(k)) is not int for k in ('started_at','lease_until','scheduled_at')):
        raise r.SafeError('cancelled_run_time_invalid')
    if not run['scheduled_at'] <= run['started_at'] < run['lease_until'] <= now - 900000:
        raise r.SafeError('cancelled_run_not_quiescent')


def cancellation_proof(observations, run):
    matches = []
    for item in observations:
        if (item.get('service') != 'edgarflash' or item.get('run_id') != run['id']
            or item.get('state') != 'observed' or item.get('limited') is not False):
            continue
        for event in item.get('events', []):
            timestamp = event.get('timestamp')
            digest = event.get('event_sha256')
            if (event.get('outcome') == 'canceled' and event.get('mentions_logical_run') is True
                and type(timestamp) in (int,float) and run['started_at'] <= timestamp <= run['lease_until']
                and isinstance(digest,str) and r.re.fullmatch('[a-f0-9]{64}',digest)):
                matches.append(digest)
    if not matches:
        raise r.SafeError('correlated_provider_cancellation_missing')
    return sorted(set(matches))


def reject_matching_ack(rows, run):
    for row in rows:
        raw = row.get('payload')
        if not isinstance(raw,str) or len(raw)>4096:
            raise r.SafeError('cancelled_ack_invalid')
        try: ack=json.loads(raw)
        except Exception: raise r.SafeError('cancelled_ack_invalid') from None
        if not isinstance(ack,dict): raise r.SafeError('cancelled_ack_invalid')
        if ack.get('scheduled_at') == run['scheduled_at'] or ack.get('run_id') == run['id']:
            raise r.SafeError('matching_completion_requires_separate_reconciliation')


def apply_resolution(client, run, now):
    validate_run(run,now)
    updated=client.sql(RESOLVE,(now,CODE,run['id'],run['owner'],run['generation'],run['source_sha'],
        run['started_at'],run['lease_until'],SOURCE_SHA))
    if len(updated)!=1:
        raise r.SafeError('cancelled_compare_and_swap_lost')
    if updated[0].get('state')!='failed' or updated[0].get('error_code')!=CODE:
        raise r.SafeError('cancelled_resolution_readback_invalid')
    return updated[0]


def run(client):
    import uncertain_logs
    client.resolve_account()
    settings=client.settings(r.WORKER)
    databases=[b for b in settings['bindings'] if b.get('name')=='SCHED_DB' and b.get('type')=='d1']
    if len(databases)!=1 or databases[0].get('database_id')!=DATABASE_ID:
        raise r.SafeError('cancelled_database_identity_drift')
    client.db=DATABASE_ID
    if client.crons(r.WORKER)!=['* * * * *'] or any(client.crons(n) for n in r.DORMANT):
        raise r.SafeError('cancelled_clock_drift')
    if r.digest(client.source()['index.js'])!=BUNDLE_SHA:
        raise r.SafeError('cancelled_live_source_drift')
    control=client.sql(r.CONTROL)
    if len(control)!=1 or control[0].get('source_sha')!=SOURCE_SHA or control[0].get('enabled')!=1:
        raise r.SafeError('cancelled_control_drift')
    rows=client.sql(READ,(RUN_ID,))
    if len(rows)!=1: raise r.SafeError('cancelled_run_missing')
    old=rows[0]
    if old.get('state')=='failed' and old.get('error_code')==CODE:
        return {'state':'ALREADY_RESOLVED','run_id':RUN_ID,'mutations':0,'business_effects':'unverified'}
    now=int(time.time()*1000)
    validate_run(old,now)
    proof=cancellation_proof(uncertain_logs.collect(client,[old]),old)
    reject_matching_ack(client.sql(ACK),old)
    # Provider cancellation proves the execution ended, not that its business
    # effects completed. Do not replay this slot or write a success timestamp.
    result=apply_resolution(client,old,int(time.time()*1000))
    return {'state':'CANCELLED_EXECUTION_RECONCILED','run_id':RUN_ID,'generation':result['generation'],
        'before_state':'uncertain','before_error':'lease_expired','after_state':'failed',
        'error_code':CODE,'business_effects':'unverified','replayed':False,
        'next_action':'existing scheduler may execute later queued polls',
        'provider_event_sha256':proof,'mutations':1,'product_data_writes':0,
        'observed_at':dt.datetime.now(dt.timezone.utc).isoformat()}


def main():
    try:
        source=r.source_identity()
        if os.environ.get('OPS_RESOLVE_RUN')!=RUN_ID:
            raise r.SafeError('cancelled_resolution_not_authorized')
        report=run(r.Client(os.environ.get('CLOUDFLARE_API_TOKEN','')))
        report['resolution_source_sha']=source
    except r.SafeError as error: report={'state':'NOT_RESOLVED','error':str(error)}
    except Exception: report={'state':'NOT_RESOLVED','error':'cancelled_resolution_failed'}
    text=json.dumps(report,sort_keys=True,indent=2)
    print(text)
    if os.environ.get('RUNNER_TEMP'):
        (Path(os.environ['RUNNER_TEMP'])/'ops-owner-resolution.json').write_text(text)
    return int('error' in report)

if __name__=='__main__':raise SystemExit(main())
