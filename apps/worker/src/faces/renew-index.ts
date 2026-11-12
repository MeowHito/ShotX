import { folders } from '@shotx/db';
import { sql } from 'drizzle-orm';
import { type Db, rows } from '../db';

/**
 * ADR 0011 decision 1 (face indexing always on): moves `face_index_expires_at` of the enabled
 * folders covering a file (its folder and every ancestor) to at least the file's upload time
 * (`created_at`) + FACE_INDEX_EXPIRY_DAYS, also when that expiry has already passed, so an upload
 * into an old event folder is indexed instead of skipped as "not covered" (spec: the index expires
 * last upload + 90 days).
 *
 * - Never shortens an expiry, and never touches a folder whose indexing is off (the photographer's
 *   opt-out), trashed or purge-requested.
 * - Only for a live file (not trashed, not purge-requested) in a folder: files at the drive root
 *   have no folder, so nothing covers them and they are never indexed.
 * - An old file (e.g. a re-index long after upload) renews to its own upload + N days, which may
 *   still be in the past: it never revives an index that has no recent upload.
 * - Idempotent (GREATEST, and rows already far enough out are not written), so at-least-once
 *   redeliveries change nothing. Runs in the caller's transaction when given one.
 *
 * Returns the ids of the folders it moved.
 */
export async function renewCoveringFaceIndexes(
  db: Db,
  fileId: string,
  expiryDays: number,
): Promise<string[]> {
  const renewed = await rows<{ id: string }>(
    db,
    sql`UPDATE ${folders} AS "ix" SET "face_index_expires_at" = GREATEST(
        "ix"."face_index_expires_at",
        "f"."created_at" + make_interval(days => ${expiryDays})
      )
      FROM "files" AS "f"
      JOIN "folders" AS "own" ON "own"."id" = "f"."folder_id" AND "own"."owner_id" = "f"."owner_id"
      WHERE "f"."id" = ${fileId}
        AND "f"."deleted_at" IS NULL
        AND "f"."purge_requested_at" IS NULL
        AND "ix"."owner_id" = "f"."owner_id"
        AND "ix"."face_index_enabled"
        AND "ix"."deleted_at" IS NULL
        AND "ix"."purge_requested_at" IS NULL
        AND "ix"."path" @> "own"."path"
        AND ("ix"."face_index_expires_at" IS NULL
          OR "ix"."face_index_expires_at" < "f"."created_at" + make_interval(days => ${expiryDays}))
      RETURNING "ix"."id" AS "id"`,
  );
  return renewed.map((r) => r.id);
}
