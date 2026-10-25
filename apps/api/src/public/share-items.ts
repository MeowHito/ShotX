import { type DriveFile as DriveFileRow, fileInShareScopeSql, files } from '@shotx/db';
import type { ShareItem } from '@shotx/shared';
import { and, inArray, isNotNull, type SQL } from 'drizzle-orm';
import type { Queryable } from '../db/db';
import { mediaKindOf } from '../drive/media-urls';
import type { SignedUrls } from '../media/signed-urls';
import type { LoadedShare } from '../share/share-access';

/** Columns a share item needs. */
export const shareItemColumns = {
  id: files.id,
  name: files.name,
  mime: files.mime,
  width: files.width,
  height: files.height,
  takenAt: files.takenAt,
  thumbKey: files.thumbKey,
  previewKey: files.previewKey,
  posterKey: files.posterKey,
} as const;

export type ShareItemRow = Pick<
  DriveFileRow,
  'id' | 'name' | 'mime' | 'width' | 'height' | 'takenAt' | 'thumbKey' | 'previewKey' | 'posterKey'
>;

/**
 * `files` condition of everything a share may show: fileInShareScopeSql (ready, live, the owner's,
 * inside the share root's current path) plus derivatives to show. The face_only grant is added by
 * the caller.
 */
export function shareItemsScope(share: LoadedShare): SQL {
  return and(
    fileInShareScopeSql(share),
    isNotNull(files.thumbKey),
    isNotNull(files.previewKey),
  ) as SQL;
}

/** Ready in-scope rows of the given ids (in no particular order). */
export async function scopedItemRows(
  q: Queryable,
  share: LoadedShare,
  ids: readonly string[],
): Promise<ShareItemRow[]> {
  if (ids.length === 0) return [];
  return q
    .select(shareItemColumns)
    .from(files)
    .where(and(shareItemsScope(share), inArray(files.id, [...ids])));
}

/** A share item with signed view URLs (one bucketed expiry for the whole response). */
export function toShareItem(row: ShareItemRow, urls: SignedUrls, expiresAt: Date): ShareItem {
  if (row.thumbKey === null || row.previewKey === null) {
    throw new Error('Share items need thumb and preview derivatives');
  }
  const item: ShareItem = {
    id: row.id,
    name: row.name,
    mediaKind: mediaKindOf(row.mime),
    width: row.width,
    height: row.height,
    takenAt: row.takenAt === null ? null : row.takenAt.toISOString(),
    thumbUrl: urls.view(row.thumbKey, expiresAt),
    previewUrl: urls.view(row.previewKey, expiresAt),
    urlsExpireAt: expiresAt.toISOString(),
  };
  if (row.posterKey !== null) item.posterUrl = urls.view(row.posterKey, expiresAt);
  return item;
}
