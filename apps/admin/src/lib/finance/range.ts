import {
  addBangkokDays,
  bangkokDateSchema,
  bangkokDaysBetween,
  type FinanceBucket,
  financeMaxDays,
} from '@shotx/shared';

/** The finance page's range presets (ADR 0027 §5); `custom` is two picked dates. */
export const FINANCE_PRESETS = ['7d', '30d', '90d', 'month', 'year', 'custom'] as const;
export type FinancePreset = (typeof FINANCE_PRESETS)[number];

export interface FinanceSelection {
  preset: FinancePreset;
  from: string;
  to: string;
  bucket: FinanceBucket;
}

const DAYS: Partial<Record<FinancePreset, number>> = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * The Bangkok days a preset covers up to `today` (both inclusive). `custom` keeps today alone;
 * the page then shows the two date fields.
 */
export function presetRange(preset: FinancePreset, today: string): { from: string; to: string } {
  const days = DAYS[preset];
  if (days !== undefined) return { from: addBangkokDays(today, -(days - 1)), to: today };
  if (preset === 'month') return { from: `${today.slice(0, 7)}-01`, to: today };
  if (preset === 'year') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  return { from: today, to: today };
}

/** A year reads best by month; everything shorter by day. */
export function defaultBucket(preset: FinancePreset): FinanceBucket {
  return preset === 'year' ? 'month' : 'day';
}

export function selectPreset(preset: FinancePreset, today: string): FinanceSelection {
  return { preset, ...presetRange(preset, today), bucket: defaultBucket(preset) };
}

export type RangeProblem = 'invalid' | 'order' | 'too_long';

/**
 * Why a range can't be asked for (the same rules as financeQuerySchema), or null: both dates
 * real `YYYY-MM-DD`, `from` not after `to`, and at most financeMaxDays(bucket) days.
 */
export function rangeProblem(from: string, to: string, bucket: FinanceBucket): RangeProblem | null {
  if (!bangkokDateSchema.safeParse(from).success || !bangkokDateSchema.safeParse(to).success) {
    return 'invalid';
  }
  if (from > to) return 'order';
  if (bangkokDaysBetween(from, to) + 1 > financeMaxDays(bucket)) return 'too_long';
  return null;
}

/**
 * A bucket key (`YYYY-MM-DD` or `YYYY-MM`, a Bangkok calendar day or month) in the UI language:
 * `short` for axis labels (`16 พ.ย.`, `พ.ย. 69`), `long` for tooltips and tables
 * (`16 พ.ย. 2569`, `พฤศจิกายน 2569`). Formatted in UTC, since the key is already a calendar date.
 */
export function formatBucket(bucket: string, locale: string, style: 'short' | 'long'): string {
  const [y, m, d] = bucket.split('-').map(Number) as [number, number, number | undefined];
  const date = new Date(Date.UTC(y, m - 1, d ?? 1));
  const options: Intl.DateTimeFormatOptions =
    d === undefined
      ? style === 'short'
        ? { month: 'short', year: '2-digit' }
        : { month: 'long', year: 'numeric' }
      : style === 'short'
        ? { day: 'numeric', month: 'short' }
        : { dateStyle: 'medium' };
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
}
