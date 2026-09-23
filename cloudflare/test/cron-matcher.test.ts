import { describe, it, expect } from 'vitest';
import { parseCron, isDue, compileSchedules } from '../src/cron-matcher';

describe('cron-matcher', () => {
  describe('parseCron', () => {
    it('parses every minute', () => {
      const cron = parseCron('* * * * *');
      expect(cron.minutes).toEqual(Array.from({ length: 60 }, (_, i) => i));
      expect(cron.hours).toEqual(Array.from({ length: 24 }, (_, i) => i));
    });

    it('parses every 30 minutes', () => {
      const cron = parseCron('*/30 * * * *');
      expect(cron.minutes).toEqual([0, 30]);
      expect(cron.hours).toEqual(Array.from({ length: 24 }, (_, i) => i));
    });

    it('parses specific hour schedule', () => {
      const cron = parseCron('0 12 * * *');
      expect(cron.minutes).toEqual([0]);
      expect(cron.hours).toEqual([12]);
    });

    it('parses multiple hours', () => {
      const cron = parseCron('0 1,5,9,13,17,21 * * *');
      expect(cron.minutes).toEqual([0]);
      expect(cron.hours).toEqual([1, 5, 9, 13, 17, 21]);
    });

    it('parses UCC every 6 hours', () => {
      const cron = parseCron('0 0,2,6,12,18 * * *');
      expect(cron.minutes).toEqual([0]);
      expect(cron.hours).toEqual([0, 2, 6, 12, 18]);
    });

    it('parses ranges', () => {
      const cron = parseCron('0 9-17 * * 1-5');
      expect(cron.hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
      expect(cron.dow).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('isDue', () => {
    const cron30 = parseCron('*/30 * * * *');
    const cronMin = parseCron('* * * * *');
    const cronDaily12 = parseCron('0 12 * * *');
    const cronTrend = parseCron('0 1,5,9,13,17,21 * * *');
    const cronUCC = parseCron('0 0,2,6,12,18 * * *');

    it('matches */30 at :00 and :30', () => {
      expect(isDue(cron30, new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cron30, new Date('2026-09-17T12:30:00.000Z').getTime())).toBe(true);
      expect(isDue(cron30, new Date('2026-09-17T12:15:00.000Z').getTime())).toBe(false);
      expect(isDue(cron30, new Date('2026-09-17T12:45:00.000Z').getTime())).toBe(false);
    });

    it('matches * * * * * every minute', () => {
      expect(isDue(cronMin, new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronMin, new Date('2026-09-17T12:01:00.000Z').getTime())).toBe(true);
      expect(isDue(cronMin, new Date('2026-09-17T12:59:00.000Z').getTime())).toBe(true);
    });

    it('matches 0 12 * * * daily at 12:00', () => {
      expect(isDue(cronDaily12, new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronDaily12, new Date('2026-09-17T11:59:00.000Z').getTime())).toBe(false);
      expect(isDue(cronDaily12, new Date('2026-09-17T12:01:00.000Z').getTime())).toBe(false);
    });

    it('matches 0 1,5,9,13,17,21 * * * trendpulse hours', () => {
      expect(isDue(cronTrend, new Date('2026-09-17T01:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronTrend, new Date('2026-09-17T05:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronTrend, new Date('2026-09-17T09:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronTrend, new Date('2026-09-17T13:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronTrend, new Date('2026-09-17T17:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronTrend, new Date('2026-09-17T21:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronTrend, new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(false);
      expect(isDue(cronTrend, new Date('2026-09-17T02:00:00.000Z').getTime())).toBe(false);
    });

    it('matches 0 0,2,6,12,18 * * * UCC hours', () => {
      expect(isDue(cronUCC, new Date('2026-09-17T00:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronUCC, new Date('2026-09-17T02:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronUCC, new Date('2026-09-17T06:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronUCC, new Date('2026-09-17T12:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronUCC, new Date('2026-09-17T18:00:00.000Z').getTime())).toBe(true);
      expect(isDue(cronUCC, new Date('2026-09-17T01:00:00.000Z').getTime())).toBe(false);
      expect(isDue(cronUCC, new Date('2026-09-17T04:00:00.000Z').getTime())).toBe(false);
    });
  });

  describe('compileSchedules', () => {
    it('compiles multiple schedules', () => {
      const schedules = ['* * * * *', '*/30 * * * *', '0 12 * * *'];
      const map = compileSchedules(schedules);
      expect(map.size).toBe(3);
      expect(map.has('* * * * *')).toBe(true);
      expect(map.has('*/30 * * * *')).toBe(true);
      expect(map.has('0 12 * * *')).toBe(true);
    });
  });
});
