'use client';

import { buttonVariants, cn, Progress } from '@shotx/ui';
import { CloudIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BILLING_HREF } from '@/components/drive/paths';
import { useDriveUsage } from '@/lib/drive/queries';
import { formatBytes } from '@/lib/format';
import { useStudio } from './studio-context';

/** Used share of the quota from which the meter turns amber, and red. */
export const STORAGE_WARN_RATIO = 0.8;
export const STORAGE_FULL_RATIO = 0.95;

export type StorageLevel = 'ok' | 'warn' | 'full';

export function storageLevel(used: number, quota: number): StorageLevel {
  if (quota <= 0) return 'full';
  const ratio = used / quota;
  return ratio >= STORAGE_FULL_RATIO ? 'full' : ratio >= STORAGE_WARN_RATIO ? 'warn' : 'ok';
}

/**
 * The aside's storage block. With a quota: "used X of Y" (studio.storage.used) over a thin bar
 * (amber near the limit, red when full). Without one (STORAGE_QUOTA_ENFORCED=false, the API's
 * quotaBytes null; ADR 0010): only "used X", no bar and no limit. The button to buy more space
 * shows only while photographers can pay online (BILLING_MODE=gateway). `compact` is the rail on
 * tablets (icon and bar only).
 */
export function StorageMeter({ compact = false }: { compact?: boolean }) {
  const t = useTranslations('studio.storage');
  const { config } = useStudio();
  const usage = useDriveUsage();
  const data = usage.data;
  if (data === undefined) return null;
  const used = data.usedBytes + data.reservedBytes;
  const quota = data.quotaBytes;
  const canBuy = config.billingMode === 'gateway';

  if (quota === null) {
    return (
      <section aria-label={t('title')} className="space-y-1.5">
        <div
          className={cn('flex items-center gap-2 text-sm font-medium', compact && 'justify-center')}
        >
          <CloudIcon className="size-4 text-muted-foreground" aria-hidden />
          <span className={cn(compact && 'sr-only')}>{t('title')}</span>
        </div>
        <p className={cn('text-xs text-muted-foreground', compact && 'sr-only')}>
          {t('usedOnly', { used: formatBytes(used) })}
        </p>
      </section>
    );
  }

  const level = storageLevel(used, quota);
  const percent = quota > 0 ? (used / quota) * 100 : 100;
  const text =
    quota > 0 ? t('used', { used: formatBytes(used), quota: formatBytes(quota) }) : t('noPlan');

  return (
    <section aria-label={t('title')} className="space-y-2.5">
      <div
        className={cn('flex items-center gap-2 text-sm font-medium', compact && 'justify-center')}
      >
        <CloudIcon className="size-4 text-muted-foreground" aria-hidden />
        <span className={cn(compact && 'sr-only')}>{t('title')}</span>
      </div>
      <Progress
        value={percent}
        aria-label={t('title')}
        aria-valuetext={text}
        data-level={level}
        className="h-1.5"
        indicatorClassName={cn(
          level === 'warn' && 'bg-warning',
          level === 'full' && 'bg-destructive',
        )}
      />
      <p className={cn('text-xs text-muted-foreground', compact && 'sr-only')}>{text}</p>
      {level !== 'ok' && quota > 0 ? (
        <p
          className={cn(
            'text-xs font-medium',
            level === 'full' ? 'text-destructive' : 'text-warning-foreground',
            compact && 'sr-only',
          )}
        >
          {level === 'full' ? t('full') : t('nearlyFull')}
        </p>
      ) : null}
      {!canBuy ? null : compact ? (
        <Link
          href={BILLING_HREF}
          aria-label={t('add')}
          title={t('add')}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'icon' }),
            'mx-auto size-11 rounded-full',
          )}
        >
          <PlusIcon aria-hidden />
        </Link>
      ) : (
        <Link
          href={BILLING_HREF}
          className={cn(
            buttonVariants({ variant: 'outline', size: 'sm' }),
            'h-11 w-full rounded-full sm:h-9',
          )}
        >
          {t('add')}
        </Link>
      )}
    </section>
  );
}
