'use client';

import type { ShareStatsQuery, ShareStatsValues } from '@shotx/shared';
import { Alert, Button, Input, Label } from '@shotx/ui';
import { ArrowLeftIcon } from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type FormEvent, useId, useState } from 'react';
import { SHARES_HREF } from '@/components/drive/paths';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFormatBytes } from '@/lib/i18n/use-format';
import { useMe, useShare, useShareStats, useUpdateShare } from '@/lib/studio/queries';
import { ShareForm } from './share-form';
import { ShareRow } from './share-row';

const METRICS = [
  'visitors',
  'scanners',
  'scans',
  'downloads',
  'uniqueDownloaders',
  'zips',
  'bytesOut',
] as const satisfies readonly (keyof ShareStatsValues)[];

/** One share: link, per-share stats from the hourly rollup, and its settings. */
export function ShareDetails({ shareId }: { shareId: string }) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const share = useShare(shareId);
  const me = useMe();
  const update = useUpdateShare();
  const [saved, setSaved] = useState(false);

  return (
    <div className="space-y-6">
      <Link
        href={SHARES_HREF}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground"
      >
        <ArrowLeftIcon className="size-4" aria-hidden />
        {t('shareStats.back')}
      </Link>
      {share.isError ? (
        <Alert variant="destructive">{describe(share.error)}</Alert>
      ) : share.isPending ? (
        <p role="status">{t('common.loading')}</p>
      ) : (
        <>
          <h1 className="font-display text-2xl font-bold tracking-[-0.02em] sm:text-3xl break-words">
            {t('shareStats.title', { name: share.data.target.name })}
          </h1>
          <ShareRow share={share.data} showTarget={false} />
          <ShareStats shareId={shareId} />
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">{t('shareStats.settings')}</h2>
            {share.data.status === 'revoked' ? (
              <p className="text-sm text-muted-foreground">{t('shareStats.revokedNote')}</p>
            ) : (
              <div className="max-w-lg">
                {saved ? <Alert role="status">{t('shareForm.saved')}</Alert> : null}
                <ShareForm
                  key={`${share.data.id}-${share.dataUpdatedAt}`}
                  kind="edit"
                  share={share.data}
                  faceSearchEnabled={me.data?.features.faceSearch ?? false}
                  onSubmit={async (changes) => {
                    setSaved(false);
                    await update.mutateAsync({ id: shareId, body: changes });
                    setSaved(true);
                  }}
                />
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ShareStats({ shareId }: { shareId: string }) {
  const formatBytes = useFormatBytes();
  const ts = useTranslations('shareStats');
  const format = useFormatter();
  const describe = useErrorMessage();
  const id = useId();
  const [range, setRange] = useState<ShareStatsQuery>({});
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const stats = useShareStats(shareId, range);

  function apply(event: FormEvent) {
    event.preventDefault();
    setRange({ ...(from ? { from } : {}), ...(to ? { to } : {}) });
  }

  const value = (values: ShareStatsValues, metric: (typeof METRICS)[number]) =>
    metric === 'bytesOut' ? formatBytes(values.bytesOut) : format.number(values[metric]);

  return (
    <section className="space-y-3">
      <form onSubmit={apply} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label htmlFor={`${id}-from`}>{ts('from')}</Label>
          <Input
            id={`${id}-from`}
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${id}-to`}>{ts('to')}</Label>
          <Input id={`${id}-to`} type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button type="submit" variant="outline">
          {ts('apply')}
        </Button>
      </form>
      {stats.isError ? (
        <Alert variant="destructive">{describe(stats.error)}</Alert>
      ) : stats.isPending ? null : (
        <>
          <h2 className="text-lg font-semibold">{ts('totals')}</h2>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {METRICS.map((metric) => (
              <div key={metric} className="rounded-lg border p-3">
                <dt className="text-xs text-muted-foreground">{ts(metric)}</dt>
                <dd className="text-lg font-semibold">{value(stats.data.totals, metric)}</dd>
              </div>
            ))}
          </dl>
          {stats.data.days.length === 0 ? (
            <p className="text-sm text-muted-foreground">{ts('empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left">
                    <th className="py-2 pr-3 font-medium">{ts('date')}</th>
                    {METRICS.map((metric) => (
                      <th key={metric} className="py-2 pr-3 font-medium whitespace-nowrap">
                        {ts(metric)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.data.days.map((day) => (
                    <tr key={day.date} className="border-b">
                      <td className="py-2 pr-3 whitespace-nowrap">{day.date}</td>
                      {METRICS.map((metric) => (
                        <td key={metric} className="py-2 pr-3">
                          {value(day, metric)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {stats.data.rolledUpAt !== null ? (
            <p className="text-xs text-muted-foreground">
              {ts('rolledUpAt', {
                time: format.dateTime(new Date(stats.data.rolledUpAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }),
              })}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
