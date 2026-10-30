import { faceDeletions, faces, files } from '@shotx/db';
import { countDistinct, faceCollectionId } from '@shotx/face';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { deleteFacesInBatches } from '../faces';
import type { Logger } from '../logger';
import type { FacesDeps } from './deps';

export type DeleteFacesOutcome = 'missing' | 'already-done' | 'done';

/**
 * `delete.faces` ("ขอลบใบหน้าของฉัน"). The API has already marked the matched faces with the
 * deletion id (hiding them from search). The worker deletes them from the photographer's
 * collection, then in one transaction deletes their rows, recomputes `face_count` of the affected
 * files from their remaining faces (IoU de-duplication, as indexing does; 0 when none are left,
 * so the photo is not indexed again), sets `faces_withheld_at` on those files (migration 0009: never
 * indexed again, by any path), and completes the deletion with the number of rows deleted.
 *
 * Runs whatever FACE_SEARCH_ENABLED says (PDPA). Idempotent: a completed deletion is a no-op,
 * DeleteFaces ignores faces that are gone, and the rows and the completion commit together.
 */
export async function deleteRequestedFaces(
  deps: FacesDeps,
  deletionId: string,
  log: Logger,
): Promise<DeleteFacesOutcome> {
  const { db } = deps;
  const [deletion] = await db
    .select({
      photographerId: faceDeletions.photographerId,
      completedAt: faceDeletions.completedAt,
    })
    .from(faceDeletions)
    .where(eq(faceDeletions.id, deletionId));
  if (deletion === undefined) return 'missing';
  if (deletion.completedAt !== null) return 'already-done';

  const marked = await db
    .select({ id: faces.id, faceId: faces.rekognitionFaceId, fileId: faces.fileId })
    .from(faces)
    .where(and(eq(faces.deletionId, deletionId), eq(faces.ownerId, deletion.photographerId)));
  // ADR 0001: the collection comes from the deletion's photographer, read from the database.
  await deleteFacesInBatches(
    deps.provider,
    faceCollectionId(deletion.photographerId),
    marked.map((f) => f.faceId),
  );

  const deleted = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ completedAt: faceDeletions.completedAt })
      .from(faceDeletions)
      .where(eq(faceDeletions.id, deletionId))
      .for('update');
    if (locked === undefined || locked.completedAt !== null) return null;
    const fileIds = [...new Set(marked.map((f) => f.fileId))].sort();
    if (fileIds.length > 0) {
      await tx
        .select({ id: files.id })
        .from(files)
        .where(inArray(files.id, fileIds))
        .orderBy(files.id)
        .for('update');
    }
    const removed =
      marked.length === 0
        ? []
        : await tx
            .delete(faces)
            .where(
              and(
                eq(faces.deletionId, deletionId),
                inArray(
                  faces.id,
                  marked.map((f) => f.id),
                ),
              ),
            )
            .returning({ id: faces.id });
    if (fileIds.length > 0) {
      const remaining = await tx
        .select({ fileId: faces.fileId, bbox: faces.bbox })
        .from(faces)
        .where(inArray(faces.fileId, fileIds));
      for (const fileId of fileIds) {
        const boxes = remaining.filter((r) => r.fileId === fileId).map((r) => r.bbox);
        await tx
          .update(files)
          .set({ faceCount: countDistinct(boxes, deps.face.index.dedupeIou) })
          .where(and(eq(files.id, fileId), isNotNull(files.faceCount)));
      }
    }
    if (fileIds.length > 0) {
      // PDPA (migration 0009): these photos are never indexed again, by any path.
      await tx
        .update(files)
        .set({ facesWithheldAt: sql`now()` })
        .where(and(inArray(files.id, fileIds), isNull(files.facesWithheldAt)));
    }
    await tx
      .update(faceDeletions)
      .set({ facesDeleted: removed.length, completedAt: sql`now()` })
      .where(eq(faceDeletions.id, deletionId));
    return removed.length;
  });
  if (deleted === null) return 'already-done';
  const withheldFileIds = [...new Set(marked.map((f) => f.fileId))].sort();
  log.info('face deletion done', {
    deletionId,
    photographerId: deletion.photographerId,
    facesDeleted: deleted,
    files: withheldFileIds.length,
    // File ids only (no biometrics), comma-separated: after a database restore these photos must
    // be withheld again before re-indexing (deploy/RESTORE.md; ADR 0009 section 6).
    withheldFileIds: withheldFileIds.join(','),
  });
  return 'done';
}
