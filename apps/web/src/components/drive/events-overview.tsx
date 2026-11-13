'use client';

import { DRIVE_STATS_DAYS, DRIVE_STATS_DEFAULT_DAYS, type DriveStatsResponse } from '@shotx/shared';
import { Button, cn, Skeleton } from '@shotx/ui';
import {
  ArrowDownRightIcon,
  ArrowUpRightIcon,
  DownloadIcon,
  ImageUpIcon,
  MinusIcon,
  RadioIcon,
  RotateCwIcon,
  UsersIcon,
} from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { useDriveStats } from '@/lib/drive/queries';

type Metric = 'visitors' | 'downloads' | 'photos';

/**
 * One colour per measure (dataviz reference palette, dark steps, validated on the card surface
 * #111a2e: lightness band, CVD and contrast all pass). Each chart is a single series named by its
 * tile, so the colour only ties the chart to its tile.
 */
const SERIES: Record<Metric, { stroke: string; fill: string; soft: string }> = {
  visitors: {
    stroke: 'var(--series-visitors)',
    fill: 'bg-(--series-visitors)',
    soft: 'bg-(--series-visitors)/15 text-(--series-visitors) dark:text-[#7fb2f0]',
  },
  downloads: {
    stroke: 'var(--series-downloads)',
    fill: 'bg-(--series-downloads)',
    soft: 'bg-(--series-downloads)/15 text-(--series-downloads) dark:text-[#f0a07d]',
  },
  photos: {
    stroke: 'var(--series-photos)',
    fill: 'bg-(--series-photos)',
    soft: 'bg-(--series-photos)/15 text-(--series-photos) dark:text-[#5fd3a6]',
  },
};

export interface EventCounts {
  total: number;
  published: number;
  paused: number;
}

/** Noon UTC of a Bangkok calendar day, so formatting never slips to a neighbouring day. */
function dateOf(day: string): Date {
  return new Date(`${day}T12:00:00Z`);
}

/** Change against the period before: a percentage, "new" (from zero) or none. */
export function changeOf(
  now: number,
  before: number,
): { kind: 'up' | 'down' | 'flat' | 'new'; pct: number } {
  if (before === 0) return now === 0 ? { kind: 'flat', pct: 0 } : { kind: 'new', pct: 0 };
  const pct = ((now - before) / before) * 100;
  return { kind: Math.abs(pct) < 0.05 ? 'flat' : pct > 0 ? 'up' : 'down', pct };
}

/**
 * ADR 0024: the bento of numbers at the top of Events (studio.drive): events published, people
 * who opened a share page, photos downloaded and photos uploaded, each with its change against
 * the period before and a small chart of its days (one chart per measure, never two axes).
 * Hovering a chart shows that day's number; a table carries every day for screen readers.
 */
