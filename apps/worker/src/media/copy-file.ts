import { faces, files } from '@shotx/db';
import {
  derivedKey,
  derivedKeys,
  type FileCopyMessage,
  parseS3Key,
  serializeQueueMessage,
} from '@shotx/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { CopySourceMissingError } from '../aws/object-store';
import { type Db, rows } from '../db';
import type { Logger } from '../logger';
import {
  markFailedAfterVerify,
  markReady,
  type ReadyFields,
  rejectFile,
  verifyFile,
} from './files-repo';
import type { MediaDeps } from './process-original';

/** What happened to one `file.copy` message (logged). */
export type FileCopyOutcome =
  | 'missing'
  | 'mismatch-ignored'
  | 'already-ready'
  | 'already-failed'
  | 'purged-deleted'
  | 'source-gone'
  | 'ready'
  | 'superseded';

export interface FileCopyDeps extends MediaDeps {
  /** STORAGE_ORIGINALS_CLASS: the copy's original is written like an upload's. */
  originalsStorageClass: string;
  /** Preferred part size of a multipart copy (UPLOAD_PART_BYTES). */
  partBytes: number;
}

const copyColumns = {
  id: files.id,
  ownerId: files.ownerId,
  s3Key: files.s3Key,
  sizeBytes: files.sizeBytes,
  sha256: files.sha256,
  status: files.status,
  verifiedAt: files.verifiedAt,
  purgeRequestedAt: files.purgeRequestedAt,
  copiedFromFileId: files.copiedFromFileId,
  width: files.width,
  height: files.height,
  takenAt: files.takenAt,
  thumbKey: files.thumbKey,
  previewKey: files.previewKey,
  webKey: files.webKey,
  posterKey: files.posterKey,
  webSizeBytes: files.webSizeBytes,
};

type CopyRow = Awaited<ReturnType<typeof loadRow>>;

async function loadRow(db: Db, id: string) {
  const [row] = await db.select(copyColumns).from(files).where(eq(files.id, id));
  return row ?? null;
}

/**
 * PDPA (migration 0009): re-checks the source right before the copy becomes ready. When it was
 * withheld since the copy was requested (a deletion completed meanwhile) or has a deletion
 * pending (`faces` rows with `deletion_id`), the copy is withheld too, so it is never indexed.
 * (A copy row the API inserted already inherited the source's mark at request time.) True when
 * the copy was withheld here.
 */
async function withholdIfSourceWithheld(
  db: Db,
  copyId: string,
  sourceId: string,
): Promise<boolean> {
  const [state] = await rows<{ withheld: boolean; pending: boolean }>(
    db,
    sql`SELECT "s"."faces_withheld_at" IS NOT NULL AS "withheld",
        EXISTS (
          SELECT 1 FROM ${faces} AS "fa"
          WHERE "fa"."file_id" = "s"."id" AND "fa"."deletion_id" IS NOT NULL
        ) AS "pending"
      FROM ${files} AS "s" WHERE "s"."id" = ${sourceId}`,
  );
  if (state === undefined || (!state.withheld && !state.pending)) return false;
  const updated = await db
    .update(files)
    .set({ facesWithheldAt: sql`now()` })
    .where(and(eq(files.id, copyId), isNull(files.facesWithheldAt)))
    .returning({ id: files.id });
  return updated.length > 0;
}

/** Every key the copy may have written: its original and all of its derivatives. */
function copyKeys(copy: { id: string; ownerId: string; s3Key: string }): string[] {
  return [
    copy.s3Key,
    ...Object.values(derivedKeys({ photographerId: copy.ownerId, fileId: copy.id })),
  ];
}

/** The derivative of `copy` that corresponds to the source's derived `key`. */
function targetDerivedKey(key: string, copy: { id: string; ownerId: string }): string {
  const parsed = parseS3Key(key);
  if (parsed?.kind !== 'derived')
    throw new Error('The source has a derivative key it did not build');
  return derivedKey({ photographerId: copy.ownerId, fileId: copy.id }, parsed.variant);
}

/**
 * Fails the copy. Unverified (the usual case): `failed` with the reservation released
 * (rejectFile), row first, then whatever it wrote is deleted, so a redelivery after a crash sees
 * `failed` and deletes again. Verified by an earlier attempt that crashed before ready: its
 * objects are complete and its bytes counted, so it is failed like any verified file that can't
 * be finished (markFailedAfterVerify) and stays until the photographer deletes it.
 */
async function failCopy(
  copy: NonNullable<CopyRow>,
  deps: FileCopyDeps,
  log: Logger,
  reason: string,
): Promise<FileCopyOutcome> {
  if (copy.verifiedAt !== null) {
    await markFailedAfterVerify(deps.db, copy.id);
    log.warn('verified file copy could not be finished; marked failed', { reason });
    return 'source-gone';
  }
  const released = await rejectFile(deps.db, copy.id, log);
  await deps.store.deleteObjects(copyKeys(copy));
  log.warn('file copy failed', { reason, released });
  return 'source-gone';
}

