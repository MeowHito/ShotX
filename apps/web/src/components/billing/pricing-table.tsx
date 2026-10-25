'use client';

import type { PlansResponse } from '@shotx/shared';
import { buttonVariants, cn } from '@shotx/ui';
import { CheckIcon } from 'lucide-react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';
import { BILLING_HREF } from '@/components/drive/paths';
import { formatBytes, formatSatang } from '@/lib/format';

type Interval = 'month' | 'year';

/**
 * The public price list from `GET /plans`: Thai, THB, VAT included, monthly or yearly. Prices
 * are shown exactly as the API gives them (VAT split included); nothing is computed here.
 */
export function PricingTable({ plans }: { plans: PlansResponse }) {
  const t = useTranslations('pricing');
  const locale = useLocale();
  const [period, setPeriod] = useState<Interval>('month');
  const rate = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    plans.vatRateBasisPoints / 100,
  );
  const months = new Intl.ListFormat(locale, { type: 'disjunction' }).format(
    plans.prepaidMonths.map(String),
  );

  if (plans.plans.length === 0) {
    return <p className="py-10 text-center text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <div className="space-y-5">
      <div
        role="group"
        aria-label={t('interval')}
        className="mx-auto flex w-fit rounded-lg border p-1"
      >
        {(['month', 'year'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
            className={cn(
              'rounded-md px-4 py-2 text-sm font-medium',
              period === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
            )}
          >
            {value === 'month' ? t('monthly') : t('yearly')}
          </button>
        ))}
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('listLabel')}>
        {plans.plans.map((plan) => {
          const amount = period === 'month' ? plan.month : plan.year;
          const price = formatSatang(amount.totalSatang);
          return (
            <li key={plan.code} className="flex flex-col gap-3 rounded-xl border p-5">
              <h2 className="text-lg font-semibold">{plan.name}</h2>
              <p className="text-2xl font-bold">
                {period === 'month' ? t('perMonth', { price }) : t('perYear', { price })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('vatPart', { vat: formatSatang(amount.vatSatang) })}
              </p>
              <p className="flex items-center gap-2 text-sm">
                <CheckIcon className="size-4 text-primary" aria-hidden />
                {t('storage', { quota: formatBytes(plan.quotaBytes) })}
              </p>
              <Link
                href={`${BILLING_HREF}?${new URLSearchParams({ plan: plan.code }).toString()}`}
                className={cn(buttonVariants(), 'mt-auto')}
              >
                {t('choose', { plan: plan.name })}
              </Link>
            </li>
          );
        })}
      </ul>
      <div className="space-y-1 text-center text-sm text-muted-foreground">
        <p>{t('vatIncluded', { rate })}</p>
        <p>{t('payment', { months })}</p>
      </div>
    </div>
  );
}
