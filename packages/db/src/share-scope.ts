import type { ShareTargetType } from '@shotx/shared';
import { and, eq, isNull, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { faces, files } from './schema/index';

/**
 * SQL forms of the share-scope rules in @shotx/shared (share/scope.ts). They must agree with
 * `isFileInShareScope`, `isCoveredByFaceIndex` and `faceSearchUnavailableReason`; the
 * integration tests check them against PostgreSQL. Every value comes from the server: the share
 * row and the database's own folder paths, never ids or paths sent by the client.
 */

export interface ShareScopeTarget {
  ownerId: string;
  targetType: ShareTargetType;
  targetFileId: string | null;
  targetFolderId: string | null;
}

/**
 * Condition on `files` (unaliased, as in `db.select().from(files)`): the file is served by the
 * share. Ready, live and the owner's; for a file share the file itself, for a folder share in a
 * folder whose path is inside the share root's current path (`folder.path <@ root.path`), with the
 * root live. Add the face_only grant (`files.id = ANY(...)`) separately.
 */
export function fileInShareScopeSql(share: ShareScopeTarget): SQL {
  const live = and(
    eq(files.ownerId, share.ownerId),
    eq(files.status, 'ready'),
    isNull(files.deletedAt),
    isNull(files.purgeRequestedAt),
  ) as SQL;
  if (share.targetType === 'file') {
    if (share.targetFileId === null) throw new RangeError('A file share needs targetFileId');
    return and(live, eq(files.id, share.targetFileId)) as SQL;
  }
  if (share.targetFolderId === null) throw new RangeError('A folder share needs targetFolderId');
  return and(
    live,
    sql`EXISTS (
      SELECT 1 FROM "folders" AS "scope_folder"
      JOIN "folders" AS "scope_root"
        ON "scope_root"."id" = ${share.targetFolderId}
        AND "scope_root"."owner_id" = ${share.ownerId}
        AND "scope_root"."deleted_at" IS NULL
        AND "scope_root"."purge_requested_at" IS NULL
      WHERE "scope_folder"."id" = ${files.folderId}
        AND "scope_folder"."owner_id" = ${files.ownerId}
        AND "scope_folder"."path" <@ "scope_root"."path"
    )`,
  ) as SQL;
}

/**
 * True when an active face index covers a folder path: some live folder of `ownerId` with
 * `face_index_enabled` and `face_index_expires_at > now` is the folder or an ancestor
 * (`path @> folderPath`). Pass e.g. a joined folder's `path` column and `files.owner_id`.
 */
export function coveredByFaceIndexSql(
  folderPath: AnyPgColumn | SQL,
  ownerId: AnyPgColumn | SQL | string,
  now: Date,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM "folders" AS "index_folder"
    WHERE "index_folder"."owner_id" = ${ownerId}
      AND "index_folder"."face_index_enabled"
      AND "index_folder"."face_index_expires_at" > ${now.toISOString()}::timestamptz
      AND "index_folder"."deleted_at" IS NULL
      AND "index_folder"."path" @> ${folderPath}
  )`;
}

/**
 * Face search can run on a folder share: some live folder with an active face index is the root,
 * above it, or inside it. (FACE_SEARCH_ENABLED and the share type are checked in code.)
 */
export function shareFaceSearchAvailableSql(
  share: { ownerId: string; targetFolderId: string },
  now: Date,
): SQL {
  return sql`EXISTS (
    SELECT 1 FROM "folders" AS "share_root"
    JOIN "folders" AS "index_folder"
      ON "index_folder"."owner_id" = "share_root"."owner_id"
      AND "index_folder"."face_index_enabled"
      AND "index_folder"."face_index_expires_at" > ${now.toISOString()}::timestamptz
      AND "index_folder"."deleted_at" IS NULL
      AND ("index_folder"."path" @> "share_root"."path" OR "index_folder"."path" <@ "share_root"."path")
    WHERE "share_root"."id" = ${share.targetFolderId}
      AND "share_root"."owner_id" = ${share.ownerId}
  )`;
}

/**
 * Condition on `faces`: the face may appear in search results (no "ขอลบใบหน้าของฉัน" request has
 * matched it). Face search maps Rekognition matches to rows with
 * `rekognition_face_id = ANY($ids) AND owner_id = $shareOwner AND searchableFaceSql()`.
 */
export function searchableFaceSql(): SQL {
  return isNull(faces.deletionId);
}
