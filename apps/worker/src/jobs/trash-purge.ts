import { consents, faces, files, folders, shares } from '@shotx/db';
import { faceCollectionId } from '@shotx/face';
import { derivedKeys, fileQuotaBucket } from '@shotx/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { type Db, rows } from '../db';
import { deleteFacesInBatches } from '../faces';
import { errorFields } from '../logger';
import { applyQuotaMove, releaseMoveFor } from '../quota';
import { groupBy, type JobContext, mayContinue } from './context';

export interface TrashPurgeResult {
  /** Trashed folders (with their subtrees) and files whose purge this run requested. */
  foldersRequested: number;
  filesRequested: number;
  /** Rows deleted, with their objects. */
  filesPurged: number;
  foldersPurged: number;
  /** Purge-requested files kept for the next run (DeleteFaces or S3 failed). */
  filesSkipped: number;
  /** Purge-requested folders still holding live content (left in place). */
  foldersBlocked: number;
  /** False when the deadline stopped the run early. */
  complete: boolean;
}

interface QuotaRow {
  id: string;
  ownerId: string;
  sizeBytes: number;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  verifiedAt: Date | null;
  purgeRequestedAt: Date | null;
}

const quotaColumns = {
  id: files.id,
  ownerId: files.ownerId,
  sizeBytes: files.sizeBytes,
  status: files.status,
  verifiedAt: files.verifiedAt,
  purgeRequestedAt: files.purgeRequestedAt,
};

/**
 * Takes locked file rows out of the quota (each from its own bucket) and marks them
 * purge-requested, in the caller's transaction. This is the "purge requested" transition of
 * drive/quota: after it the rows count nowhere, so the later row deletion moves nothing.
 */
async function requestPurge(tx: Db, ownerId: string, locked: QuotaRow[], ctx: JobContext) {
  let used = 0;
  let reserved = 0;
  for (const row of locked) {
    const move = releaseMoveFor(fileQuotaBucket(row));
    if (move === 'releaseUsed') used += row.sizeBytes;
    else if (move === 'releaseReserved') reserved += row.sizeBytes;
  }
  if (used > 0) await applyQuotaMove(tx, ownerId, 'releaseUsed', used, ctx.log);
  if (reserved > 0) await applyQuotaMove(tx, ownerId, 'releaseReserved', reserved, ctx.log);
  if (locked.length > 0) {
    await tx
      .update(files)
      .set({ purgeRequestedAt: sql`now()` })
      .where(
        inArray(
          files.id,
          locked.map((r) => r.id),
        ),
      );
  }
}

/** Step 1a: trashed folders past retention, with their whole trashed subtree. */
async function requestExpiredFolders(ctx: JobContext, cutoff: Date): Promise<number> {
  let requested = 0;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: folders.id })
      .from(folders)
      .where(
        and(
          lt(folders.deletedAt, cutoff),
          isNull(folders.trashedViaFolderId),
          isNull(folders.purgeRequestedAt),
        ),
      )
      .orderBy(asc(folders.deletedAt), asc(folders.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    let progressed = 0;
    for (const { id } of batch) {
      const done = await ctx.db.transaction(async (tx) => {
        // Re-check under lock: the folder may have been restored meanwhile.
        const [folder] = await tx
          .select({ ownerId: folders.ownerId, path: sql<string>`${folders.path}::text` })
          .from(folders)
          .where(
            and(
              eq(folders.id, id),
              lt(folders.deletedAt, cutoff),
              isNull(folders.trashedViaFolderId),
              isNull(folders.purgeRequestedAt),
            ),
          )
          .for('update');
        if (folder === undefined) return false;
        const subtree = sql`(SELECT ${folders.id} FROM ${folders} WHERE ${folders.ownerId} = ${folder.ownerId} AND ${folders.path} <@ ${folder.path}::ltree)`;
        // Every trashed file below it: what it took to the trash, and what was trashed on its own
        // earlier (that can't outlive its folder).
        const locked = await tx
          .select(quotaColumns)
          .from(files)
          .where(
            and(
              eq(files.ownerId, folder.ownerId),
              isNotNull(files.deletedAt),
              isNull(files.purgeRequestedAt),
              sql`${files.folderId} IN ${subtree}`,
            ),
          )
          .orderBy(asc(files.id))
          .for('update');
        await requestPurge(tx, folder.ownerId, locked, ctx);
        await tx
          .update(folders)
          .set({ purgeRequestedAt: sql`now()` })
          .where(
            and(
              eq(folders.ownerId, folder.ownerId),
              sql`${folders.path} <@ ${folder.path}::ltree`,
              isNotNull(folders.deletedAt),
              isNull(folders.purgeRequestedAt),
            ),
          );
        return true;
      });
      if (done) progressed++;
    }
    requested += progressed;
    if (progressed === 0) break;
  }
  return requested;
}

