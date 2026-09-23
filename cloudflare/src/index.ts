/**
 * ops-scheduler — Central Cloudflare Cron Scheduler
 * 
 * Consolidates 6 product cron schedules into a single * * * * * trigger.
 * Preserves each product's exact UTC schedule via declarative manifest.
 * Uses private Service Bindings to invoke target Workers.
 * Records bookends for ops-witness reconciliation.
 */

import type { ScheduledEvent, ExecutionContext } from '@cloudflare/workers-types';
import { Env } from './types';
import { getDueTargets } from './scheduler';
import { invokeAllTargets } from './invoker';
import { recordAllBookends, loadSchedulerState, saveSchedulerState, updateTargetState } from './monitoring';

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduledTime = event.scheduledTime;
    const cron = event.cron;
    const rid = crypto.randomUUID();
    
    console.log(`[scheduler] tick`, { rid, cron, scheduledTime, scheduledISO: new Date(scheduledTime).toISOString() });
    
    // Load state for missed-run detection
    const state = await loadSchedulerState(env);
    state.lastTick = scheduledTime;
    
    // Determine which targets are due
    const dueTargets = getDueTargets(scheduledTime);
    
    if (dueTargets.length === 0) {
      console.log(`[scheduler] no active targets due at this time`);
      await saveSchedulerState(env, state);
      return;
    }
    
    console.log(`[scheduler] ${dueTargets.length} target(s) due`, { 
      rid, 
      targets: dueTargets.map(d => d.target.name) 
    });
    
    // Invoke all due targets concurrently
    const results = await invokeAllTargets(env, dueTargets);
    
    // Record bookends for ops-witness
    await recordAllBookends(env, results);
    
    // Update scheduler state
    for (const { targetName, result } of results) {
      updateTargetState(state, targetName, result);
    }
    
    await saveSchedulerState(env, state);
    
    // Log summary
    const success = results.filter(r => r.result.ok).length;
    const failed = results.filter(r => !r.result.ok).length;
    console.log(`[scheduler] tick complete`, { rid, success, failed, total: results.length });
    
    // Failures are visible but don't throw — one target's failure must not block others
    if (failed > 0) {
      console.warn(`[scheduler] ${failed} target(s) failed`, { 
        rid, 
        failures: results.filter(r => !r.result.ok).map(r => ({ 
          target: r.targetName, 
          error: r.result.error 
        })) 
      });
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    
    // Health check
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    
    // Status endpoint — shows scheduler state and target statuses
    if (url.pathname === '/status') {
      const state = await loadSchedulerState(env);
      const { getActiveTargets } = await import('./manifest');
      const activeTargets = getActiveTargets();
      
      return Response.json({
        scheduler: 'ops-scheduler',
        lastTick: state.lastTick ? new Date(state.lastTick).toISOString() : null,
        activeTargets: activeTargets.map(t => ({
          name: t.name,
          schedule: t.schedule,
          binding: t.binding,
          state: state.targetStates[t.name] || null,
        })),
      });
    }
    
    // Bookend retrieval for ops-witness
    if (url.pathname === '/bookends') {
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      
      const { results } = await env.SCHED_DB.prepare(
        `SELECT target, phase, status, timestamp FROM bookends WHERE date = ? ORDER BY timestamp ASC LIMIT 1000`
      ).bind(date).all<{target: string, phase: string, status: string, timestamp: string}>();
      
      const bookends: string[] = [];
      if (results) {
        for (const row of results) {
          bookends.push(`${row.timestamp}\t${row.target}\t-\t-\t${row.phase}\t${row.status}\n`);
        }
      }
      
      return Response.json({
        date,
        count: bookends.length,
        bookends: bookends,
      });
    }
    
    return new Response('Not Found', { status: 404 });
  },
};
