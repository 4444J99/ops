/**
 * ops-scheduler — Cron Logic
 * 
 * Determines which targets are due at a given scheduledTime.
 * Uses custom cron matcher for reliable schedule matching.
 */

import { parseCron, isDue as cronIsDue } from './cron-matcher';
import { Target, ScheduledPayload } from './types';
import { getActiveTargets } from './manifest';

export interface DueTarget {
  target: Target;
  payload: ScheduledPayload;
}

// Cache parsed cron expressions
const cronCache = new Map<string, ReturnType<typeof parseCron>>();

function getParsedCron(schedule: string) {
  let parsed = cronCache.get(schedule);
  if (!parsed) {
    parsed = parseCron(schedule);
    cronCache.set(schedule, parsed);
  }
  return parsed;
}

/**
 * Check if a cron schedule matches the given scheduledTime.
 * scheduledTime is milliseconds since epoch (from ScheduledEvent.scheduledTime).
 */
export function isDue(schedule: string, scheduledTime: number): boolean {
  try {
    const parsed = getParsedCron(schedule);
    return cronIsDue(parsed, scheduledTime);
  } catch (err) {
    console.error(`[scheduler] Invalid cron expression: ${schedule}`, err);
    return false;
  }
}

/**
 * Get all active targets that are due at the given scheduledTime.
 */
export function getDueTargets(scheduledTime: number): DueTarget[] {
  const activeTargets = getActiveTargets();
  const due: DueTarget[] = [];
  
  for (const target of activeTargets) {
    if (isDue(target.schedule, scheduledTime)) {
      due.push({
        target,
        payload: {
          scheduledTime,
          cron: target.schedule,
          target: target.name,
        },
      });
    }
  }
  
  return due;
}

/**
 * Detect missed runs — targets that should have run but didn't.
 * Checks against lastInvokedAt in persisted state.
 */
export function detectMissedRuns(
  targetStates: Record<string, { lastInvokedAt: number }>,
  scheduledTime: number
): string[] {
  const activeTargets = getActiveTargets();
  const missed: string[] = [];
  const windowMs = 5 * 60 * 1000; // 5-minute detection window
  
  for (const target of activeTargets) {
    const state = targetStates[target.name];
    if (!state || state.lastInvokedAt === 0) continue;
    
    // Calculate when the previous run should have occurred
    const parsed = getParsedCron(target.schedule);
    const scheduledDate = new Date(scheduledTime);
    
    // Find the previous matching time by stepping backwards
    let checkDate = new Date(scheduledDate.getTime() - 60000); // 1 minute before
    let found = false;
    
    for (let i = 0; i < 100; i++) { // Max 100 minutes back
      if (cronIsDue(parsed, checkDate.getTime())) {
        found = true;
        break;
      }
      checkDate = new Date(checkDate.getTime() - 60000);
    }
    
    if (found) {
      const expectedMs = checkDate.getTime();
      if (expectedMs - state.lastInvokedAt > windowMs) {
        missed.push(target.name);
      }
    }
  }
  
  return missed;
}
export { getTargetByName } from "./manifest";
