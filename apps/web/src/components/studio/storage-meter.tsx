'use client';

import { buttonVariants, cn, Progress } from '@shotx/ui';
import { CloudIcon, PlusIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { BILLING_HREF } from '@/components/drive/paths';
import { useDriveUsage } from '@/lib/drive/queries';
import { formatBytes } from '@/lib/format';

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
 * The aside's storage block: "used X of Y" (studio.storage.used) over a thin bar (amber near the limit, red when
 * full) and the button to buy more space. `compact` is the rail on tablets (icon and bar only).
 */
export function StorageMeter({ compact = false }: { compact?: boolean }) {
  const t = useTranslations('studio.storage');
  const usage = useDriveUsage();
  const data = usage.data;
  if (data === undefined) return null;
  const used = data.usedBytes + data.reservedBytes;
  const level = storageLevel(used, data.quotaBytes);
  const percent = data.quotaBytes > 0 ? (used / data.quotaBytes) * 100 : 100;
  const text =
    data.quotaBytes > 0
      ? t('used', { used: formatBytes(used), quota: formatBytes(data.quotaBytes) })
      : t('noPlan');

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
      {level !== 'ok' && data.quotaBytes > 0 ? (
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
      {compact ? (
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
