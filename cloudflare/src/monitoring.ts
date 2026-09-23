import { Env, BookendEntry, SchedulerState, TargetState, InvocationResult, RunResult } from './types';

const STATE_KEY = 'scheduler:state';

export async function recordBookend(
  env: Env,
  targetName: string,
  phase: 'start' | 'end',
  status: 'running' | 'success' | 'failure' | 'timeout',
  rid: string,
  durationMs?: number
): Promise<void> {
  const ts = new Date().toISOString();
  const dateStr = ts.slice(0, 10);
  
  await env.SCHED_DB.prepare(
    `INSERT INTO bookends (id, date, target, phase, status, timestamp, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
  .bind(`${targetName}:${phase}:${rid}`, dateStr, targetName, phase, status, ts, durationMs ?? null)
  .run();
}

export async function recordAllBookends(
  env: Env,
  results: InvocationResult[]
): Promise<void> {
  const stmts = [];
  
  for (const { targetName, result } of results) {
    const tsStart = new Date().toISOString();
    const dateStr = tsStart.slice(0, 10);
    
    stmts.push(
      env.SCHED_DB.prepare(
        `INSERT INTO bookends (id, date, target, phase, status, timestamp, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(`${targetName}:start:${result.rid}`, dateStr, targetName, 'start', 'running', tsStart, null)
    );
    
    const endStatus = result.ok ? 'success' : 
                      result.error?.includes('TIMEOUT') ? 'timeout' : 'failure';
                      
    const tsEnd = new Date().toISOString();
    stmts.push(
      env.SCHED_DB.prepare(
        `INSERT INTO bookends (id, date, target, phase, status, timestamp, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(`${targetName}:end:${result.rid}`, dateStr, targetName, 'end', endStatus, tsEnd, result.durationMs ?? null)
    );
  }
  
  if (stmts.length > 0) {
    await env.SCHED_DB.batch(stmts);
  }
}

export async function loadSchedulerState(env: Env): Promise<SchedulerState> {
  const row = await env.SCHED_DB.prepare(`SELECT payload FROM scheduler_state WHERE id = ?`).bind(STATE_KEY).first<{payload: string}>();
  if (!row) {
    return { lastTick: 0, targetStates: {} };
  }
  try {
    return JSON.parse(row.payload) as SchedulerState;
  } catch {
    return { lastTick: 0, targetStates: {} };
  }
}

export async function saveSchedulerState(env: Env, state: SchedulerState): Promise<void> {
  await env.SCHED_DB.prepare(
    `INSERT INTO scheduler_state (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`
  ).bind(STATE_KEY, JSON.stringify(state)).run();
}

export function updateTargetState(
  state: SchedulerState,
  targetName: string,
  result: RunResult
): void {
  const now = Date.now();
  const targetState = state.targetStates[targetName] || {
    lastInvokedAt: 0,
    lastCompletedAt: 0,
    lastStatus: 'skipped',
    consecutiveFailures: 0,
  };
  
  targetState.lastInvokedAt = now;
  
  if (result.ok) {
    targetState.lastCompletedAt = now;
    targetState.lastStatus = 'success';
    targetState.consecutiveFailures = 0;
  } else {
    targetState.lastStatus = result.error?.includes('TIMEOUT') ? 'timeout' : 'failure';
    targetState.consecutiveFailures += 1;
  }
  
  state.targetStates[targetName] = targetState;
}

export function getTargetStates(env: Env): Promise<Record<string, TargetState>> {
  return loadSchedulerState(env).then(s => s.targetStates);
}
