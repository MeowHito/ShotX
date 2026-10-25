/**
 * Billing periods run in the operator's time zone, Asia/Bangkok (UTC+7, no daylight saving).
 * Timestamps are stored as `timestamptz`; month arithmetic happens on Bangkok wall-clock dates.
 */

export const BILLING_TIME_ZONE = 'Asia/Bangkok';

/** Bangkok is UTC+7 all year (no DST since 1920), so a fixed offset is exact. */
export const BANGKOK_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

export const MS_PER_BILLING_DAY = 24 * 60 * 60 * 1000;

function assertDate(label: string, value: Date): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new RangeError(`${label} must be a valid Date`);
  }
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `date` plus `months` calendar months on the Bangkok wall clock, keeping the time of day, with
 * month-end clamping: Jan 31 + 1 month is Feb 28 (29 in leap years), Mar 31 + 1 is Apr 30. Adding
 * to `period_end` repeatedly can drift after a clamp (Jan 31 → Feb 28 → Mar 28); that is
 * accepted, because each renewal appends to the stored `period_end`.
 */
export function addMonthsBangkok(date: Date, months: number): Date {
  assertDate('date', date);
  if (!Number.isInteger(months) || months < 0 || months > 1200) {
    throw new RangeError(`months must be an integer from 0 to 1200, got ${months}`);
  }
  const wall = new Date(date.getTime() + BANGKOK_UTC_OFFSET_MS);
  const total = wall.getUTCFullYear() * 12 + wall.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month = total % 12;
  const day = Math.min(wall.getUTCDate(), daysInMonth(year, month));
  const result = Date.UTC(
    year,
    month,
    day,
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
    wall.getUTCMilliseconds(),
  );
  return new Date(result - BANGKOK_UTC_OFFSET_MS);
}

/** `date` plus whole days (exact 24 h steps: Bangkok has no DST). Negative days go back. */
export function addDays(date: Date, days: number): Date {
  assertDate('date', date);
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer, got ${days}`);
  return new Date(date.getTime() + days * MS_PER_BILLING_DAY);
}

/** The Bangkok calendar date of an instant, `YYYY-MM-DD`. */
export function bangkokDate(date: Date): string {
  assertDate('date', date);
  return new Date(date.getTime() + BANGKOK_UTC_OFFSET_MS).toISOString().slice(0, 10);
}