/** Step 1b: files trashed on their own past retention. */
async function requestExpiredFiles(ctx: JobContext, cutoff: Date): Promise<number> {
  const expired = and(
    lt(files.deletedAt, cutoff),
    isNull(files.trashedViaFolderId),
    isNull(files.purgeRequestedAt),
  );
  let requested = 0;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: files.id, ownerId: files.ownerId })
      .from(files)
      .where(expired)
      .orderBy(asc(files.ownerId), asc(files.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    const byOwner = groupBy(batch, (r) => r.ownerId);
    let progressed = 0;
    for (const [ownerId, owned] of byOwner) {
      progressed += await ctx.db.transaction(async (tx) => {
        const locked = await tx
          .select(quotaColumns)
          .from(files)
          .where(
            and(
              expired,
              inArray(
                files.id,
                owned.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(files.id))
          .for('update');
        await requestPurge(tx, ownerId, locked, ctx);
        return locked.length;
      });
    }
    requested += progressed;
    if (progressed === 0) break;
  }
  return requested;
}

interface PurgeFile {
  id: string;
  ownerId: string;
  s3Key: string;
  uploadId: string | null;
}

/** Deletes shares (and their consents) pointing at the rows, before the rows (FK RESTRICT). */
async function deleteSharesOf(tx: Db, target: 'file' | 'folder', ids: string[]): Promise<number> {
  const column = target === 'file' ? shares.targetFileId : shares.targetFolderId;
  const doomed = await tx.select({ id: shares.id }).from(shares).where(inArray(column, ids));
  if (doomed.length === 0) return 0;
  const shareIds = doomed.map((s) => s.id);
  // zip_jobs (and their entries) and face_feedback cascade from shares.
  await tx.delete(consents).where(inArray(consents.shareId, shareIds));
  await tx.delete(shares).where(inArray(shares.id, shareIds));
  return shareIds.length;
}

async function deleteFileRows(tx: Db, ids: string[]): Promise<number> {
  await deleteSharesOf(tx, 'file', ids);
  // zip_job_entries and face_feedback cascade; faces were deleted first (RESTRICT).
  const deleted = await tx
    .delete(files)
    .where(and(inArray(files.id, ids), isNotNull(files.purgeRequestedAt)))
    .returning({ id: files.id });
  return deleted.length;
}

/** Step 2: purge-requested files: faces, objects, shares, rows. */
async function purgeFiles(ctx: JobContext): Promise<{ purged: number; skipped: number }> {
  let cursor = '00000000-0000-0000-0000-000000000000';
  let purged = 0;
  let skipped = 0;
  while (mayContinue(ctx)) {
    const batch: PurgeFile[] = await ctx.db
      .select({
        id: files.id,
        ownerId: files.ownerId,
        s3Key: files.s3Key,
        uploadId: files.uploadId,
      })
      .from(files)
      .where(and(isNotNull(files.purgeRequestedAt), gt(files.id, cursor)))
      .orderBy(asc(files.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    cursor = batch.at(-1)!.id;
    const keep = new Set<string>();

    // Faces first: a file with faces can't be deleted (RESTRICT), and faces must not outlive
    // every record of them. The collection comes from the file's owner_id (ADR 0001).
    const faceRows = await ctx.db
      .select({ fileId: faces.fileId, ownerId: faces.ownerId, faceId: faces.rekognitionFaceId })
      .from(faces)
      .where(
        inArray(
          faces.fileId,
          batch.map((f) => f.id),
        ),
      );
    for (const [ownerId, owned] of groupBy(faceRows, (r) => r.ownerId)) {
      const fileIds = [...new Set(owned.map((r) => r.fileId))];
      try {
        await deleteFacesInBatches(
          ctx.faces,
          faceCollectionId(ownerId),
          owned.map((r) => r.faceId),
        );
        await ctx.db.delete(faces).where(inArray(faces.fileId, fileIds));
      } catch (error) {
        ctx.log.warn('DeleteFaces failed; keeping the files for the next run', {
          ...errorFields(error),
          photographerId: ownerId,
          files: fileIds.length,
        });
        for (const id of fileIds) keep.add(id);
      }
    }

    for (const file of batch) {
      if (file.uploadId === null || keep.has(file.id)) continue;
      try {
        await ctx.store.abortMultipartUpload(file.s3Key, file.uploadId);
      } catch (error) {
        ctx.log.warn('AbortMultipartUpload failed; keeping the file', {
          ...errorFields(error),
          fileId: file.id,
        });
        keep.add(file.id);
      }
    }

    const doomed = batch.filter((f) => !keep.has(f.id));
    try {
      await ctx.store.deleteObjects(
        doomed.flatMap((f) => [
          f.s3Key,
          ...Object.values(derivedKeys({ photographerId: f.ownerId, fileId: f.id })),
        ]),
      );
    } catch (error) {
      ctx.log.warn('deleting objects failed; keeping the batch for the next run', {
        ...errorFields(error),
        files: doomed.length,
      });
      skipped += batch.length;
      continue;
    }

    const ids = doomed.map((f) => f.id);
    if (ids.length > 0) {
      try {
        purged += await ctx.db.transaction((tx) => deleteFileRows(tx, ids));
      } catch (error) {
        // Isolate the row that fails (e.g. faces indexed meanwhile) so the others still go.
        ctx.log.warn('batch row delete failed; retrying file by file', errorFields(error));
        for (const id of ids) {
          try {
            purged += await ctx.db.transaction((tx) => deleteFileRows(tx, [id]));
          } catch (inner) {
            ctx.log.warn('file row delete failed', { ...errorFields(inner), fileId: id });
            keep.add(id);
          }
        }
      }
    }
    skipped += keep.size;
  }
  return { purged, skipped };
}

/**
 * Step 3: purge-requested folders, leaves first. A folder goes once it holds no files and no
 * child folders; one that still holds live content stays and is reported.
 */
async function purgeFolders(ctx: JobContext): Promise<{ purged: number; blocked: number }> {
  const leaf = and(
    isNotNull(folders.purgeRequestedAt),
    sql`NOT EXISTS (SELECT 1 FROM ${files} WHERE ${files.folderId} = ${folders.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${folders} AS c WHERE c.parent_id = ${folders.id})`,
  );
  let purged = 0;
  while (mayContinue(ctx)) {
    const deleted = await ctx.db.transaction(async (tx) => {
      const batch = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(leaf)
        .orderBy(asc(folders.id))
        .limit(ctx.batchSize)
        .for('update', { skipLocked: true });
      if (batch.length === 0) return 0;
      const ids = batch.map((f) => f.id);
      await deleteSharesOf(tx, 'folder', ids);
      const gone = await tx
        .delete(folders)
        .where(and(inArray(folders.id, ids), leaf))
        .returning({ id: folders.id });
      return gone.length;
    });
    if (deleted === 0) break;
    purged += deleted;
  }
  const [remaining] = await rows<{ n: number | string }>(
    ctx.db,
    sql`SELECT count(*) AS n FROM ${folders} WHERE ${folders.purgeRequestedAt} IS NOT NULL`,
  );
  return { purged, blocked: Number(remaining?.n ?? 0) };
}

/**
 * `trash.purge.daily`. Requests the purge of everything trashed more than TRASH_RETENTION_DAYS
 * ago (releasing its quota in the same transaction), then purges every purge-requested row,
 * including those the API's "empty trash" requested (their quota was released then). For each
 * file: DeleteFaces and its `faces` rows, abort a dangling multipart upload, delete the original
 * and all derivatives, delete shares targeting it (and their consents), delete the row. Folders
 * go last, leaves first, after their shares.
 *
 * Idempotent: requesting is guarded by `purge_requested_at IS NULL`, object and face deletes
 * ignore what is already gone, and rows are deleted last, so a crash anywhere is finished by the
 * next attempt.
 */
export async function runTrashPurge(
  ctx: JobContext,
  retentionDays: number,
): Promise<TrashPurgeResult> {
  const cutoff = new Date(ctx.now() - retentionDays * 86_400_000);
  const foldersRequested = await requestExpiredFolders(ctx, cutoff);
  const filesRequested = await requestExpiredFiles(ctx, cutoff);
  const filesResult = await purgeFiles(ctx);
  const foldersResult = await purgeFolders(ctx);
  const result: TrashPurgeResult = {
    foldersRequested,
    filesRequested,
    filesPurged: filesResult.purged,
    filesSkipped: filesResult.skipped,
    foldersPurged: foldersResult.purged,
    foldersBlocked: foldersResult.blocked,
    complete: ctx.now() < ctx.deadline,
  };
  if (foldersResult.blocked > 0) {
    ctx.log.warn('purge-requested folders still hold content or failed files; kept', {
      folders: foldersResult.blocked,
    });
  }
  return result;
}
