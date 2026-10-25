'use client';

import type { DriveFile, DriveItem } from '@shotx/shared';
import { Checkbox, cn } from '@shotx/ui';
import { FileWarningIcon, FolderIcon, ImageIcon, LoaderIcon, PlayIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

export interface ItemCardProps {
  item: DriveItem;
  selected: boolean;
  onToggleSelect: () => void;
  /** Folders open on click (the drive); null in the trash. */
  href: string | null;
  /** Second line, e.g. the purge date in the trash. */
  subtitle?: ReactNode;
  actions?: ReactNode;
}

function Thumbnail({ file }: { file: DriveFile }) {
  const t = useTranslations('drive');
  const src = file.thumbUrl ?? file.posterUrl;
  if (file.status === 'failed') {
    return <FileWarningIcon className="size-10 text-destructive" aria-hidden />;
  }
  if (src === undefined) {
    return file.status === 'ready' ? (
      <ImageIcon className="size-10 text-muted-foreground" aria-hidden />
    ) : (
      <LoaderIcon className="size-8 animate-spin text-muted-foreground" aria-hidden />
    );
  }
  return (
    <>
      {/* Signed CloudFront URL under /media: served by the CDN, never resized by the web server. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover"
      />
      {file.mediaKind === 'video' ? (
        <span className="absolute right-1.5 bottom-1.5 rounded-full bg-black/60 p-1 text-white">
          <PlayIcon className="size-3.5" aria-label={t('video')} />
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
}: ItemCardProps) {
  const t = useTranslations('drive');
  const statusLine =
    item.kind === 'file' && item.status !== 'ready' ? t(`fileStatus.${item.status}`) : null;

  const visual = (
    <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-muted">
      {item.kind === 'folder' ? (
        <FolderIcon className="size-14 text-amber-500" aria-label={t('folder')} />
      ) : (
        <Thumbnail file={item} />
      )}
    </div>
  );

  return (
    <div
      className={cn(
        'group relative rounded-xl p-1 transition-colors',
        selected ? 'bg-primary/10 ring-2 ring-primary' : 'hover:bg-accent',
      )}
    >
      {href !== null ? (
        <Link href={href} className="block rounded-lg focus-visible:ring-2 focus-visible:ring-ring">
          {visual}
        </Link>
      ) : (
        <button
          type="button"
          className="block w-full rounded-lg"
          onClick={onToggleSelect}
          aria-pressed={selected}
          aria-label={t('select', { name: item.name })}
        >
          {visual}
        </button>
      )}
      <div className="absolute top-2.5 left-2.5">
        <Checkbox
          checked={selected}
          onCheckedChange={onToggleSelect}
          aria-label={t('select', { name: item.name })}
          className="bg-background/90"
        />
      </div>
      {actions ? <div className="absolute top-1.5 right-1.5">{actions}</div> : null}
      <div className="px-1 pt-1.5">
        <p className="truncate text-sm font-medium" title={item.name}>
          {item.name}
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {subtitle ?? statusLine ?? '\u00A0'}
        </p>
      </div>
    </div>
  );
}
