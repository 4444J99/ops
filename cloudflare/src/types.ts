import type { Ownership } from './contracts';
export type { ScheduledEvent, ExecutionContext, D1Database, Fetcher } from '@cloudflare/workers-types';
export interface Env {
  [binding: string]: unknown;
  SCHED_DB: D1Database;
  OP_SA_TOKEN?: string;
  OPS_CONTROLLER_ENV?: 'production' | 'staging' | 'disabled';
  OPS_RELEASE_SHA?: string;
  OPS_ACTIVATE_AFTER?: string;
  BOUNTYSCOPE: Fetcher;
  EDGARFLASH: Fetcher;
  TRENDPULSE: Fetcher;
  VULNPULSE: Fetcher;
  UCC_STAGING: Fetcher;
  UCC_PRODUCTION: Fetcher;
}
export interface Target {
  name:string;
  schedule:string;
  binding: string;
  entrypoint:string;
  active:boolean;
  migratedAt?:string;
  ownership:Ownership;
  continuationSchedule?:string;
}
export interface ScheduledPayload {
  scheduledTime:number; cron:string; target:string; drainOnly?:boolean;
  runId?:string; attempt?:number; fencingToken?:number; contractVersion?:number;
}
export interface RunResult {
  ok:boolean; rid:string; error?:string; durationMs?:number;
  outcome?:'completed'|'failed'|'uncertain'|'accepted';
  completedItems?:number; pendingItems?:number;
}
export interface BookendEntry {
  ts:string; job:string; phase:'start'|'end'; status:'running'|'success'|'failure'|'timeout'; rid:string; durationMs?:number;
}
export interface SchedulerState {lastTick:number; targetStates:Record<string,TargetState>;}
export interface TargetState {lastInvokedAt:number;lastCompletedAt:number;lastStatus:'success'|'failure'|'timeout'|'skipped';consecutiveFailures:number;}
export interface InvocationResult {targetName:string;result:RunResult;bindingName:string;}