/**
 * Processes a `file.copy` message (fileCopyMessageSchema in @shotx/shared): copies the source's
 * original and derivatives server-side to the copy's keys, checks the copy's original with
 * HeadObject, verifies it (bytes reserved -> used, the source's SHA-256), and marks it `ready`
 * with the source's metadata and the copy's derivative keys, setting the faces outbox mark in the
 * same UPDATE when a face index covers the copy's folder (then `index.file` is sent). Faces are
 * never copied: the copy is indexed like a new photo.
 *
 * Idempotent: a ready or failed copy is a no-op, a re-run overwrites the same keys with the same
 * bytes, verify and ready are guarded in SQL. A source that is gone, purge-requested, not ready
 * or of another owner fails the copy and releases its reservation.
 */
export async function processFileCopy(
  message: FileCopyMessage,
  deps: FileCopyDeps,
  log: Logger,
  signal: AbortSignal,
): Promise<FileCopyOutcome> {
  const { db, store } = deps;
  const copy = await loadRow(db, message.fileId);
  if (copy === null) return 'missing';
  if (copy.ownerId !== message.photographerId || copy.copiedFromFileId !== message.sourceFileId) {
    log.error('copy row does not match the message; leaving it alone');
    return 'mismatch-ignored';
  }
  if (copy.status === 'ready') return 'already-ready';
  if (copy.status === 'failed') {
    if (copy.verifiedAt === null) await store.deleteObjects(copyKeys(copy));
    return 'already-failed';
  }
  if (copy.purgeRequestedAt !== null) {
    await store.deleteObjects(copyKeys(copy));
    return 'purged-deleted';
  }

  const source = await loadRow(db, message.sourceFileId);
  if (
    source === null ||
    source.ownerId !== copy.ownerId ||
    source.status !== 'ready' ||
    source.purgeRequestedAt !== null ||
    source.sha256 === null ||
    source.width === null ||
    source.height === null ||
    source.thumbKey === null ||
    source.previewKey === null ||
    source.webSizeBytes === null ||
    source.sizeBytes !== copy.sizeBytes
  ) {
    return failCopy(copy, deps, log, 'source-unavailable');
  }

  const derived = [source.thumbKey, source.previewKey, source.webKey, source.posterKey].filter(
    (key): key is string => key !== null,
  );
  try {
    signal.throwIfAborted();
    await store.copy(source.s3Key, copy.s3Key, {
      size: source.sizeBytes,
      partBytes: deps.partBytes,
      storageClass: deps.originalsStorageClass,
      signal,
    });
    for (const key of derived) {
      signal.throwIfAborted();
      const head = await store.head(key);
      if (head === null) throw new CopySourceMissingError('A derivative of the source is gone');
      await store.copy(key, targetDerivedKey(key, copy), {
        size: head.size,
        partBytes: deps.partBytes,
        signal,
      });
    }
  } catch (error) {
    if (!(error instanceof CopySourceMissingError)) throw error;
    // Purged between the row check and the copy.
    return failCopy(copy, deps, log, 'source-objects-gone');
  }

  const head = await store.head(copy.s3Key);
  if (head?.size !== copy.sizeBytes) return failCopy(copy, deps, log, 'size-mismatch');

  signal.throwIfAborted();
  if (copy.verifiedAt === null && !(await verifyFile(db, copy.id, source.sha256, log))) {
    return 'superseded';
  }
  const target = (key: string | null) => (key === null ? null : targetDerivedKey(key, copy));
  const fields: ReadyFields = {
    width: source.width,
    height: source.height,
    takenAt: source.takenAt,
    thumbKey: targetDerivedKey(source.thumbKey, copy),
    previewKey: targetDerivedKey(source.previewKey, copy),
    webKey: target(source.webKey),
    posterKey: target(source.posterKey),
    webSizeBytes: source.webSizeBytes,
  };
  if (await withholdIfSourceWithheld(db, copy.id, source.id)) {
    log.info('source is withheld from face search or has a deletion pending; copy withheld');
  }
  // A withheld copy gets no outbox mark (needsFaceIndexSql), so no index.file is sent.
  const ready = await markReady(db, copy.id, fields, new Date((deps.now ?? Date.now)()));
  if (ready === null) {
    const current = await loadRow(db, copy.id);
    if (current === null || current.purgeRequestedAt !== null) {
      await store.deleteObjects(copyKeys(copy));
    }
    log.info('copy changed while processing; stopped', { status: current?.status ?? 'deleted' });
    return 'superseded';
  }
  log.info('file copied', { sizeBytes: copy.sizeBytes, derivatives: derived.length });
  if (ready.facesQueued) {
    await deps.queues.sendMessage(
      deps.facesQueueUrl,
      serializeQueueMessage('faces', { type: 'index.file', fileId: copy.id }),
    );
    log.info('queued face indexing');
  }
  return 'ready';
}
