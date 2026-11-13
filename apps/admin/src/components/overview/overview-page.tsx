'use client';

import { ADMIN_ROUTES, type AdminSystemResponse } from '@shotx/shared';
import { Alert, Button, cn, Skeleton } from '@shotx/ui';
import { useQuery } from '@tanstack/react-query';
import {
  CloudIcon,
  CpuIcon,
  DatabaseIcon,
  HardDriveIcon,
  MemoryStickIcon,
  RefreshCwIcon,
  ServerIcon,
  ThermometerIcon,
  TimerIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useApiClient } from '@/components/providers';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFormat } from '@/lib/i18n/use-format';

/** How often the overview refetches while open (the bucket count itself is cached by the api). */
export const OVERVIEW_REFRESH_MS = 15_000;

const KNOWN_PREFIXES = ['originals/', 'derived/', 'tmp/', 'designs/'] as const;

/** Share of `part` in `whole`, 0–100, one decimal; null without a whole. */
export function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round(Math.min(100, Math.max(0, (part / whole) * 100)) * 10) / 10;
}

/** Green below 70%, amber below 90%, red from 90%. */
function meterTone(percent: number | null): string {
  if (percent === null) return 'bg-muted-foreground/40';
  if (percent >= 90) return 'bg-destructive';
  if (percent >= 70) return 'bg-amber-500';
  return 'bg-emerald-500';
}

function Meter({ percent, label }: { percent: number | null; label: string }) {
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn('h-full rounded-full transition-[width]', meterTone(percent))}
        style={{ width: `${percent ?? 0}%` }}
      />
    </div>
  );
}

function Card({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section
      aria-label={title}
      className="space-y-4 rounded-2xl border bg-background p-5 shadow-card"
    >
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {icon}
        {title}
      </h2>
      {children}
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-xl font-semibold tabular-nums">{value}</p>
      {hint !== undefined ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/**
 * The overview tab (ADR 0016): what the database records, the R2 bucket by prefix, and the VPS
 * (CPU, memory, disk, uptime, temperature), with a monthly cost estimate (R2 storage, VPS rent). Refetched every OVERVIEW_REFRESH_MS while open.
 */
export function OverviewPage() {
  const t = useTranslations('overview');
  const describe = useErrorMessage();
  const format = useFormat();
  const api = useApiClient();
  const query = useQuery({
    queryKey: ['admin-system'],
    queryFn: ({ signal }) => api.call(ADMIN_ROUTES.system, { signal }),
    refetchInterval: OVERVIEW_REFRESH_MS,
  });

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">
            {t('lead', { seconds: OVERVIEW_REFRESH_MS / 1000 })}
            {query.data !== undefined
              ? ` · ${t('updatedAt', { time: format.dateTime(query.data.generatedAt) })}`
              : null}
          </p>
          {query.data !== undefined ? <TotalCost cost={query.data.cost} /> : null}
        </div>
        <Button variant="outline" onClick={() => void query.refetch()} disabled={query.isFetching}>
          <RefreshCwIcon className={cn(query.isFetching && 'animate-spin')} aria-hidden />
          {t('refresh')}
        </Button>
      </header>
      {query.isError ? (
        <Alert variant="destructive">
          {t('loadError')}: {describe(query.error)}
        </Alert>
      ) : null}
      {query.data === undefined ? (
        query.isPending ? (
          <div className="grid gap-4 lg:grid-cols-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56 rounded-2xl" />
            ))}
          </div>
        ) : null
      ) : (
        <OverviewCards data={query.data} />
      )}
    </div>
  );
}

type Cost = AdminSystemResponse['cost'];

/** R2 storage plus VPS rent a month in THB and USD; R2 counts as 0 when the bucket wasn't counted. */
export function monthlyTotal(cost: Cost): { thb: number; usd: number } {
  const thb = (cost.r2StorageUsdMonth ?? 0) * cost.usdThb + cost.vpsThbMonth;
  return { thb, usd: thb / cost.usdThb };
}

function TotalCost({ cost }: { cost: Cost }) {
  const t = useTranslations('overview');
  const format = useFormat();
  const total = monthlyTotal(cost);
  return (
    <p className="mt-1 text-sm font-medium tabular-nums">
      {t('totalCost', { thb: format.money(total.thb, 'THB'), usd: format.money(total.usd, 'USD') })}
    </p>
  );
}