export function EventsOverview({ events }: { events: EventCounts }) {
  const t = useTranslations('driveStats');
  const format = useFormatter();
  const [days, setDays] = useState<number>(DRIVE_STATS_DEFAULT_DAYS);
  const stats = useDriveStats(days);
  const data = stats.data;

  return (
    <section aria-labelledby="events-overview-title" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="events-overview-title" className="text-base font-semibold">
          {t('title')}
        </h2>
        <div
          role="radiogroup"
          aria-label={t('range')}
          className="flex rounded-xl border border-border bg-surface p-1 dark:border-white/5"
        >
          {DRIVE_STATS_DAYS.map((d) => (
            <button
              key={d}
              type="button"
              role="radio"
              aria-checked={days === d}
              onClick={() => setDays(d)}
              className={cn(
                'h-9 rounded-lg px-3 text-sm text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                days === d
                  ? 'bg-accent font-semibold text-primary dark:text-cyan-300'
                  : 'hover:text-foreground',
              )}
            >
              {t('days', { count: d })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 xl:grid-cols-4">
        <Tile
          label={t('events.total')}
          icon={<RadioIcon className="size-5" />}
          iconClass="bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          value={
            <>
              {format.number(events.published)}
              <span className="ml-2 font-sans text-sm font-normal text-muted-foreground">
                {t('events.of', { count: events.total })}
              </span>
            </>
          }
          footer={
            <span className="flex items-center gap-2 text-emerald-700 dark:text-emerald-300">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full rounded-full bg-emerald-400 opacity-60 motion-safe:animate-ping" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-400" />
              </span>
              {t('events.live', { count: events.published })}
              {events.paused > 0 ? (
                <span className="text-muted-foreground">
                  · {t('events.paused', { count: events.paused })}
                </span>
              ) : null}
            </span>
          }
        />

        {stats.isError ? (
          <div className="studio-card col-span-2 flex items-center justify-between gap-2 p-4 text-sm text-muted-foreground xl:col-span-3">
            <span>{t('loadError')}</span>
            <Button size="sm" variant="outline" onClick={() => void stats.refetch()}>
              <RotateCwIcon aria-hidden />
              {t('retry')}
            </Button>
          </div>
        ) : data === undefined ? (
          <>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-40 rounded-2xl" />
            ))}
            <span role="status" className="sr-only">
              {t('loading')}
            </span>
          </>
        ) : (
          <>
            <MetricTile
              metric="visitors"
              data={data}
              value={data.period.visitors}
              icon={<UsersIcon className="size-5" />}
              footer={t('perDay', {
                count: Math.round((data.period.visitors / Math.max(1, data.days.length)) * 10) / 10,
              })}
              chart="line"
            />
            <MetricTile
              metric="downloads"
              data={data}
              value={data.period.downloads}
              icon={<DownloadIcon className="size-5" />}
              footer={t('allTime', { count: data.totals.downloads })}
              chart="bars"
            />
            <MetricTile
              metric="photos"
              data={data}
              value={data.period.photos}
              icon={<ImageUpIcon className="size-5" />}
              footer={t('photosInDrive', { count: data.totals.photos })}
              chart="bars"
            />
          </>
        )}
      </div>

      {data !== undefined ? (
        <>
          <p className="text-xs text-muted-foreground">{t('note')}</p>
          <table className="sr-only">
            <caption>{t('tableCaption', { count: data.days.length })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('date')}</th>
                <th scope="col">{t('visitors.label')}</th>
                <th scope="col">{t('downloads.label')}</th>
                <th scope="col">{t('photos.label')}</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.date}>
                  <th scope="row">{format.dateTime(dateOf(d.date), { dateStyle: 'medium' })}</th>
                  <td>{d.visitors}</td>
                  <td>{d.downloads}</td>
                  <td>{d.photos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

function Tile({
  label,
  icon,
  iconClass,
  value,
  badge,
  footer,
  children,
}: {
  label: string;
  icon: ReactNode;
  iconClass: string;
  value: ReactNode;
  badge?: ReactNode;
  footer: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="studio-card flex min-h-36 min-w-0 flex-col justify-between gap-3 p-3 transition-colors hover:border-indigo-400/30 sm:min-h-40 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold tracking-wide text-muted-foreground">{label}</p>
          <p className="flex flex-wrap items-baseline gap-x-2 font-display text-2xl leading-none font-bold sm:text-3xl tracking-[-0.03em] tabular-nums">
            {value}
            {badge}
          </p>
        </div>
        <span
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-xl sm:size-10',
            iconClass,
          )}
          aria-hidden
        >
          {icon}
        </span>
      </div>
      {children}
      <div className="text-xs text-muted-foreground">{footer}</div>
    </div>
  );
}

function ChangeBadge({ now, before }: { now: number; before: number }) {
  const t = useTranslations('driveStats');
  const format = useFormatter();
  const change = changeOf(now, before);
  const Icon =
    change.kind === 'down'
      ? ArrowDownRightIcon
      : change.kind === 'flat'
        ? MinusIcon
        : ArrowUpRightIcon;
  const text =
    change.kind === 'new'
      ? t('changeNew')
      : change.kind === 'flat'
        ? t('changeFlat')
        : `${change.pct > 0 ? '+' : ''}${format.number(change.pct / 100, {
            style: 'percent',
            maximumFractionDigits: 1,
          })}`;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 font-sans text-xs font-semibold',
        change.kind === 'up' || change.kind === 'new'
          ? 'text-emerald-700 dark:text-emerald-300'
          : change.kind === 'down'
            ? 'text-rose-700 dark:text-rose-300'
            : 'text-muted-foreground',
      )}
      title={t('vsBefore')}
    >
      <Icon className="size-3.5" aria-hidden />
      {text}
      <span className="sr-only"> {t('vsBefore')}</span>
    </span>
  );
}

