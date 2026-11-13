'use client';

import { useLocale } from 'next-intl';
import { useMemo } from 'react';
import { intlLocale } from '@/i18n/config';
import { formatBytes, formatDate, formatDateTime, formatGigabytes } from '@/lib/format';
import { formatSatang } from '@/lib/money';

export interface Formatters {
  gigabytes: (bytes: number) => string;
  bytes: (bytes: number) => string;
  dateTime: (iso: string) => string;
  date: (iso: string) => string;
  satang: (satang: number) => string;
  /** A count with grouping separators (1,234). */
  count: (n: number) => string;
  /** An estimate in USD (2 decimals: $0.66) or THB (whole baht: ฿1,529). */
  money: (amount: number, currency: 'USD' | 'THB') => string;
}

/**
 * The format helpers in the UI language's Intl locale (th-TH / en-GB / zh-CN); times stay in
 * Asia/Bangkok.
 */
export function useFormat(): Formatters {
  const locale = intlLocale(useLocale());
  return useMemo(
    () => ({
      gigabytes: (bytes) => formatGigabytes(bytes, locale),
      bytes: (bytes) => formatBytes(bytes, locale),
      dateTime: (iso) => formatDateTime(iso, locale),
      date: (iso) => formatDate(iso, locale),
      satang: (satang) => formatSatang(satang, locale),
      count: (n) => new Intl.NumberFormat(locale).format(n),
      money: (amount, currency) =>
        new Intl.NumberFormat(locale, {
          style: 'currency',
          currency,
          currencyDisplay: 'narrowSymbol',
          minimumFractionDigits: currency === 'USD' ? 2 : 0,
          maximumFractionDigits: currency === 'USD' ? 2 : 0,
        }).format(amount),
    }),
    [locale],
  );
}
