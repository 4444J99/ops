import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isDue, getDueTargets, detectMissedRuns } from '../src/scheduler';
import { setTargetActive, getActiveTargets, SCHEDULE_MANIFEST } from '../src/manifest';

// Mock scheduledTime for testing
const TEST_TIME = new Date('2026-09-17T12:00:00.000Z').getTime(); // 12:00 UTC

describe('scheduler', () => {
  beforeEach(() => {
    // Reset all targets to inactive
    for (const target of SCHEDULE_MANIFEST) {
      target.active = false;
      target.migratedAt = undefined;
    }
  });

  describe('isDue', () => {
    it('matches bountyscope */30 schedule at :00 and :30', () => {
      // 12:00 UTC
      expect(isDue('*/30 * * * *', new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      // 12:30 UTC
      expect(isDue('*/30 * * * *', new Date('2026-09-17T12:30:00.000Z').getTime())).toBe(true);
      // 12:15 UTC - not due
      expect(isDue('*/30 * * * *', new Date('2026-09-17T12:15:00.000Z').getTime())).toBe(false);
    });

    it('matches edgarflash * * * * * every minute', () => {
      expect(isDue('* * * * *', new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      expect(isDue('* * * * *', new Date('2026-09-17T12:01:00.000Z').getTime())).toBe(true);
      expect(isDue('* * * * *', new Date('2026-09-17T12:59:00.000Z').getTime())).toBe(true);
    });

    it('matches trendpulse 0 1,5,9,13,17,21 * * *', () => {
      // 01:00 UTC
      expect(isDue('0 1,5,9,13,17,21 * * *', new Date('2026-09-17T01:00:00.000Z').getTime())).toBe(true);
      // 05:00 UTC
      expect(isDue('0 1,5,9,13,17,21 * * *', new Date('2026-09-17T05:00:00.000Z').getTime())).toBe(true);
      // 13:00 UTC
      expect(isDue('0 1,5,9,13,17,21 * * *', new Date('2026-09-17T13:00:00.000Z').getTime())).toBe(true);
      // 12:00 UTC - not in schedule
      expect(isDue('0 1,5,9,13,17,21 * * *', new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(false);
    });

    it('matches vulnpulse 0 12 * * * daily at 12:00', () => {
      expect(isDue('0 12 * * *', new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      expect(isDue('0 12 * * *', new Date('2026-09-17T11:59:00.000Z').getTime())).toBe(false);
      expect(isDue('0 12 * * *', new Date('2026-09-17T12:01:00.000Z').getTime())).toBe(false);
    });

    it('matches UCC 0 0,2,6,12,18 * * * every 6 hours', () => {
      expect(isDue('0 0,2,6,12,18 * * *', new Date('2026-09-17T00:00:00.000Z').getTime())).toBe(true);
      expect(isDue('0 0,2,6,12,18 * * *', new Date('2026-09-17T02:00:00.000Z').getTime())).toBe(true);
      expect(isDue('0 0,2,6,12,18 * * *', new Date('2026-09-17T06:00:00.000Z').getTime())).toBe(true);
      expect(isDue('0 0,2,6,12,18 * * *', new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      expect(isDue('0 0,2,6,12,18 * * *', new Date('2026-09-17T18:00:00.000Z').getTime())).toBe(true);
      expect(isDue('0 0,2,6,12,18 * * *', new Date('2026-09-17T01:00:00.000Z').getTime())).toBe(false);
    });
  });

  describe('getDueTargets', () => {
    it('returns only active targets that are due', () => {
      setTargetActive('bountyscope', true);
      setTargetActive('edgarflash', true);
      setTargetActive('vulnpulse', true);
      
      // At 12:00 UTC, bountyscope (every 30min) and vulnpulse (daily 12:00) are due
      // edgarflash (every minute) is also due
      const due = getDueTargets(new Date('2026-09-17T12:00:00.000Z').getTime());
      
      expect(due.length).toBe(3);
      const names = due.map(d => d.target.name).sort();
      expect(names).toEqual(['bountyscope', 'edgarflash', 'vulnpulse']);
    });

    it('returns empty array when no targets active', () => {
      const due = getDueTargets(TEST_TIME);
      expect(due.length).toBe(0);
    });

    it('respects inactive targets', () => {
      setTargetActive('bountyscope', false);
      const due = getDueTargets(TEST_TIME);
      expect(due.length).toBe(0);
    });
  });

  describe('manifest', () => {
    it('has all 6 targets defined', () => {
      expect(SCHEDULE_MANIFEST.length).toBe(6);
      const names = SCHEDULE_MANIFEST.map(t => t.name).sort();
      expect(names).toEqual([
        'bountyscope',
        'edgarflash',
        'trendpulse',
        'ucc-production',
        'ucc-staging',
        'vulnpulse',
      ]);
    });

    it('preserves exact baseline schedules', () => {
      const bountyscope = SCHEDULE_MANIFEST.find(t => t.name === 'bountyscope');
      expect(bountyscope?.schedule).toBe('*/30 * * * *');
      
      const edgarflash = SCHEDULE_MANIFEST.find(t => t.name === 'edgarflash');
      expect(edgarflash?.schedule).toBe('* * * * *');
      
      const trendpulse = SCHEDULE_MANIFEST.find(t => t.name === 'trendpulse');
      expect(trendpulse?.schedule).toBe('0 1,5,9,13,17,21 * * *');
      
      const vulnpulse = SCHEDULE_MANIFEST.find(t => t.name === 'vulnpulse');
      expect(vulnpulse?.schedule).toBe('0 12 * * *');
      
      const uccStaging = SCHEDULE_MANIFEST.find(t => t.name === 'ucc-staging');
      expect(uccStaging?.schedule).toBe('0 0,2,6,12,18 * * *');
      
      const uccProd = SCHEDULE_MANIFEST.find(t => t.name === 'ucc-production');
      expect(uccProd?.schedule).toBe('0 0,2,6,12,18 * * *');
    });
  });
});