function MetricTile({
  metric,
  data,
  value,
  icon,
  footer,
  chart,
}: {
  metric: Metric;
  data: DriveStatsResponse;
  value: number;
  icon: ReactNode;
  footer: string;
  chart: 'line' | 'bars';
}) {
  const t = useTranslations('driveStats');
  const format = useFormatter();
  const [hover, setHover] = useState<number | null>(null);
  const values = data.days.map((d) => d[metric]);
  const hovered = hover === null ? undefined : data.days[hover];
  return (
    <Tile
      label={t(`${metric}.label`)}
      icon={icon}
      iconClass={SERIES[metric].soft}
      value={format.number(value)}
      badge={<ChangeBadge now={value} before={data.previous[metric]} />}
      footer={
        hovered === undefined ? (
          footer
        ) : (
          <span className="text-foreground tabular-nums">
            {format.dateTime(dateOf(hovered.date), { day: 'numeric', month: 'short' })} ·{' '}
            {format.number(hovered[metric])}
          </span>
        )
      }
    >
      <Spark values={values} metric={metric} kind={chart} hover={hover} onHover={setHover} />
    </Tile>
  );
}

/** A small line or bar chart of the days (hover columns are wider than the marks). */
function Spark({
  values,
  metric,
  kind,
  hover,
  onHover,
}: {
  values: readonly number[];
  metric: Metric;
  kind: 'line' | 'bars';
  hover: number | null;
  onHover: (index: number | null) => void;
}) {
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const y = (v: number) => 92 - (v / max) * 84;
  const color = SERIES[metric].stroke;
  const last = n - 1;
  const at = hover ?? last;
  return (
    <div className="relative h-12" aria-hidden onMouseLeave={() => onHover(null)}>
      {kind === 'line' ? (
        <>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="absolute inset-0 size-full"
          >
            <defs>
              <linearGradient id={`spark-${metric}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.28" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d={`M0 100 ${values.map((v, i) => `L${x(i)} ${y(v)}`).join(' ')} L100 100 Z`}
              fill={`url(#spark-${metric})`}
            />
            <path
              d={values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(v)}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          {hover !== null ? (
            <span
              className="absolute top-0 bottom-0 w-px bg-foreground/25"
              style={{ left: `${x(hover)}%` }}
            />
          ) : null}
          {n > 0 ? (
            <span
              className="absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-surface"
              style={{
                left: `${x(at)}%`,
                top: `${y(values[at] ?? 0)}%`,
                backgroundColor: color,
              }}
            />
          ) : null}
        </>
      ) : null}
      <div className={cn('absolute inset-0 flex items-end', kind === 'bars' && 'gap-[2px]')}>
        {values.map((v, i) => (
          <div
            key={i}
            className="flex h-full min-w-0 flex-1 items-end"
            onMouseEnter={() => onHover(i)}
            onTouchStart={() => onHover(i)}
          >
            {kind === 'bars' ? (
              <div
                className={cn(
                  'w-full rounded-t-[3px] transition-opacity',
                  SERIES[metric].fill,
                  hover !== null && hover !== i && 'opacity-35',
                )}
                style={{ height: v === 0 ? 0 : `max(2px, ${(v / max) * 100}%)` }}
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
