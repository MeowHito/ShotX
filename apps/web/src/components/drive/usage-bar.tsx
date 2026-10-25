'use client';

import type { DriveUsageResponse } from '@shotx/shared';
import { Alert, Progress } from '@shotx/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useDriveUsage } from '@/lib/drive/queries';
import { formatBytes } from '@/lib/format';

export function UsageSummary({ usage }: { usage: DriveUsageResponse }) {
  const t = useTranslations('usage');
  const format = useFormatter();
  const used = usage.usedBytes + usage.reservedBytes;
  const percent = usage.quotaBytes > 0 ? (used / usage.quotaBytes) * 100 : 100;
  const sub = usage.subscription;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{t('label')}</span>
        <span className="text-muted-foreground">
          {t('summary', { used: formatBytes(used), quota: formatBytes(usage.quotaBytes) })}
        </span>
      </div>
      <Progress
        value={percent}
        aria-label={t('label')}
        indicatorClassName={percent >= 90 ? 'bg-destructive' : undefined}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {usage.reservedBytes > 0 ? (
          <span>{t('reserved', { bytes: formatBytes(usage.reservedBytes) })}</span>
        ) : null}
        {usage.trashBytes > 0 ? (
          <span>{t('trash', { bytes: formatBytes(usage.trashBytes) })}</span>
        ) : null}
        <span>
          {sub === null
            ? t('noPlan')
            : t('plan', {
                plan: sub.planCode,
                status: t(`subscriptionStatus.${sub.status}`),
                date: format.dateTime(new Date(sub.periodEnd), { dateStyle: 'medium' }),
              })}
        </span>
      </div>
      {usage.uploadsBlockedBy !== null ? (
        <Alert variant="warning">{t(`blocked.${usage.uploadsBlockedBy}`)}</Alert>
      ) : null}
    </div>
  );
}

/** The storage meter from `GET /drive/usage`. */
export function UsageBar() {
  const usage = useDriveUsage();
  if (usage.data === undefined) return null;
  return <UsageSummary usage={usage.data} />;
}
