/** Dates and times are shown in Thailand's time zone wherever the admin is. */
export const TIME_ZONE = 'Asia/Bangkok';

const BYTES_PER_GB = 1024 ** 3;

/**
 * Storage used, always in GB (1024³ bytes, labelled GB as in the studio) so the users table's
 * column compares at a glance: `0 GB`, `0.01 GB`, `12.5 GB`, `1,024 GB`.
 */
export function formatGigabytes(bytes: number, locale = 'th-TH'): string {
  const gb = Math.max(0, bytes) / BYTES_PER_GB;
  const digits = gb === 0 ? 0 : gb < 10 ? 2 : gb < 100 ? 1 : 0;
  const shown =
    gb > 0 && gb < 0.01
      ? `< ${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(0.01)}`
      : new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(gb);
  return `${shown} GB`;
}

/** An ISO timestamp as a Thai date and time in Asia/Bangkok, e.g. `10 พ.ย. 2569 14:05`. */
export function formatDateTime(iso: string, locale = 'th-TH'): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: TIME_ZONE,
  }).format(new Date(iso));
}

/** An ISO timestamp as a Thai date in Asia/Bangkok, e.g. `10 พ.ย. 2569`. */
export function formatDate(iso: string, locale = 'th-TH'): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: TIME_ZONE }).format(
    new Date(iso),
  );
}

/** Today's date in Asia/Bangkok as `YYYY-MM-DD` (the value of an `<input type="date">`). */
export function todayInBangkok(now: Date = new Date()): string {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: TIME_ZONE,
  }).format(now);
}

/**
 * A calendar date picked in the form (`YYYY-MM-DD`, Thailand) as the ISO timestamp the API
 * stores: midnight in Asia/Bangkok (UTC+7, no daylight saving). Null when not a real date.
 */
export function bangkokDateToIso(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== m - 1 || utc.getUTCDate() !== d) {
    return null;
  }
  return `${date}T00:00:00+07:00`;
}
