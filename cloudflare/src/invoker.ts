/**
 * ops-scheduler — Service Binding Invoker
 * 
 * Invokes target Workers via private Service Bindings.
 * Awaits ACTUAL completion, not just ctx.waitUntil registration.
 */

import { Env, Target, ScheduledPayload, RunResult } from './types';

const INVOCATION_TIMEOUT_MS = 110 * 1000; // Leave 5s buffer before 60s Worker limit
const INTERNAL_PATH = '/internal/run-scheduled';

export interface InvocationResult {
  targetName: string;
  result: RunResult;
  bindingName: string;
}

/**
 * Invoke a single target via Service Binding.
 * Returns the actual RunResult from the target Worker.
 */
export async function invokeTarget(
  env: Env,
  target: Target,
  payload: ScheduledPayload
): Promise<InvocationResult> {
  const binding = env[target.binding] as Fetcher;
  const rid = crypto.randomUUID();
  const started = Date.now();
  
  console.log(`[invoker] invoking ${target.name}`, { rid, binding: target.binding });
  
  if (!binding) {
    const error = `Service Binding ${target.binding} not found`;
    console.error(`[invoker] ${error}`, { target: target.name });
    return {
      targetName: target.name,
      bindingName: target.binding,
      result: { ok: false, rid, error, durationMs: Date.now() - started },
    };
  }
  
  try {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), INVOCATION_TIMEOUT_MS);
    
    const response = await binding.fetch(
      `https://internal${INTERNAL_PATH}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Scheduler-RID': rid,
          'Authorization': `Bearer ${env.OP_SA_TOKEN}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }
    );
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const error = `HTTP ${response.status}: ${errorText}`;
      console.error(`[invoker] ${target.name} failed`, { rid, status: response.status, error });
      return {
        targetName: target.name,
        bindingName: target.binding,
        result: { ok: false, rid, error, durationMs: Date.now() - started },
      };
    }
    
    const result = await response.json() as RunResult;
    result.durationMs = Date.now() - started;
    
    console.log(`[invoker] ${target.name} completed`, { 
      rid, 
      ok: result.ok, 
      durationMs: result.durationMs 
    });
    
    return {
      targetName: target.name,
      bindingName: target.binding,
      result,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const isTimeout = error.includes('Aborted') || error.includes('timeout');
    
    console.error(`[invoker] ${target.name} error`, { 
      rid, 
      error, 
      isTimeout,
      durationMs: Date.now() - started 
    });
    
    return {
      targetName: target.name,
      bindingName: target.binding,
      result: { 
        ok: false, 
        rid, 
        error: isTimeout ? `TIMEOUT after ${INVOCATION_TIMEOUT_MS}ms` : error,
        durationMs: Date.now() - started,
      },
    };
  }
}

/**
 * Invoke all due targets concurrently.
 * One target's failure does NOT block others.
 * Returns results for all targets.
 */
export async function invokeAllTargets(
  env: Env,
  dueTargets: { target: Target; payload: ScheduledPayload }[]
): Promise<InvocationResult[]> {
  const invocations = dueTargets.map(({ target, payload }) => 
    invokeTarget(env, target, payload)
  );
  
  // Use Promise.allSettled to ensure all run regardless of individual failures
  const settled = await Promise.allSettled(invocations);
  
  return settled.map((result, index) => {
    if (result.status === 'fulfilled') {
      return result.value;
    } else {
      const target = dueTargets[index].target;
      return {
        targetName: target.name,
        bindingName: target.binding,
        result: { 
          ok: false, 
          rid: crypto.randomUUID(), 
          error: `Invocation promise rejected: ${result.reason}`,
          durationMs: 0,
        },
      };
    }
  });
}
