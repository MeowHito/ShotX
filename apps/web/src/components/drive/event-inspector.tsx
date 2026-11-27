'use client';

import type { DriveFolder } from '@shotx/shared';
import { Button, buttonVariants, cn } from '@shotx/ui';
import {
  CalendarDaysIcon,
  ExternalLinkIcon,
  ImageIcon,
  PencilIcon,
  MonitorIcon,
  QrCodeIcon,
  SlidersHorizontalIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { displayUrlOf } from '@/components/shares/link-display-picker';
import { useEffect, useRef, useState } from 'react';
import { useShareStats } from '@/lib/studio/queries';
import { EventStatusBadge } from './item-card';
import { shareHref } from './paths';

/** Days of the inspector's chart. */
export const INSPECTOR_DAYS = 7;
const DAY_MS = 86_400_000;
/** The visitors series colour (the overview's visitors tile). */
const VISITORS = 'bg-(--series-visitors)';

/** Today in Asia/Bangkok (the stats calendar), `YYYY-MM-DD`. */
function bangkokToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(now);
}

/** The last `count` Bangkok days ending today, ascending. */
export function lastDays(count: number, now = new Date()): string[] {
  const today = Date.parse(`${bangkokToday(now)}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    new Date(today - (count - 1 - i) * DAY_MS).toISOString().slice(0, 10),
  );
}

/**
 * ADR 0024: the side panel of Events (wide screens): the chosen event's cover, link, a QR code to
 * scan from the screen, and its visitors over the last week (GET /shares/:id/stats), with the
 * edit and link-management actions.
 */
export function EventInspector({
  folder,
  onEdit,
  onQr,
}: {
  folder: DriveFolder;
  onEdit: () => void;
  onQr: () => void;
}) {
  const t = useTranslations('eventInspector');
  const link = folder.event?.link ?? null;
  const cover = folder.event?.coverThumbUrl ?? null;
  const live = link !== null && link.status !== 'revoked';
  return (
    <aside aria-label={t('label', { name: folder.name })} className="studio-card space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="truncate text-base font-semibold">{t('title')}</h2>
        <EventStatusBadge folder={folder} />
      </div>

      <div className="relative aspect-[2/3] overflow-hidden rounded-xl border border-border bg-muted dark:border-white/5">
        {cover !== null ? (
          // The cover's signed thumbnail (CDN).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" className="absolute inset-0 size-full object-cover" />
        ) : (
          <ImageIcon
            className="absolute inset-0 m-auto size-10 text-muted-foreground"
            aria-hidden
          />
        )}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 pt-10">
          <p className="truncate text-sm font-semibold text-white" title={folder.name}>
            {folder.name}
          </p>
          {live ? (
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 truncate font-mono text-xs text-cyan-300 hover:underline"
            >
              <span className="truncate">{link.url.replace(/^https?:\/\//, '')}</span>
              <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
            </a>
          ) : (
            <p className="text-xs text-white/70">{t('noLink')}</p>
          )}
        </div>
      </div>

      {live ? (
        <>
          <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/60 p-3 dark:border-white/5 dark:bg-background/60">
            <QrPreview url={link.url} />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold">{t('scanTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('scanHint')}</p>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-primary dark:text-cyan-300"
                onClick={onQr}
              >
                <QrCodeIcon aria-hidden />
                {t('saveQr')}
              </Button>
              {/* ADR 0033: the event screen (newest photos + this QR) for a monitor at the event. */}
              <a
                href={displayUrlOf(link.url)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1.5 text-sm font-medium text-primary hover:underline dark:text-cyan-300"
              >
                <MonitorIcon className="size-4" aria-hidden />
                {t('openDisplay')}
              </a>
            </div>
          </div>
          <VisitorsChart shareId={link.shareId} />
        </>
      ) : null}

      <div className="flex gap-2">
        <Button type="button" variant="secondary" className="flex-1" onClick={onEdit}>
          <PencilIcon aria-hidden />
          {t('edit')}
        </Button>
        {link !== null ? (
          <Link
            href={shareHref(link.shareId)}
            className={cn(buttonVariants({ variant: 'outline', size: 'icon' }), 'size-10')}
            aria-label={t('manage')}
            title={t('manage')}
          >
            <SlidersHorizontalIcon aria-hidden />
          </Link>
        ) : null}
      </div>
    </aside>
  );
}

/** A small QR of the link, black on white (phones read it from the screen). */
function QrPreview({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (canvas.current === null) return;
    QRCode.toCanvas(canvas.current, url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 160,
    }).catch(() => undefined);
  }, [url]);
  return (
    <canvas
      ref={canvas}
      width={160}
      height={160}
      className="!size-20 shrink-0 rounded-lg bg-white"
      aria-hidden
    />
  );
}

function VisitorsChart({ shareId }: { shareId: string }) {
  const t = useTranslations('eventInspector');
  const format = useFormatter();
  const [days] = useState(() => lastDays(INSPECTOR_DAYS));
  const stats = useShareStats(shareId, { from: days[0], to: days.at(-1) });
  const [hover, setHover] = useState<number | null>(null);
  const byDate = new Map((stats.data?.days ?? []).map((d) => [d.date, d]));
  const values = days.map((d) => byDate.get(d)?.visitors ?? 0);
  const max = Math.max(1, ...values);
  const totals = stats.data?.totals;
  const day = (d: string) => format.dateTime(new Date(`${d}T12:00:00Z`), { weekday: 'short' });
  const hovered = hover === null ? undefined : days[hover];

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
          <CalendarDaysIcon className="size-3.5" aria-hidden />
          {t('visitorsWeek')}
        </p>
        <p className="text-xs tabular-nums">
          {hovered === undefined
            ? t('visitorsTotal', { count: totals?.visitors ?? 0 })
            : `${format.dateTime(new Date(`${hovered}T12:00:00Z`), { day: 'numeric', month: 'short' })} · ${format.number(values[hover ?? 0] ?? 0)}`}
        </p>
      </div>
      <div className="flex h-24 items-end gap-1.5" aria-hidden onMouseLeave={() => setHover(null)}>
        {values.map((v, i) => (
          <div
            key={days[i]}
            className="flex h-full flex-1 flex-col justify-end gap-1"
            onMouseEnter={() => setHover(i)}
            onTouchStart={() => setHover(i)}
          >
            <div
              className={cn(
                'w-full rounded-t-[4px] transition-opacity',
                VISITORS,
                v === 0 && 'opacity-25',
                hover !== null && hover !== i && 'opacity-35',
              )}
              style={{ height: v === 0 ? 2 : `${(v / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 text-center text-[11px] text-muted-foreground" aria-hidden>
        {days.map((d) => (
          <span key={d} className="flex-1 truncate">
            {day(d)}
          </span>
        ))}
      </div>
      <dl className="grid grid-cols-3 gap-2 pt-1 text-center">
        {(['visitors', 'downloads', 'scans'] as const).map((key) => (
          <div key={key} className="rounded-lg bg-muted/70 px-2 py-1.5 dark:bg-background/60">
            <dt className="text-[11px] text-muted-foreground">{t(`totals.${key}`)}</dt>
            <dd className="font-display text-lg font-bold tabular-nums">
              {format.number(totals?.[key] ?? 0)}
            </dd>
          </div>
        ))}
      </dl>
      <table className="sr-only">
        <caption>{t('visitorsWeek')}</caption>
        <tbody>
          {days.map((d, i) => (
            <tr key={d}>
              <th scope="row">
                {format.dateTime(new Date(`${d}T12:00:00Z`), { dateStyle: 'medium' })}
              </th>
              <td>{values[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
