'use client';

import type { DriveFile, DriveItem } from '@shotx/shared';
import { Checkbox, cn } from '@shotx/ui';
import { FileWarningIcon, FolderIcon, ImageIcon, LoaderIcon, PlayIcon } from 'lucide-react';
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
}: ItemCardProps) {
  const formatBytes = useFormatBytes();
  const t = useTranslations('drive');
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
        list ? 'size-10 rounded-md' : 'aspect-square w-full rounded-lg',
      )}
    >
      {item.kind === 'folder' ? (
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
  const content = list ? (
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
      <div className="px-1 pt-2 pb-0.5">
        <p className="truncate text-sm font-medium" title={item.name}>
          {item.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">{subtitle ?? statusLine ?? ' '}</p>
      </div>
    </div>
  );
}
