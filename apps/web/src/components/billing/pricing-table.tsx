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
 * `recommendedPlanCode` (web config) gets the highlighted card.
 */
export function PricingTable({
  plans,
  recommendedPlanCode = null,
}: {
  plans: PlansResponse;
  recommendedPlanCode?: string | null;
}) {
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
    <div className="space-y-8">
      <div
        role="group"
        aria-label={t('interval')}
        className="mx-auto flex w-fit rounded-full border bg-sidebar p-1"
      >
        {(['month', 'year'] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={period === value}
            onClick={() => setPeriod(value)}
            className={cn(
              'h-10 rounded-full px-5 text-sm font-semibold transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring',
              period === value
                ? 'bg-background text-primary shadow-card ring-1 ring-border'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {value === 'month' ? t('monthly') : t('yearly')}
          </button>
        ))}
      </div>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 lg:gap-5" aria-label={t('listLabel')}>
        {plans.plans.map((plan) => {
          const amount = period === 'month' ? plan.month : plan.year;
          const price = formatSatang(amount.totalSatang);
          const featured = plan.code === recommendedPlanCode;
          return (
            <li
              key={plan.code}
              data-featured={featured || undefined}
              className={cn(
                'flex flex-col gap-4 rounded-xl border bg-background p-6',
                featured
                  ? 'border-primary bg-[linear-gradient(to_bottom,color-mix(in_oklab,var(--color-accent)_55%,var(--color-background))_0%,var(--color-background)_30%)] shadow-featured'
                  : 'shadow-card',
              )}
            >
              <div className="space-y-1">
                <p className={cn('eyebrow', !featured && 'invisible')} aria-hidden={!featured}>
                  {t('recommended')}
                </p>
                <h2 className="text-lg">{plan.name}</h2>
              </div>
              <div>
                <p className="text-3xl font-bold tracking-[-0.015em] tabular-nums">
                  {period === 'month' ? t('perMonth', { price }) : t('perYear', { price })}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('vatPart', { vat: formatSatang(amount.vatSatang) })}
                </p>
              </div>
              <p className="flex items-center gap-2 border-t pt-4 text-sm">
                <CheckIcon className="size-4 shrink-0 text-primary" aria-hidden />
                {t('storage', { quota: formatBytes(plan.quotaBytes) })}
              </p>
              <Link
                href={`${BILLING_HREF}?${new URLSearchParams({ plan: plan.code }).toString()}`}
                className={cn(
                  buttonVariants({ variant: featured ? 'default' : 'outline' }),
                  'mt-auto h-11',
                )}
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
