'use client';

import type { DriveFile, DriveFolder, DriveItem } from '@shotx/shared';
import { Button, Checkbox, cn } from '@shotx/ui';
import {
  FileWarningIcon,
  FolderIcon,
  ImageIcon,
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
  /** Show the selection checkbox (false on search and recent lists). */
  selectable?: boolean;
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
        className="size-9"
        disabled={actions.onQr === null}
        onClick={() => actions.onQr?.()}
        aria-label={te('qrFor', { name })}
        title={actions.onQr === null ? te('noLink') : te('qr')}
      >
        <QrCodeIcon aria-hidden />
      </Button>
      <Button
        type="button"
        size={labels === 'full' ? 'sm' : 'icon'}
        variant="outline"
        className={labels === 'full' ? 'h-9' : 'size-9'}
        onClick={actions.onEdit}
        aria-label={`${te('edit')} ${name}`}
        title={te('editEvent')}
      >
        <PencilIcon aria-hidden />
        {labels === 'full' ? <span className="max-sm:sr-only">{te('edit')}</span> : null}
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
            ? 'size-12 rounded-lg'
            : 'size-10 rounded-md'
          : event !== null
            ? 'aspect-[4/3] w-full rounded-lg'
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
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold" title={item.name}>
            {item.name}
          </span>
          <span className="block truncate font-mono text-xs text-muted-foreground">
            {event.event?.link?.path ?? te('status.none')}
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
          'lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 pointer-coarse:opacity-100',
      )}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={onToggleSelect}
        aria-label={t('select', { name: item.name })}
        className="bg-background/90 shadow-sm"
      />
    </label>
  );

  if (list && event !== null && eventActions !== undefined) {
    // The event row (ADR 0016): name and link path, created date, status, QR, edit, menu.
    return (
      <div
        className={cn(
          'group flex h-full items-center gap-1 rounded-xl border pr-1 transition-colors duration-150',
          selected ? 'border-primary bg-accent' : 'border-border bg-surface hover:bg-muted',
        )}
      >
        {checkbox}
        {primaryElement}
        <span className="hidden w-32 shrink-0 text-sm text-muted-foreground tabular-nums md:block">
          {created}
        </span>
        <span className="hidden w-36 shrink-0 sm:block">
          <EventStatusBadge folder={event} />
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
