'use client';

import type { DriveFile, DriveFolder, DriveItem } from '@shotx/shared';
import { Button, buttonVariants, Checkbox, cn } from '@shotx/ui';
import {
  BarChart3Icon,
  CalendarIcon,
  CopyIcon,
  FileWarningIcon,
  FolderIcon,
  ImageIcon,
  LinkIcon,
  LoaderIcon,
  PencilIcon,
  PlayIcon,
  QrCodeIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useEffect, useRef } from 'react';
import { useFormatBytes } from '@/lib/i18n/use-format';

export type ItemLayout = 'grid' | 'list';

export interface ItemCardProps {
  item: DriveItem;
  selected: boolean;
  onToggleSelect: () => void;
  /** Folders open on click (the drive); null in the trash. */
  href: string | null;
  /** Second line, e.g. the purge date in the trash. */
  subtitle?: ReactNode;
  actions?: ReactNode;
  layout?: ItemLayout;
  /** Something is selected: checkboxes stay visible. */
  selectionMode?: boolean;
  /** Move keyboard focus here when this token changes (arrow keys; also on mount, for rows the
   * virtualizer renders only after scrolling to them). */
  focusRequest?: number;
  /**
   * Click on the item itself (not the checkbox or menu). The drive uses it for ⌘/Ctrl/Shift
   * multi-select; calling `preventDefault` keeps a folder link from opening. Without it, a file
   * click toggles its selection.
   */
  onPrimaryClick?: (event: MouseEvent) => void;
  /** Space (and Enter on files): show the item's details. */
  onPreview?: () => void;
  /** Show the selection checkbox (false on search lists). */
  selectable?: boolean;
  /** The checkbox shows all the time, not only on hover (Recent, owner 2026-11-13). */
  checkboxAlwaysVisible?: boolean;
  /**
   * Folders as events (ADR 0016): cover, created date, link status, QR and edit. Without it a
   * folder is a plain folder tile (search, recent, move).
   */
  eventActions?: EventActions;
}

export interface EventActions {
  onEdit: () => void;
  /** Null while the event has no link (the QR button is disabled). */
  onQr: (() => void) | null;
  /**
   * ADR 0024: this event's numbers. Wide screens (`media`) show them in the inspector
   * (`onInspect`); others open the link's page (`href`), or call `onInspect` without a link.
   */
  stats?: { href: string | null; media: string; onInspect: () => void };
  /** ADR 0024: copy the event's link; null while it has none. */
  onCopyLink?: (() => void) | null;
  /** ADR 0024: the event shown in the inspector. */
  inspected?: boolean;
}

/** The status of an event's link (ADR 0016): none, published, unpublished or expired. */
export type EventStatus = 'none' | 'active' | 'paused' | 'expired';

export function eventStatusOf(folder: DriveFolder): EventStatus {
  const status = folder.event?.link?.status;
  return status === undefined || status === 'revoked' ? 'none' : status;
}

const STATUS_DOT: Record<EventStatus, string> = {
  none: 'bg-muted-foreground/40',
  active: 'bg-emerald-500',
  paused: 'bg-amber-500',
  expired: 'bg-destructive',
};

/** A coloured dot and the status label. */
export function EventStatusBadge({ folder }: { folder: DriveFolder }) {
  const ts = useTranslations('event.status');
  const status = eventStatusOf(folder);
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        status === 'active' ? 'text-foreground' : 'text-muted-foreground',
      )}
      data-status={status}
    >
      <span className={cn('size-2 shrink-0 rounded-full', STATUS_DOT[status])} aria-hidden />
      <span className="truncate">{ts(status)}</span>
    </span>
  );
}

/** The QR and edit buttons of an event (the menu keeps everything else). */
function EventButtons({
  name,
  actions,
  labels,
}: {
  name: string;
  actions: EventActions;
  labels: 'icon' | 'full';
}) {
  const te = useTranslations('event');
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-9 max-sm:hidden"
        disabled={actions.onQr === null}
        onClick={() => actions.onQr?.()}
        aria-label={te('qrFor', { name })}
        title={actions.onQr === null ? te('noLink') : te('qr')}
      >
        <QrCodeIcon aria-hidden />
      </Button>
      {actions.stats !== undefined && actions.stats.href === null ? (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-9 max-sm:hidden"
          onClick={actions.stats.onInspect}
          aria-label={te('statsFor', { name })}
          title={te('stats')}
        >
          <BarChart3Icon aria-hidden />
        </Button>
      ) : actions.stats !== undefined && actions.stats.href !== null ? (
        <Link
          href={actions.stats.href}
          onClick={(event) => {
            const stats = actions.stats;
            if (stats !== undefined && window.matchMedia(stats.media).matches) {
              event.preventDefault();
              stats.onInspect();
            }
          }}
          className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }), 'size-9 max-sm:hidden')}
          aria-label={te('statsFor', { name })}
          title={te('stats')}
        >
          <BarChart3Icon aria-hidden />
        </Link>
      ) : null}
      <Button
        type="button"
        size={labels === 'full' ? 'sm' : 'icon'}
        variant="outline"
        className={labels === 'full' ? 'h-9 max-2xl:w-9 max-2xl:px-0' : 'size-9'}
        onClick={actions.onEdit}
        aria-label={`${te('edit')} ${name}`}
        title={te('editEvent')}
      >
        <PencilIcon aria-hidden />
        {labels === 'full' ? <span className="max-2xl:sr-only">{te('edit')}</span> : null}
      </Button>
    </span>
  );
}