function OverviewCards({ data }: { data: AdminSystemResponse }) {
  const t = useTranslations('overview');
  const format = useFormat();
  const { storage, bucket, server, cost } = data;
  const memoryPercent = percentOf(server.memory.usedBytes, server.memory.totalBytes);
  const diskPercent =
    server.disk === null ? null : percentOf(server.disk.usedBytes, server.disk.totalBytes);
  const days = Math.floor(server.uptimeSeconds / 86_400);
  const hours = Math.floor((server.uptimeSeconds % 86_400) / 3600);
  const prefixLabel = (prefix: string) =>
    (KNOWN_PREFIXES as readonly string[]).includes(prefix)
      ? t(`bucket.prefixes.${prefix as (typeof KNOWN_PREFIXES)[number]}`)
      : prefix === ''
        ? t('bucket.prefixes.other')
        : prefix;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card
        icon={<ServerIcon className="size-5 text-primary" aria-hidden />}
        title={t('server.title')}
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <CpuIcon className="size-4" aria-hidden />
                {t('server.cpu')}
              </span>
              <span className="font-semibold tabular-nums">
                {server.cpuPercent === null ? t('notAvailable') : `${server.cpuPercent}%`}
              </span>
            </div>
            <Meter percent={server.cpuPercent} label={t('server.cpu')} />
            <p className="text-xs text-muted-foreground">
              {t('server.cpuDetail', {
                count: server.cpuCount,
                load: server.loadAverage.join(' / '),
              })}
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <MemoryStickIcon className="size-4" aria-hidden />
                {t('server.memory')}
              </span>
              <span className="font-semibold tabular-nums">
                {memoryPercent === null ? t('notAvailable') : `${memoryPercent}%`}
              </span>
            </div>
            <Meter percent={memoryPercent} label={t('server.memory')} />
            <p className="text-xs text-muted-foreground">
              {t('server.used', {
                used: format.gigabytes(server.memory.usedBytes),
                total: format.gigabytes(server.memory.totalBytes),
              })}
            </p>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <HardDriveIcon className="size-4" aria-hidden />
                {t('server.disk')}
              </span>
              <span className="font-semibold tabular-nums">
                {diskPercent === null ? t('notAvailable') : `${diskPercent}%`}
              </span>
            </div>
            <Meter percent={diskPercent} label={t('server.disk')} />
            {server.disk !== null ? (
              <p className="text-xs text-muted-foreground">
                {t('server.used', {
                  used: format.gigabytes(server.disk.usedBytes),
                  total: format.gigabytes(server.disk.totalBytes),
                })}
                {' · '}
                {t('server.free', {
                  free: format.gigabytes(server.disk.totalBytes - server.disk.usedBytes),
                })}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('server.diskHint')}</p>
          </div>
          <div className="grid grid-cols-2 gap-4 border-t pt-4 sm:grid-cols-3">
            <Stat
              label={t('server.uptime')}
              value={
                <span className="flex items-center gap-1.5">
                  <TimerIcon className="size-4 text-muted-foreground" aria-hidden />
                  {t('server.uptimeValue', { days, hours })}
                </span>
              }
            />
            <Stat
              label={t('server.temperature')}
              value={
                <span className="flex items-center gap-1.5">
                  <ThermometerIcon className="size-4 text-muted-foreground" aria-hidden />
                  {server.temperatureC === null ? '—' : `${server.temperatureC} °C`}
                </span>
              }
              hint={server.temperatureC === null ? t('server.noSensor') : undefined}
            />
            <Stat
              label={t('server.cost')}
              value={
                cost.vpsThbMonth > 0
                  ? t('perMonth', { amount: format.money(cost.vpsThbMonth, 'THB') })
                  : t('server.prepaid')
              }
              hint={
                cost.vpsThbMonth > 0
                  ? t('approx', { amount: format.money(cost.vpsThbMonth / cost.usdThb, 'USD') })
                  : t('server.prepaidHint')
              }
            />
          </div>
        </div>
      </Card>

      <Card
        icon={<CloudIcon className="size-5 text-primary" aria-hidden />}
        title={t('bucket.title')}
      >
        {bucket === null ? (
          <Alert variant="warning">{t('bucket.unavailable')}</Alert>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label={t('bucket.total')}
                value={format.gigabytes(bucket.totalBytes)}
                hint={t('bucket.objects', { count: bucket.objectCount })}
              />
              {cost.r2StorageUsdMonth !== null ? (
                <Stat
                  label={t('bucket.cost')}
                  value={t('perMonth', { amount: format.money(cost.r2StorageUsdMonth, 'USD') })}
                  hint={
                    cost.r2StorageUsdMonth === 0
                      ? // Under the free GB-months: say why it is $0 (owner, 2026-11-13).
                        t('bucket.freeTier')
                      : t('approx', {
                          amount: format.money(cost.r2StorageUsdMonth * cost.usdThb, 'THB'),
                        })
                  }
                />
              ) : null}
            </div>
            <ul className="space-y-2.5">
              {bucket.prefixes.map((p) => {
                const percent = percentOf(p.bytes, bucket.totalBytes);
                return (
                  <li key={p.prefix} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">{prefixLabel(p.prefix)}</span>
                      <span className="shrink-0 tabular-nums">
                        {format.gigabytes(p.bytes)}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t('bucket.objects', { count: p.objectCount })}
                        </span>
                      </span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{ width: `${percent ?? 0}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
            {cost.r2StorageUsdMonth === 0 ? (
              <div className="space-y-1">
                <Meter
                  percent={percentOf(bucket.totalBytes, cost.r2FreeStorageGb * 1024 ** 3)}
                  label={t('bucket.freeTier')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('bucket.freeTierUsed', {
                    used: format.gigabytes(bucket.totalBytes),
                    free: cost.r2FreeStorageGb,
                  })}
                </p>
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t('bucket.costHint', { free: cost.r2FreeStorageGb })}
              <br />
              {t('bucket.noLimit')}
              <br />
              {t('bucket.measuredAt', { time: format.dateTime(bucket.measuredAt) })}
            </p>
          </div>
        )}
      </Card>

      <Card
        icon={<DatabaseIcon className="size-5 text-primary" aria-hidden />}
        title={t('storage.title')}
      >
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label={t('storage.originals')} value={format.gigabytes(storage.originalsBytes)} />
          <Stat label={t('storage.photos')} value={format.count(storage.photoCount)} />
          <Stat label={t('storage.videos')} value={format.count(storage.videoCount)} />
          <Stat
            label={t('storage.photographers')}
            value={format.count(storage.photographerCount)}
          />
          <Stat
            label={t('storage.database')}
            value={
              storage.databaseBytes === null
                ? t('notAvailable')
                : format.gigabytes(storage.databaseBytes)
            }
          />
        </div>
      </Card>
    </div>
  );
}
