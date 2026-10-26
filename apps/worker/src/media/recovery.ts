import { files } from '@shotx/db';
import { originalCompletedMessage, serializeQueueMessage } from '@shotx/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { ObjectStore } from '../aws/object-store';
import type { Db } from '../db';
import type { QueueSender } from '../queue/sender';

/** An `uploading` row with its multipart upload id (POST /uploads/init). */
export interface OpenUploadRow {
  id: string;
  ownerId: string;
  s3Key: string;
  uploadId: string;
  sizeBytes: number;
}

/**
 * What storage says about an open upload row:
 * - `live`: the multipart upload is still open (the client may still be uploading);
 * - `completed`: the upload is gone and the object exists with exactly the declared size, so the
 *   API's CompleteMultipartUpload succeeded and its markCompleted was lost;
 * - `missing` / `size-mismatch`: no object, or one of another size (never recovered).
 */
export type StoredUpload = 'live' | 'completed' | 'missing' | 'size-mismatch';

/** The object of an upload whose multipart upload is closed (completed or aborted). */
export async function storedOriginal(
  store: Pick<ObjectStore, 'head'>,
  row: Pick<OpenUploadRow, 's3Key' | 'sizeBytes'>,
): Promise<Exclude<StoredUpload, 'live'>> {
  const head = await store.head(row.s3Key);
  if (head === null) return 'missing';
  return head.size === row.sizeBytes ? 'completed' : 'size-mismatch';
}

/** ListParts, then HeadObject (media.sweep: the upload must not be touched while it is open). */
export async function checkOpenUpload(
  store: Pick<ObjectStore, 'head' | 'multipartUploadExists'>,
  row: Pick<OpenUploadRow, 's3Key' | 'uploadId' | 'sizeBytes'>,
): Promise<StoredUpload> {
  if (await store.multipartUploadExists(row.s3Key, row.uploadId)) return 'live';
  return storedOriginal(store, row);
}

export interface RecoveryDeps {
  db: Db;
  queues: QueueSender;
  /** The media queue's destination for `queues` (SQS URL or `media`). */
  mediaQueue: string;
}

/**
 * Completes a row whose object exists with its declared size, as the API's markCompleted does
 * (upload_id and upload_part_bytes cleared, `uploading` -> `processing`, media_queued_at set,
 * guarded by the upload id so a concurrent complete or abort wins), then sends
 * `original.completed`. The bytes stay reserved until the media pipeline verifies them. Returns
 * false when the guard matched nothing. A failed send leaves a `processing` row that media.sweep
 * re-sends after MEDIA_SWEEP_PROCESSING_AGE_SECONDS.
 */
export async function recoverCompletedUpload(
  deps: RecoveryDeps,
  row: Pick<OpenUploadRow, 'id' | 'ownerId' | 's3Key' | 'uploadId'>,
): Promise<boolean> {
  const [updated] = await deps.db
    .update(files)
    .set({
      uploadId: null,
      uploadPartBytes: null,
      status: sql`CASE WHEN ${files.status} = 'uploading' THEN 'processing'::file_status ELSE ${files.status} END`,
      mediaQueuedAt: sql`now()`,
    })
    .where(
      and(eq(files.id, row.id), eq(files.ownerId, row.ownerId), eq(files.uploadId, row.uploadId)),
    )
    .returning({ id: files.id });
  if (updated === undefined) return false;
  await deps.queues.sendMessage(
    deps.mediaQueue,
    serializeQueueMessage(
      'media',
      originalCompletedMessage({ fileId: row.id, photographerId: row.ownerId, key: row.s3Key }),
    ),
  );
  return true;
}