function Thumbnail({ file, small }: { file: DriveFile; small?: boolean }) {
  const t = useTranslations('drive');
  const src = file.thumbUrl ?? file.posterUrl;
  if (file.status === 'failed') {
    return (
      <FileWarningIcon
        className={cn('text-destructive', small ? 'size-5' : 'size-10')}
        aria-hidden
      />
    );
  }
  if (src === undefined) {
    return file.status === 'ready' ? (
      <ImageIcon
        className={cn('text-muted-foreground', small ? 'size-5' : 'size-10')}
        aria-hidden
      />
    ) : (
      <LoaderIcon
        className={cn('animate-spin text-muted-foreground', small ? 'size-4' : 'size-8')}
        aria-hidden
      />
    );
  }
  return (
    <>
      {/* A signed media URL: served by the storage/CDN, never resized by the web server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="absolute inset-0 size-full object-cover"
      />
      {file.mediaKind === 'video' ? (
        <span
          className={cn(
            'absolute rounded-full bg-black/60 text-white',
            small ? 'right-0.5 bottom-0.5 p-0.5' : 'right-1.5 bottom-1.5 p-1',
          )}
        >
          <PlayIcon className={small ? 'size-2.5' : 'size-3.5'} aria-label={t('video')} />
        </span>
      ) : null}
    </>
  );
}

export function ItemCard({
  item,
  selected,
  onToggleSelect,
  href,
  subtitle,
  actions,
  layout = 'grid',
  selectionMode = false,
  focusRequest,
  onPrimaryClick,
  onPreview,
  selectable = true,
  checkboxAlwaysVisible = false,
  eventActions,
}: ItemCardProps) {
  const formatBytes = useFormatBytes();
  const t = useTranslations('drive');
  const te = useTranslations('event');
  const event = item.kind === 'folder' && eventActions !== undefined ? item : null;
  const cover = event?.event?.coverThumbUrl ?? null;
  const format = useFormatter();
  const primary = useRef<HTMLAnchorElement & HTMLButtonElement>(null);
  const statusLine =
    item.kind === 'file' && item.status !== 'ready' ? t(`fileStatus.${item.status}`) : null;

  useEffect(() => {
    if (focusRequest !== undefined) primary.current?.focus();
  }, [focusRequest]);

  const list = layout === 'list';
  const visual = (
    <div
      className={cn(
        'relative flex shrink-0 items-center justify-center overflow-hidden bg-muted',
        list
          ? event !== null
            ? 'aspect-[2/3] w-12 rounded-lg sm:w-14'
            : 'size-10 rounded-md'
          : event !== null
            ? 'aspect-[2/3] w-full rounded-lg'
            : 'aspect-square w-full rounded-lg',
      )}
    >
      {cover !== null ? (
        // The cover's signed thumbnail (CDN), as for files.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={cover}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 size-full object-cover"
        />
      ) : item.kind === 'folder' ? (
        <FolderIcon
          className={cn('fill-primary/15 text-primary', list ? 'size-5' : 'size-14')}
          strokeWidth={1.5}
          aria-label={t('folder')}
        />
      ) : (
        <Thumbnail file={item} small={list} />
      )}
    </div>
  );

  function onKeyDown(event: KeyboardEvent) {
    if (onPreview === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    // Folders open with Enter (the link); Space shows details. Files: both show details.
    if (event.key === ' ' || (event.key === 'Enter' && href === null)) {
      event.preventDefault();
      onPreview();
    }
  }

  function onClick(event: MouseEvent) {
    if (onPrimaryClick !== undefined) onPrimaryClick(event);
    else if (href === null) onToggleSelect();
  }

  const focusRing =
    'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background';
  const primaryClass = cn(
    'block min-w-0 text-left',
    focusRing,
    list ? 'flex flex-1 items-center gap-3 rounded-md py-1' : 'w-full rounded-lg',
  );
  const created = format.dateTime(new Date(item.createdAt), { dateStyle: 'medium' });
  const content =
    list && event !== null ? (
      <>
        {visual}
        <span className="min-w-0 flex-1 space-y-1">
          <span
            className="block truncate font-display text-base font-semibold tracking-[-0.01em]"
            title={item.name}
          >
            {item.name}
          </span>
          <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <CalendarIcon className="size-3.5 shrink-0" aria-hidden />
            {created}
          </span>
        </span>
      </>
    ) : list ? (
      <>
        {visual}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium" title={item.name}>
            {item.name}
          </span>
          {(subtitle ?? statusLine) ? (
            <span className="block truncate text-xs text-muted-foreground">
              {subtitle ?? statusLine}
            </span>
          ) : null}
        </span>
        <span className="hidden w-28 shrink-0 text-xs text-muted-foreground md:block">
          {format.dateTime(new Date(item.createdAt), { dateStyle: 'medium' })}
        </span>
        <span className="hidden w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums sm:block">
          {item.kind === 'file' ? formatBytes(item.sizeBytes) : '—'}
        </span>
      </>
    ) : (
      visual
    );

  const primaryElement =
    href !== null ? (
      <Link
        ref={primary}
        href={href}
        className={primaryClass}
        onClick={onClick}
        onKeyDown={onKeyDown}
        data-item-id={item.id}
        draggable={false}
      >
        {content}
      </Link>
    ) : (
      <button
        ref={primary}
        type="button"
        className={primaryClass}
        onClick={onClick}
        onKeyDown={onKeyDown}
        aria-pressed={selected}
        aria-label={t('select', { name: item.name })}
        data-item-id={item.id}
      >
        {content}
      </button>
    );

  const checkbox = !selectable ? null : (
    // A 44 px touch target around the 20 px box.
    <label
      className={cn(
        'flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full transition-opacity',
        !list && 'absolute top-0.5 left-0.5',
        !selected &&
          !selectionMode &&
          !checkboxAlwaysVisible &&
          'lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 pointer-coarse:opacity-100',
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggleSelect}
        aria-label={t('select', { name: item.name })}
        className={cn(
          'shadow-sm',
          list
            ? 'border-2 border-input bg-background'
            : // Over a photo: a white box with a dark halo reads on light and dark pictures.
              'size-6 border-2 border-white bg-black/35 shadow-[0_0_0_1px_rgb(0_0_0/0.45),0_1px_4px_rgb(0_0_0/0.5)] data-[state=checked]:border-primary',
        )}
      />
    </label>
  );

  if (list && event !== null && eventActions !== undefined) {
    // The event row (ADR 0016, restyled by ADR 0024): cover, name and date, status and link chip,
    // then QR, stats, edit and the menu.
    const link = event.event?.link ?? null;
    return (
      <div
        className={cn(
          'group flex h-full items-center gap-2 rounded-2xl border p-2 pr-1.5 transition-[border-color,background-color,box-shadow] duration-150',
          selected
            ? 'border-primary bg-accent'
            : eventActions.inspected === true
              ? 'border-indigo-400/40 bg-surface shadow-featured'
              : 'border-border bg-surface hover:border-indigo-400/40 dark:border-white/5',
        )}
      >
        {checkbox}
        {primaryElement}
        <span className="hidden min-w-0 flex-col items-start gap-1.5 md:flex md:w-44 2xl:w-56">
          <EventStatusBadge folder={event} />
          {link !== null ? (
            <span className="flex max-w-full items-center gap-1 rounded-md bg-muted py-0.5 pr-0.5 pl-2 font-mono text-xs text-primary dark:bg-background/70 dark:text-cyan-300">
              <LinkIcon className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{link.path}</span>
              {eventActions.onCopyLink != null ? (
                <button
                  type="button"
                  onClick={eventActions.onCopyLink}
                  className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                  aria-label={te('copyLinkOf', { name: item.name })}
                  title={te('copyLink')}
                >
                  <CopyIcon className="size-3" aria-hidden />
                </button>
              ) : null}
            </span>
          ) : null}
        </span>
        <EventButtons name={item.name} actions={eventActions} labels="full" />
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
    );
  }

  if (list) {
    return (
      <div
        className={cn(
          'group flex h-full items-center gap-1 rounded-lg border pr-1 transition-colors duration-150',
          selected ? 'border-primary bg-accent' : 'border-transparent hover:bg-muted',
        )}
      >
        {checkbox}
        {primaryElement}
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group relative rounded-xl border bg-surface p-1.5 transition-[border-color,background-color,box-shadow] duration-200',
        selected
          ? 'border-primary bg-accent ring-1 ring-primary'
          : 'border-border hover:border-input/40 hover:shadow-card',
      )}
    >
      {primaryElement}
      {checkbox}
      {actions ? <div className="absolute top-1 right-1">{actions}</div> : null}
      {event !== null && eventActions !== undefined ? (
        // The event card (ADR 0016): name, created date, link status, QR and edit.
        <div className="space-y-1.5 px-1 pt-2 pb-0.5">
          <p className="truncate text-sm font-semibold" title={item.name}>
            {item.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {te('created', { date: created })}
          </p>
          <div className="flex items-center justify-between gap-1">
            <span className="min-w-0">
              <EventStatusBadge folder={event} />
            </span>
            <EventButtons name={item.name} actions={eventActions} labels="icon" />
          </div>
        </div>
      ) : (
        <div className="px-1 pt-2 pb-0.5">
          <p className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </p>
          <p className="truncate text-xs text-muted-foreground">{subtitle ?? statusLine ?? ' '}</p>
        </div>
      )}
    </div>
  );
}
