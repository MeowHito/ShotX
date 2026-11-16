import { addBangkokDays, bangkokDaysBetween, type FinanceRange } from '@shotx/shared';

// Pure money arithmetic of ADR 0027 (the finance summary and per-user cost). All amounts are
// satang; fractions are kept until the final rounding of each reported number.

/** Days in the calendar month of `date` (`YYYY-MM-DD`). */
export function daysInMonth(date: string): number {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The platform's monthly running cost estimate (ADR 0019, as GET /admin/system's `cost`), in
 * satang per month, split into storage (R2 above the free GB) and server (the VPS bill).
 */
export interface MonthlyCostEstimate {
  storageSatangMonth: number;
  serverSatangMonth: number;
}

export function monthlyTotal(cost: MonthlyCostEstimate): number {
  return cost.storageSatangMonth + cost.serverSatangMonth;
}

/**
 * The estimated running cost of each bucket of `range`: every Bangkok day from `range.from` up
 * to `min(range.to, today)` accrues `monthlySatang / daysInMonth(day)` (a full calendar month
 * costs exactly one month's estimate), summed per bucket and rounded per bucket. Days after
 * today accrue nothing. Keys are the bucket keys (`YYYY-MM-DD` or `YYYY-MM`); buckets without a
 * day are absent (callers zero-fill).
 */
export function spreadEstimate(
  range: FinanceRange,
  today: string,
  monthlySatang: number,
): Map<string, number> {
  const exact = new Map<string, number>();
  if (monthlySatang <= 0) return exact;
  const last = range.to < today ? range.to : today;
  for (let day = range.from; day <= last; day = addBangkokDays(day, 1)) {
    const key = range.bucket === 'day' ? day : day.slice(0, 7);
    exact.set(key, (exact.get(key) ?? 0) + monthlySatang / daysInMonth(day));
  }
  return new Map([...exact].map(([key, value]) => [key, Math.round(value)]));
}

/** Σ 1/daysInMonth(day) over the Bangkok days `from`..`to` inclusive: months of accrual. */
export function accruedMonths(from: string, to: string): number {
  if (bangkokDaysBetween(from, to) < 0) return 0;
  let months = 0;
  for (let day = from; day <= to; day = addBangkokDays(day, 1)) months += 1 / daysInMonth(day);
  return months;
}

export interface UserCostInput {
  cost: MonthlyCostEstimate;
  /** storage_usage.used_bytes of the user, and Σ over every photographer. */
  userStorageBytes: number;
  totalStorageBytes: number;
  /** Σ daily_stats.bytes_out of the user, and Σ over every photographer. */
  userBytesServed: number;
  totalBytesServed: number;
  /** Bangkok days of the account's creation and of now. */
  createdOn: string;
  today: string;
}

/**
 * ADR 0027 §4: one photographer's estimated cost, an allocation and not a bill.
 *
 *   months  = Σ over each Bangkok day from the account's creation day to today (both included)
 *             of 1 / (days in that day's month)                     (accruedMonths)
 *   storage = round(storageSatangMonth × userStorageBytes / totalStorageBytes × months)
 *   server  = round(serverSatangMonth  × userBytesServed  / totalBytesServed  × months)
 *   total   = storage + server
 *
 * `storageSatangMonth` is R2 storage above the free GB at the current bucket size and
 * `serverSatangMonth` the VPS bill (ADR 0019 constants, USD_THB). A share whose platform total is
 * 0 (nothing stored, nothing served) is 0.
 */
export function allocateUserCost(input: UserCostInput): {
  storage: number;
  server: number;
  total: number;
} {
  const months = accruedMonths(input.createdOn, input.today);
  const share = (part: number, whole: number) => (whole > 0 ? Math.min(1, part / whole) : 0);
  const storage = Math.round(
    input.cost.storageSatangMonth * share(input.userStorageBytes, input.totalStorageBytes) * months,
  );
  const server = Math.round(
    input.cost.serverSatangMonth * share(input.userBytesServed, input.totalBytesServed) * months,
  );
  return { storage, server, total: storage + server };
}

/** `%`, `_` and `\` taken literally in a LIKE pattern (backslash is the default escape). */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
