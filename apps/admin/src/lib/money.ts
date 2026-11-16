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

/**
 * Integer satang as baht (THB currency in the UI language's Intl locale, satang only when not
 * whole), e.g. `฿1,500` (th-TH) or `THB 1,500` (en-GB, zh-CN).
 */
export function formatSatang(satang: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: satang % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(satang / 100);
}

/** U+2212, the minus sign shown before a loss (never only colour). */
export const MINUS_SIGN = '−';

/**
 * Signed satang (profit) as baht: a loss gets a minus sign, `−฿1,250`; zero and gains have none.
 */
export function formatSignedSatang(satang: number, locale: string): string {
  const shown = formatSatang(Math.abs(satang), locale);
  return satang < 0 ? `${MINUS_SIGN}${shown}` : shown;
}

/**
 * Satang as compact baht for chart axes and direct labels, e.g. `฿1.5K`, `฿12K`, `฿1.2M` (th-TH:
 * the locale's own compact form); negatives with a minus sign. Exact values are in the tooltip
 * and the table view.
 */
export function formatCompactSatang(satang: number, locale: string): string {
  const shown = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    currencyDisplay: 'narrowSymbol',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(Math.abs(satang) / 100);
  return satang < 0 ? `${MINUS_SIGN}${shown}` : shown;
}
