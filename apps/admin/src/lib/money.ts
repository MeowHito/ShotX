import { CASH_PAYMENT_MAX_SATANG } from '@shotx/shared';

/**
 * Money in the admin app: the API sends and takes integer satang; people type and read baht.
 * Conversion is done on the digits (never with floating-point multiplication), so 0.29 THB is
 * 29 satang, not 28.999….
 */

export type ThbParseResult =
  { ok: true; satang: number } | { ok: false; reason: 'invalid' | 'not_positive' | 'too_large' };

/**
 * Baht as typed (`1500`, `1,500.5`, `1500.50`, ` ฿1,500 `) → integer satang. At most two
 * decimals; thousands separators are ignored. The amount must be above zero and at most
 * `max` satang (default CASH_PAYMENT_MAX_SATANG).
 */
export function thbToSatang(text: string, max: number = CASH_PAYMENT_MAX_SATANG): ThbParseResult {
  const cleaned = text.trim().replace(/^฿\s*/, '').replace(/,/g, '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) return { ok: false, reason: 'invalid' };
  const baht = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const satang = baht * 100 + fraction;
  if (!Number.isSafeInteger(satang)) return { ok: false, reason: 'too_large' };
  if (satang <= 0) return { ok: false, reason: 'not_positive' };
  if (satang > max) return { ok: false, reason: 'too_large' };
  return { ok: true, satang };
}

/** Integer satang as Thai baht (THB currency format, satang only when not whole). */
export function formatSatang(satang: number, locale = 'th-TH'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: satang % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(satang / 100);
}
