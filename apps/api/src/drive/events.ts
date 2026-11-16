import { shares } from '@shotx/db';
import { type DriveFolder, ownerShareStatus, sharePublicPath, sharePublicUrl } from '@shotx/shared';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { type Queryable, rows } from '../db/db';
import { designAssetWebKey } from '../designs/design-views';
import type { SignedUrls } from '../media/signed-urls';

export type DriveEvent = NonNullable<DriveFolder['event']>;

/**
 * The event view of folders (ADR 0016), for a drive listing page: each folder's cover thumbnail
 * and its link. Two queries for the whole page, whatever its size.
 *
 * - Cover: the uploaded cover (ADR 0028) while its design image is `ready`, else the folder's
 *   chosen cover while it is still a live, ready image in the folder's
 *   subtree, else the first such image in share-page order (taken_at, else created_at), as the
 *   share page picks its cover (ADR 0011). Null when the event has no ready image yet.
 * - Link: the newest share of the folder that isn't revoked (active, paused or expired), with its
 *   owner-facing status; null when the folder has none.
 */
export async function eventsOf(
  q: Queryable,
  ownerId: string,
  folderIds: readonly string[],
  deps: { urls: SignedUrls; publicBaseUrl: string; now: Date; expiresAt: Date },
): Promise<Map<string, DriveEvent>> {
  const out = new Map<string, DriveEvent>();
  if (folderIds.length === 0) return out;
  const ids = sql.join(
    folderIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const covers = await rows<{
    folder_id: string;
    thumb_key: string | null;
    cover_asset_id: string | null;
  }>(
    q,
    sql`SELECT f.id AS folder_id, c.thumb_key, a.id AS cover_asset_id
        FROM folders f
        LEFT JOIN design_assets a
          ON a.id = f.cover_asset_id AND a.owner_id = f.owner_id
          AND a.status = 'ready' AND a.purge_requested_at IS NULL
        LEFT JOIN LATERAL (
          SELECT x.thumb_key
          FROM files x
          JOIN folders xf ON xf.id = x.folder_id AND xf.owner_id = x.owner_id
          WHERE x.owner_id = f.owner_id
            AND xf.path <@ f.path
            AND xf.deleted_at IS NULL
            AND x.deleted_at IS NULL
            AND x.purge_requested_at IS NULL
            AND x.status = 'ready'
            AND x.mime LIKE 'image/%'
            AND x.thumb_key IS NOT NULL
          ORDER BY (x.id = f.cover_file_id) DESC NULLS LAST,
                   coalesce(x.taken_at, x.created_at), x.id
          LIMIT 1
        ) c ON true
        WHERE f.owner_id = ${ownerId}::uuid AND f.id IN (${ids})`,
  );
  const links = await q
    .select()
    .from(shares)
    .where(
      and(
        eq(shares.ownerId, ownerId),
        eq(shares.targetType, 'folder'),
        inArray(shares.targetFolderId, [...folderIds]),
        eq(shares.isActive, true),
      ),
    )
    .orderBy(desc(shares.createdAt), desc(shares.id));
  const newest = new Map<string, (typeof links)[number]>();
  for (const share of links) {
    if (share.targetFolderId !== null && !newest.has(share.targetFolderId)) {
      newest.set(share.targetFolderId, share);
    }
  }
  for (const row of covers) {
    const share = newest.get(row.folder_id);
    out.set(row.folder_id, {
      coverThumbUrl:
        row.cover_asset_id !== null
          ? deps.urls.view(designAssetWebKey({ ownerId, id: row.cover_asset_id }), deps.expiresAt)
          : row.thumb_key === null
            ? null
            : deps.urls.view(row.thumb_key, deps.expiresAt),
      link:
        share === undefined
          ? null
          : {
              shareId: share.id,
              status: ownerShareStatus(share, deps.now),
              path: sharePublicPath(share),
              url: sharePublicUrl(deps.publicBaseUrl, share),
            },
    });
  }
  return out;
}
