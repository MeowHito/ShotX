'use client';

import type { DriveItem } from '@shotx/shared';
import { Sheet, SheetContent, SheetDescription, SheetTitle, Skeleton } from '@shotx/ui';
import { FolderIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { useItemInfo } from '@/lib/drive/queries';
import { useFormatBytes } from '@/lib/i18n/use-format';

/**
 * The right-hand details panel of a file or folder: size, type, dimensions, dates, and the
 * location from GET /drive/files/:id; for a folder, its summary from GET /drive/folders/:id/summary
 * (files, photos, videos, subfolders, total size).
 */
export function DetailsPanel({
  item,
  location: fallbackLocation,
  onOpenChange,
}: {
  item: DriveItem | null;
  /** Shown until the API's location arrives (the folder being browsed). */
  location?: string;
  onOpenChange: (open: boolean) => void;
}) {
  const formatBytes = useFormatBytes();
  const t = useTranslations();
  const format = useFormatter();
  const info = useItemInfo(item === null ? null : { kind: item.kind, id: item.id });
  const ancestors = item?.kind === 'file' ? info.file.data?.ancestors : info.folder.data?.ancestors;
  const location =
    ancestors !== undefined
      ? [t('drive.root'), ...ancestors.map((a) => a.name)].join(' › ')
      : (fallbackLocation ?? t('details.unknown'));
  const summary = item?.kind === 'folder' ? info.folder.data : undefined;
  const date = (iso: string | null) =>
    iso === null
      ? t('details.unknown')
      : format.dateTime(new Date(iso), { dateStyle: 'long', timeStyle: 'short' });

  const rows: [string, ReactNode][] = [];
  if (item !== null) {
    if (item.kind === 'folder') {
      rows.push([t('details.type'), t('details.kinds.folder')]);
      rows.push([t('details.created'), date(item.createdAt)]);
      rows.push([t('details.location'), location]);
      if (summary !== undefined) {
        rows.push([
          t('details.contents'),
          t('details.contentsValue', {
            files: summary.fileCount,
            images: summary.imageCount,
            videos: summary.videoCount,
          }),
        ]);
        rows.push([t('details.subfolders'), format.number(summary.folderCount)]);
        rows.push([t('details.totalSize'), formatBytes(summary.totalBytes)]);
      }
    } else {
      rows.push([t('details.type'), `${t(`details.kinds.${item.mediaKind}`)} · ${item.mime}`]);
      rows.push([t('details.size'), formatBytes(item.sizeBytes)]);
      rows.push([
        t('details.dimensions'),
        item.width !== null && item.height !== null
          ? t('details.dimensionsValue', { width: item.width, height: item.height })
          : t('details.unknown'),
      ]);
      rows.push([t('details.taken'), date(item.takenAt)]);
      rows.push([t('details.uploaded'), date(item.createdAt)]);
      rows.push([t('details.location'), location]);
      if (item.faceCount !== null) rows.push([t('details.faces'), format.number(item.faceCount)]);
      if (item.status !== 'ready')
        rows.push([t('details.status'), t(`drive.fileStatus.${item.status}`)]);
    }
  }

  const preview = item?.kind === 'file' ? (item.thumbUrl ?? item.posterUrl) : undefined;

  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent side="right" closeLabel={t('common.close')}>
        <div className="space-y-1 pr-10">
          <SheetDescription className="text-xs font-medium text-muted-foreground">
            {t('details.title')}
          </SheetDescription>
          <SheetTitle className="text-lg leading-snug font-semibold break-words">
            {item?.name}
          </SheetTitle>
        </div>
        <div className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-xl bg-muted">
          {preview !== undefined ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="" className="absolute inset-0 size-full object-cover" />
          ) : (
            <FolderIcon
              className="size-16 fill-primary/15 text-primary"
              strokeWidth={1.5}
              aria-hidden
            />
          )}
        </div>
        <dl className="space-y-3">
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-sm break-words">{value}</dd>
            </div>
          ))}
        </dl>
        {item?.kind === 'folder' && info.folder.isPending ? (
          <div className="space-y-2" role="status" aria-label={t('common.loading')}>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
