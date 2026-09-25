/**
 * Simple, reliable cron matcher for Cloudflare scheduler.
 * Supports the subset of cron expressions we need:
 * - * * * * * (every minute)
 * - star / N * * * * (every N minutes)
 * - M H * * * (specific minute/hour)
 * - M H1,H2,... * * * (multiple hours)
 * - 0 H * * * (hourly at minute 0)
 */

interface ParsedCron {
  minutes: number[];    // 0-59
  hours: number[];      // 0-23
  dom: number[];        // 1-31 (day of month)
  months: number[];     // 1-12
  dow: number[];        // 0-7 (0 or 7 = Sunday)
}

/**
 * Parse a cron expression into allowed values for each field.
 */
export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: ${expression} (expected 5 fields)`);
  }
  
  const [minuteSpec, hourSpec, domSpec, monthSpec, dowSpec] = parts;
  if (domSpec !== '*' && dowSpec !== '*') throw new Error('combined_dom_dow_requires_explicit_contract');
  
  return {
    minutes: parseField(minuteSpec, 0, 59),
    hours: parseField(hourSpec, 0, 23),
    dom: parseField(domSpec, 1, 31),
    months: parseField(monthSpec, 1, 12),
    dow: parseField(dowSpec, 0, 7),
  };
}

/**
 * Parse a single cron field (minute, hour, etc.)
 * Supports: *, star/N, N, N-M, N,M,K
 */
function parseField(spec: string, min: number, max: number): number[] {
  if (spec === '*') return range(min, max);
  if (/^\*\/\d+$/.test(spec)) {
    const step = Number(spec.slice(2));
    if (!Number.isSafeInteger(step) || step <= 0 || step > max - min + 1) throw new Error('invalid_cron_step');
    return range(min,max).filter(v => (v-min)%step===0);
  }
  const values = new Set<number>();
  for (const part of spec.split(',')) {
    if (!/^\d+(?:-\d+)?$/.test(part)) throw new Error('invalid_cron_field');
    const [start, rawEnd] = part.split('-').map(Number);
    const end = rawEnd ?? start;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start<min || end>max || start>end) throw new Error('invalid_cron_range');
    for(let value=start;value<=end;value++)values.add(value);
  }
  if (!values.size) throw new Error('empty_cron_field');
  return [...values].sort((a,b)=>a-b);
}

function range(min: number, max: number): number[] {
  const arr: number[] = [];
  for (let i = min; i <= max; i++) arr.push(i);
  return arr;
}

/**
 * Check if a given timestamp matches the cron schedule.
 * scheduledTime is milliseconds since epoch (UTC).
 */
export function isDue(cron: ParsedCron, scheduledTime: number): boolean {
  const date = new Date(scheduledTime);
  
  // All times in UTC
  const minute = date.getUTCMinutes();
  const hour = date.getUTCHours();
  const dayOfMonth = date.getUTCDate();
  const month = date.getUTCMonth() + 1; // 1-12
  const dayOfWeek = date.getUTCDay(); // 0-6 (0 = Sunday)
  
  // Check each field
  if (!cron.minutes.includes(minute)) return false;
  if (!cron.hours.includes(hour)) return false;
  if (!cron.dom.includes(dayOfMonth)) return false;
  if (!cron.months.includes(month)) return false;
  // Handle both 0 and 7 for Sunday
  const dowMatch = cron.dow.includes(dayOfWeek) || (dayOfWeek === 0 && cron.dow.includes(7));
  if (!dowMatch) return false;
  
  return true;
}

/**
 * Pre-parse all schedules in the manifest for efficiency.
 */
export function compileSchedules(schedules: string[]): Map<string, ParsedCron> {
  const map = new Map<string, ParsedCron>();
  for (const schedule of schedules) {
    map.set(schedule, parseCron(schedule));
  }
  return map;
}
