/**
 * ops-scheduler — Declarative Schedule Manifest
 * 
 * Single source of truth for all six targets' schedules.
 * Preserves exact UTC schedules from baseline (observed 2026-09-17).
 */

import type { Target } from './types';

export const SCHEDULE_MANIFEST: Target[] = [
  {
    name: 'bountyscope',
    ownership: { repositoryId:1228974136, repository:'organvm-iii-ergon/bountyscope', environment:'production',
      accountRef:'primary-cloudflare', service:'bountyscope', capability:'default',
      authorization:'legacy-default', contractVersion:1,
      maxDurationMs:110000, maxInvocationsPerDay:48, freshnessMs:7200000,
      resourceBudget:{state:'unmeasured',issue:'https://github.com/4444J99/ops/issues/6'} },
    schedule: '*/30 * * * *',
    binding: 'BOUNTYSCOPE',
    entrypoint: 'runScheduled',
    active: true,
    migratedAt: '2026-09-17T15:00:00.000Z',
  },
  {
    name: 'edgarflash',
    ownership: { repositoryId:1228965461, repository:'organvm-iii-ergon/edgarflash', environment:'production',
      accountRef:'primary-cloudflare', service:'edgarflash', capability:'default',
      authorization:'legacy-default', contractVersion:1,
      maxDurationMs:110000, maxInvocationsPerDay:1440, freshnessMs:600000,
      resourceBudget:{state:'unmeasured',issue:'https://github.com/4444J99/ops/issues/6'} },
    schedule: '* * * * *',
    binding: 'EDGARFLASH',
    entrypoint: 'runScheduled',
    active: true,
    migratedAt: '2026-09-17T16:00:00.000Z',
  },
  {
    name: 'trendpulse',
    ownership: { repositoryId:1228979753, repository:'organvm-iii-ergon/trendpulse', environment:'production',
      accountRef:'primary-cloudflare', service:'trendpulse', capability:'default',
      authorization:'legacy-default', contractVersion:1,
      maxDurationMs:110000, maxInvocationsPerDay:6, freshnessMs:28800000,
      resourceBudget:{state:'unmeasured',issue:'https://github.com/4444J99/ops/issues/6'} },
    schedule: '0 1,5,9,13,17,21 * * *',
    binding: 'TRENDPULSE',
    entrypoint: 'runScheduled',
    active: true,
    migratedAt: '2026-09-17T16:10:00.000Z',
  },
  {
    name: 'vulnpulse',
    ownership: { repositoryId:1229016238, repository:'organvm-iii-ergon/vulnpulse', environment:'production',
      accountRef:'primary-cloudflare', service:'vulnpulse', capability:'default',
      authorization:'legacy-default', contractVersion:1,
      maxDurationMs:110000, maxInvocationsPerDay:1, freshnessMs:172800000,
      resourceBudget:{state:'unmeasured',issue:'https://github.com/4444J99/ops/issues/6'} },
    schedule: '0 12 * * *',
    binding: 'VULNPULSE',
    entrypoint: 'runScheduled',
    active: true,
  },
  {
    name: 'ucc-staging',
    ownership: { repositoryId:1380697675, repository:'4444J99/prds-ops', environment:'staging',
      accountRef:'primary-cloudflare', service:'ucc-mca-edge-staging', capability:'KvIncidentScheduledIngress',
      authorization:'named-entrypoint', contractVersion:1,
      maxDurationMs:300000, maxInvocationsPerDay:144, freshnessMs:43200000,
      resourceBudget:{state:'unmeasured',issue:'https://github.com/4444J99/ops/issues/6'} },
    continuationSchedule: '*/10 * * * *',
    schedule: '0 0,2,6,12,18 * * *',
    binding: 'UCC_STAGING',
    entrypoint: 'runScheduled',
    active: true,
  },
  {
    name: 'ucc-production',
    ownership: { repositoryId:1380697675, repository:'4444J99/prds-ops', environment:'production',
      accountRef:'primary-cloudflare', service:'ucc-mca-edge-production', capability:'default',
      authorization:'legacy-default', contractVersion:1,
      maxDurationMs:110000, maxInvocationsPerDay:5, freshnessMs:43200000,
      resourceBudget:{state:'unmeasured',issue:'https://github.com/4444J99/ops/issues/6'} },
    schedule: '0 0,2,6,12,18 * * *',
    binding: 'UCC_PRODUCTION',
    entrypoint: 'runScheduled',
    active: true,
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
