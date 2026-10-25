import { coveredByFaceIndexSql, faces, files } from '@shotx/db';
import { faceCollectionId } from '@shotx/face';
import { and, inArray, sql } from 'drizzle-orm';
import { type Db, rows } from '../db';
import { deleteFacesInBatches, type FaceDeleter } from '../faces';
import { groupBy } from '../jobs/context';
import { errorFields, type Logger } from '../logger';

/** A folder subtree (`unindex.folder`); without one, every photographer's files (expiry). */
export interface FolderScope {
  ownerId: string;
  /** The folder's current ltree path, read from the database. */
  path: string;
}

export interface UncoveredFacesContext {
  db: Db;
  faces: FaceDeleter;
  log: Logger;
  now: () => number;
  batchSize: number;
  /** False when no new batch may start (deadline); throws when the work was aborted. */
  mayContinue: () => boolean;
}

export interface UncoveredFacesResult {
  /** Faces deleted from collections and from `faces`. */
  facesDeleted: number;
  /** Files whose last face went (face_count set to null: not indexed). */
  filesCleared: number;
  /** Faces kept because DeleteFaces failed; the next run or retry deletes them. */
  facesKept: number;
  /** False when the deadline stopped the work early. */
  complete: boolean;
}

type UncoveredFace = {
  id: string;
  face_id: string;
  file_id: string;
  owner_id: string;
};

/**
 * Deletes the faces of files that no active face index covers any more (isCoveredByFaceIndex: no
 * live folder at or above the file's folder has face indexing enabled and unexpired; files at the
 * drive root are never covered). For each batch: DeleteFaces on the owner's collection (the
 * collection id comes from the faces' `owner_id`, ADR 0001), then the rows, then `face_count =
 * null` on files left without faces, so turning the index back on indexes them again.
 *
 * Used by `faces.expire.daily` (every photographer) and `unindex.folder` (one folder subtree).
 * It always runs, whatever FACE_SEARCH_ENABLED says: deleting biometric data is a PDPA duty.
 *
 * Idempotent: DeleteFaces ignores ids that are gone, rows are deleted by id after their faces,
 * and a crash in between leaves rows that the next run deletes again (a no-op in Rekognition).
 * Files that are covered again by the time of the row delete still lose the rows of the faces
 * that were deleted, because those faces no longer exist; their face_count goes back to null.
 */
export async function deleteUncoveredFaces(
  ctx: UncoveredFacesContext,
  scope?: FolderScope,
): Promise<UncoveredFacesResult> {
  const result: UncoveredFacesResult = {
    facesDeleted: 0,
    filesCleared: 0,
    facesKept: 0,
    complete: true,
  };
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    if (!ctx.mayContinue()) {
      result.complete = false;
      break;
    }
    const now = new Date(ctx.now());
    const scoped =
      scope === undefined
        ? sql`TRUE`
        : sql`"fa"."owner_id" = ${scope.ownerId} AND "fo"."path" <@ ${scope.path}::ltree`;
    const batch = await rows<UncoveredFace>(
      ctx.db,
      sql`SELECT "fa"."id", "fa"."rekognition_face_id" AS "face_id", "fa"."file_id", "fa"."owner_id"
        FROM ${faces} AS "fa"
        JOIN ${files} AS "f" ON "f"."id" = "fa"."file_id" AND "f"."owner_id" = "fa"."owner_id"
        LEFT JOIN "folders" AS "fo" ON "fo"."id" = "f"."folder_id" AND "fo"."owner_id" = "f"."owner_id"
        WHERE "fa"."id" > ${cursor}
          AND ${scoped}
          AND ("fo"."id" IS NULL OR NOT ${coveredByFaceIndexSql(sql`"fo"."path"`, sql`"f"."owner_id"`, now)})
        ORDER BY "fa"."id"
        LIMIT ${ctx.batchSize}`,
    );
    if (batch.length === 0) break;
    cursor = batch.at(-1)!.id;

    for (const [ownerId, owned] of groupBy(batch, (r) => r.owner_id)) {
      try {
        await deleteFacesInBatches(
          ctx.faces,
          faceCollectionId(ownerId),
          owned.map((r) => r.face_id),
        );
      } catch (error) {
        ctx.log.warn('DeleteFaces failed; keeping the faces for the next run', {
          ...errorFields(error),
          photographerId: ownerId,
          faces: owned.length,
        });
        result.facesKept += owned.length;
        continue;
      }
      const cleared = await removeFaceRows(
        ctx.db,
        owned.map((r) => r.id),
        [...new Set(owned.map((r) => r.file_id))],
      );
      result.facesDeleted += owned.length;
      result.filesCleared += cleared;
    }
  }
  return result;
}

/**
 * Deletes face rows by id and sets `face_count = null` on the files left without faces, in one
 * transaction. Locks the files first (the order indexing commits use), so a concurrent commit
 * either finishes before or sees the rows gone. Returns the number of files cleared.
 */
export async function removeFaceRows(
  db: Db,
  faceRowIds: readonly string[],
  fileIds: readonly string[],
): Promise<number> {
  if (faceRowIds.length === 0) return 0;
  return db.transaction(async (tx) => {
    const sorted = [...fileIds].sort();
    await tx
      .select({ id: files.id })
      .from(files)
      .where(inArray(files.id, sorted))
      .orderBy(files.id)
      .for('update');
    await tx.delete(faces).where(inArray(faces.id, [...faceRowIds]));
    const cleared = await tx
      .update(files)
      .set({ faceCount: null })
      .where(
        and(
          inArray(files.id, sorted),
          sql`${files.faceCount} IS NOT NULL`,
          sql`NOT EXISTS (SELECT 1 FROM ${faces} WHERE ${faces.fileId} = ${files.id})`,
        ),
      )
      .returning({ id: files.id });
    return cleared.length;
  });
}
