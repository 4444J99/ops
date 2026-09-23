/**
 * ops-scheduler — shared Cloudflare scheduler types
 */

// Re-export Cloudflare types
export type { ScheduledEvent, ExecutionContext, D1Database, Fetcher } from '@cloudflare/workers-types';

export interface Env {
  SCHED_DB: D1Database;
  OP_SA_TOKEN: string;
  BOUNTYSCOPE: Fetcher;
  EDGARFLASH: Fetcher;
  TRENDPULSE: Fetcher;
  VULNPULSE: Fetcher;
  UCC_STAGING: Fetcher;
  UCC_PRODUCTION: Fetcher;
}

export interface Target {
  name: string;
  schedule: string;
  binding: keyof Env;
  entrypoint: string;
  active: boolean;
  migratedAt?: string;
}

export interface ScheduledPayload {
  scheduledTime: number;
  cron: string;
  target: string;
}

export interface RunResult {
  ok: boolean;
  rid: string;
  error?: string;
  durationMs?: number;
}

export interface BookendEntry {
  ts: string;
  job: string;
  phase: 'start' | 'end';
  status: 'running' | 'success' | 'failure' | 'timeout';
  rid: string;
  durationMs?: number;
}

export interface SchedulerState {
  lastTick: number;
  targetStates: Record<string, TargetState>;
}

export interface TargetState {
  lastInvokedAt: number;
  lastCompletedAt: number;
  lastStatus: 'success' | 'failure' | 'timeout' | 'skipped';
  consecutiveFailures: number;
}

export interface InvocationResult {
  targetName: string;
  result: RunResult;
  bindingName: string;
}
