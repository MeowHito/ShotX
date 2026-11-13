'use client';

import { DRIVE_STATS_DAYS, DRIVE_STATS_DEFAULT_DAYS, type DriveStatsResponse } from '@shotx/shared';
import { Button, cn, Skeleton } from '@shotx/ui';
import { DownloadIcon, ImageUpIcon, RotateCwIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useDriveStats } from '@/lib/drive/queries';

type Day = DriveStatsResponse['days'][number];
type Metric = 'photos' | 'downloads';

/**
 * Series colours (dataviz reference palette, validated for both themes): uploads blue, downloads
 * orange. Each chart is one series, so the title names it; the colour only ties a chart to its
 * tile.
 */
const SERIES: Record<Metric, string> = {
  photos: 'bg-[#2a78d6] dark:bg-[#3987e5]',
  downloads: 'bg-[#eb6834] dark:bg-[#d95926]',
};

/**
 * ADR 0023: the photographer's numbers at the top of Events (studio.drive): photos in the drive and photos
 * downloaded from share pages (all time, plus the chosen period), and one small bar chart per
 * measure over the same days (two charts, never two y-axes). Hovering a day highlights it in both
 * charts; a table carries the same numbers for screen readers.
 */
export function DriveStatsCard() {
  const t = useTranslations('driveStats');
  const format = useFormatter();
  const [days, setDays] = useState<number>(DRIVE_STATS_DEFAULT_DAYS);
  const [hover, setHover] = useState<number | null>(null);
  const stats = useDriveStats(days);
  const data = stats.data;

  return (
    <section
      aria-labelledby="drive-stats-title"
      className="space-y-4 rounded-2xl border bg-background p-4 shadow-card md:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="drive-stats-title" className="font-semibold">
          {t('title')}
        </h2>
        <div
          role="radiogroup"
          aria-label={t('range')}
          className="flex rounded-lg border bg-sidebar p-0.5"
        >
          {DRIVE_STATS_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              onClick={() => setDays(d)}
              className={cn(
                'h-9 rounded-md px-3 text-sm text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                days === d &&
                  'bg-background font-medium text-foreground shadow-card ring-1 ring-border',
              )}
            >
              {t('days', { count: d })}
            </button>
          ))}
        </div>
      </div>

      {stats.isError ? (
        <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
          <span>{t('loadError')}</span>
          <Button size="sm" variant="outline" onClick={() => void stats.refetch()}>
            <RotateCwIcon aria-hidden />
            {t('retry')}
          </Button>
        </div>
      ) : data === undefined ? (
        <div role="status" aria-label={t('loading')} className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {(['photos', 'downloads'] as const).map((metric) => (
              <MetricPanel
                key={metric}
                metric={metric}
                data={data}
                hover={hover}
                onHover={setHover}
              />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('note')}</p>
          <table className="sr-only">
            <caption>{t('tableCaption', { count: days })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('date')}</th>
                <th scope="col">{t('photos.chart')}</th>
                <th scope="col">{t('downloads.chart')}</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.date}>
                  <th scope="row">{format.dateTime(dateOf(d.date), { dateStyle: 'medium' })}</th>
                  <td>{d.photos}</td>
                  <td>{d.downloads}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

/** Noon UTC of a Bangkok calendar day, so formatting never slips to a neighbouring day. */
function dateOf(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

function MetricPanel({
  metric,
  data,
  hover,
  onHover,
}: {
  metric: Metric;
  data: DriveStatsResponse;
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const t = useTranslations('driveStats');
  const format = useFormatter();
  const Icon = metric === 'photos' ? ImageUpIcon : DownloadIcon;
  const max = Math.max(1, ...data.days.map((d) => d[metric]));
  const hovered: Day | undefined = hover === null ? undefined : data.days[hover];
  const short = (day: string) => format.dateTime(dateOf(day), { day: 'numeric', month: 'short' });

  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-lg text-white',
            SERIES[metric],
          )}
          aria-hidden
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{t(`${metric}.total`)}</p>
          <p className="text-2xl leading-tight font-semibold tabular-nums">
            {format.number(data.totals[metric])}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('inPeriod', {
              count: data.period[metric],
              days: data.days.length,
            })}
          </p>
        </div>
      </div>

      <figure className="space-y-1" aria-hidden>
        <figcaption className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
          <span>{t(`${metric}.chart`)}</span>
          <span className="tabular-nums text-foreground">
            {hovered === undefined
              ? null
              : `${short(hovered.date)} · ${format.number(hovered[metric])}`}
          </span>
        </figcaption>
        <div className="relative">
          {/* Recessive grid: the max at the top, the baseline at the bottom. */}
          <span className="absolute -top-2 left-0 text-[11px] text-muted-foreground tabular-nums">
            {format.number(max)}
          </span>
          <div
            className="flex h-24 items-end gap-[2px] border-b border-border pt-3"
            onMouseLeave={() => onHover(null)}
          >
            {data.days.map((d, i) => {
              const value = d[metric];
              return (
                <div
                  key={d.date}
                  className="flex h-full min-w-0 flex-1 cursor-default items-end"
                  onMouseEnter={() => onHover(i)}
                  onTouchStart={() => onHover(i)}
                  title={`${short(d.date)}: ${value}`}
                >
                  <div
                    className={cn(
                      'w-full rounded-t-[4px] transition-opacity',
                      SERIES[metric],
                      hover !== null && hover !== i && 'opacity-40',
                    )}
                    style={{ height: value === 0 ? 0 : `max(2px, ${(value / max) * 100}%)` }}
                  />
                </div>
              );
            })}
          </div>
          <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
            <span>{short(data.from)}</span>
            <span>{short(data.to)}</span>
          </div>
        </div>
      </figure>
    </div>
  );
}
