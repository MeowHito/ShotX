'use client';

import { useLocale } from 'next-intl';
import { useMemo } from 'react';
import { intlLocale } from '@/i18n/config';
import { formatCompactSatang, formatSatang, formatSignedSatang } from '@/lib/money';
import type { ChartFormat } from './charts';
import { formatBucket } from './range';

/** The finance charts' formatters in the UI language's Intl locale. */
export function useChartFormat(): ChartFormat {
  const locale = intlLocale(useLocale());
  return useMemo(
    () => ({
      money: (satang) => formatSatang(satang, locale),
      signed: (satang) => formatSignedSatang(satang, locale),
      compact: (satang) => formatCompactSatang(satang, locale),
      count: (n) => new Intl.NumberFormat(locale).format(n),
      bucketShort: (bucket) => formatBucket(bucket, locale, 'short'),
      bucketLong: (bucket) => formatBucket(bucket, locale, 'long'),
    }),
    [locale],
  );
}
