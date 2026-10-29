import { coveredByFaceIndexSql, files, folders } from '@shotx/db';
import { UPLOAD_FILE_TYPES } from '@shotx/shared';
import { and, eq, isNotNull, isNull, ne, type SQL, sql } from 'drizzle-orm';
import type { Db } from '../db';
import type { Logger } from '../logger';
import { applyQuotaMove } from '../quota';

export interface FileRow {
  id: string;
  ownerId: string;
  folderId: string | null;
  mime: string;
  sizeBytes: number;
  s3Key: string;
  status: 'uploading' | 'processing' | 'ready' | 'failed';
  verifiedAt: Date | null;
  purgeRequestedAt: Date | null;
  deletedAt: Date | null;
  faceCount: number | null;
}

const fileColumns = {
  id: files.id,
  ownerId: files.ownerId,
  folderId: files.folderId,
  mime: files.mime,
  sizeBytes: files.sizeBytes,
  s3Key: files.s3Key,
  status: files.status,
  verifiedAt: files.verifiedAt,
  purgeRequestedAt: files.purgeRequestedAt,
  deletedAt: files.deletedAt,
  faceCount: files.faceCount,
};

/** The row whose original is `key` (`files.s3_key` is unique). */
export async function findFileByKey(db: Db, key: string): Promise<FileRow | null> {
  const [row] = await db.select(fileColumns).from(files).where(eq(files.s3Key, key));
  return row ?? null;
}

export async function findFileById(db: Db, id: string): Promise<FileRow | null> {
  const [row] = await db.select(fileColumns).from(files).where(eq(files.id, id));
  return row ?? null;
}

/** Guards shared by every worker transition of an unverified file (drive/quota). */
const unverified = (id: string) =>
  and(
    eq(files.id, id),
    isNull(files.verifiedAt),
    ne(files.status, 'failed'),
    isNull(files.purgeRequestedAt),
  );

/**
 * Rejects the bytes: `failed`, upload_id cleared, reservation released, in one transaction.
 * Returns false when the guard matched nothing (already failed, verified, purged or deleted), in
 * which case nothing moved.
 */
export async function rejectFile(db: Db, id: string, log: Logger): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(files)
      .set({ status: 'failed', uploadId: null })
      .where(unverified(id))
      .returning({ ownerId: files.ownerId, sizeBytes: files.sizeBytes });
    if (row === undefined) return false;
    await applyQuotaMove(tx, row.ownerId, 'releaseReserved', row.sizeBytes, log);
    return true;
  });
}

/**
 * Marks the object verified and moves its bytes from reserved to used, in one transaction. A file
 * still `uploading` (the event beat the API's complete) becomes `processing` and its upload_id is
 * cleared: the multipart upload is complete. Returns false when the guard matched nothing.
 */
export async function verifyFile(
  db: Db,
  id: string,
  sha256: string,
  log: Logger,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(files)
      .set({
        verifiedAt: sql`now()`,
        sha256,
        uploadId: null,
        status: sql`CASE WHEN ${files.status} = 'uploading' THEN 'processing'::file_status ELSE ${files.status} END`,
      })
      .where(unverified(id))
      .returning({ ownerId: files.ownerId, sizeBytes: files.sizeBytes });
    if (row === undefined) return false;
    await applyQuotaMove(tx, row.ownerId, 'commit', row.sizeBytes, log);
    return true;
  });
}

export interface ReadyFields {
  width: number;
  height: number;
  takenAt: Date | null;
  thumbKey: string;
  previewKey: string;
  webKey: string | null;
  posterKey: string | null;
  /** Size of the `web` download variant: web.jpg (images) or preview.mp4 (videos). */
  webSizeBytes: number;
}

const IMAGE_MIMES = UPLOAD_FILE_TYPES.filter((t) => t.kind === 'image').map((t) => t.mime);

/**
 * True for a live, not yet indexed, not withheld (migration 0009) photo of the row being updated
 * whose folder an active face index covers now: the files that need an `index.file` job (videos
 * are never indexed).
 */
function needsFaceIndexSql(now: Date): SQL {
  return sql`(${files.mime} IN (${sql.join(
    IMAGE_MIMES.map((m) => sql`${m}`),
    sql`, `,
  )})
    AND ${files.deletedAt} IS NULL
    AND ${files.purgeRequestedAt} IS NULL
    AND ${files.faceCount} IS NULL
    AND ${files.facesWithheldAt} IS NULL
    AND EXISTS (
      SELECT 1 FROM ${folders} AS "fo"
      WHERE "fo"."id" = ${files.folderId} AND "fo"."owner_id" = ${files.ownerId}
        AND ${coveredByFaceIndexSql(sql`"fo"."path"`, files.ownerId, now)}
    ))`;
}

/**
 * Records the derivatives and marks the file `ready`. Only a verified, not failed, not
 * purge-requested file changes; returns null otherwise. In the same UPDATE it sets the
 * `index.file` outbox mark (`faces_queued_at`, migration 0006) when a face index covers the photo,
 * so a crash before the send is caught by faces.sweep; `facesQueued` says to send the job.
 */
export async function markReady(
  db: Db,
  id: string,
  fields: ReadyFields,
  now: Date,
): Promise<{ facesQueued: boolean } | null> {
  const [updated] = await db
    .update(files)
    .set({
      ...fields,
      status: 'ready',
      facesQueuedAt: sql`CASE WHEN ${needsFaceIndexSql(now)} THEN now() ELSE ${files.facesQueuedAt} END`,
    })
    .where(
      and(
        eq(files.id, id),
        isNotNull(files.verifiedAt),
        ne(files.status, 'failed'),
        isNull(files.purgeRequestedAt),
      ),
    )
    .returning({ facesQueuedAt: files.facesQueuedAt });
  return updated === undefined ? null : { facesQueued: updated.facesQueuedAt !== null };
}

/**
 * Fails a file that was verified by an earlier attempt but no longer decodes. Its bytes stay in
 * used_bytes (fileQuotaBucket: verified files count) until the photographer deletes it.
 */
export async function markFailedAfterVerify(db: Db, id: string): Promise<void> {
  await db
    .update(files)
    .set({ status: 'failed' })
    .where(and(eq(files.id, id), ne(files.status, 'failed'), isNull(files.purgeRequestedAt)));
}
