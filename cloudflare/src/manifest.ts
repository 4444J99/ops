/**
 * ops-scheduler — Declarative Schedule Manifest
 * 
 * Single source of truth for all six targets' schedules.
 * Preserves exact UTC schedules from baseline (observed 2026-09-17).
 */

import { Target } from './types';

export const SCHEDULE_MANIFEST: Target[] = [
  {
    name: 'bountyscope',
    schedule: '*/30 * * * *',           // Every 30 minutes
    binding: 'BOUNTYSCOPE',
    entrypoint: 'runScheduled',
    active: true,
    migratedAt: '2026-09-17T15:00:00.000Z',
  },
  {
    name: 'edgarflash',
    schedule: '* * * * *',              // Every minute
    binding: 'EDGARFLASH',
    entrypoint: 'runScheduled',
    active: true,
    migratedAt: '2026-09-17T16:00:00.000Z',
  },
  {
    name: 'trendpulse',
    schedule: '0 1,5,9,13,17,21 * * *', // Every 4 hours at :00 (1,5,9,13,17,21 UTC)
    binding: 'TRENDPULSE',
    entrypoint: 'runScheduled',
    active: true,
    migratedAt: '2026-09-17T16:10:00.000Z',
  },
  {
    name: 'vulnpulse',
    schedule: '0 12 * * *',             // Daily at 12:00 UTC
    binding: 'VULNPULSE',
    entrypoint: 'runScheduled',
    active: true,  // MIGRATED
  },
  {
    name: 'ucc-staging',
    schedule: '0 0,2,6,12,18 * * *',    // Every 6 hours (0,2,6,12,18 UTC)
    binding: 'UCC_STAGING',
    entrypoint: 'runScheduled',
    active: true,  // MIGRATED
  },
  {
    name: 'ucc-production',
    schedule: '0 0,2,6,12,18 * * *',    // Same as staging — was blocked by 5-cron limit
    binding: 'UCC_PRODUCTION',
    entrypoint: 'runScheduled',
    active: true,  // MIGRATED
  },
];

export function getActiveTargets(): Target[] {
  return SCHEDULE_MANIFEST.filter(t => t.active);
}

export function getTargetByName(name: string): Target | undefined {
  return SCHEDULE_MANIFEST.find(t => t.name === name);
}

export function setTargetActive(name: string, active: boolean): boolean {
  const target = SCHEDULE_MANIFEST.find(t => t.name === name);
  if (!target) return false;
  target.active = active;
  if (active && !target.migratedAt) {
    target.migratedAt = new Date().toISOString();
  }
  return true;
}
