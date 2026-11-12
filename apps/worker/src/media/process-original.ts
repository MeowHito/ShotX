import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  derivedKey,
  type MediaConfig,
  type MediaOriginal,
  type MediaKind,
  serializeQueueMessage,
  UPLOAD_FILE_TYPES,
} from '@shotx/shared';
import type { ObjectStore } from '../aws/object-store';
import type { QueueSender } from '../queue/sender';
import { type Db, isUuid } from '../db';
import type { Logger } from '../logger';
import { MediaDecodeError } from './errors';
import {
  type FileRow,
  findFileById,
  findFileByKey,
  markFailedAfterVerify,
  markReady,
  type ReadyFields,
  rejectFile,
  verifyFile,
} from './files-repo';
import { renderImageDerivatives, renderPosterDerivatives } from './image';
import { MAGIC_BYTES_LENGTH, magicBytesMatch } from './magic';
import { extractPosterFrame, probeVideo, transcodePreview, type VideoTools } from './video';

export interface MediaDeps {
  db: Db;
  store: ObjectStore;
  queues: QueueSender;
  /** The faces queue's destination for `queues`: its SQS URL, or `faces` on BullMQ. */
  facesQueueUrl: string;
  media: MediaConfig;
  video: VideoTools;
  exifDefaultUtcOffset: string;
  /**
   * FACE_INDEX_EXPIRY_DAYS: markReady renews the covering face indexes to upload + this (ADR 0011
   * decision 1).
   */
  faceIndexExpiryDays: number;
  tmpDir?: string | undefined;
  now?: () => number;
}

/** Why the worker rejected an upload's bytes (logged; never shown to viewers). */
export type RejectReason = 'SIZE_MISMATCH' | 'MAGIC_MISMATCH' | 'UNDECODABLE' | 'UNSUPPORTED_MIME';

export type OriginalOutcome =
  | 'stray-deleted'
  | 'mismatch-ignored'
  | 'purged-deleted'
  | 'already-ready'
  | 'already-failed'
  | 'rejected'
  | 'ready'
  | 'superseded';

interface Upload {
  key: string;
  contentType: string;
  body?: Uint8Array;
  path?: string;
}

function mediaKind(mime: string): MediaKind | null {
  return UPLOAD_FILE_TYPES.find((t) => t.mime === mime)?.kind ?? null;
}

/**
 * Processes one created original. Idempotent: SQS delivers at least once, and every step either
 * overwrites with the same result (derivatives), is guarded in SQL (verify, reject, ready move
 * the quota at most once), or is a no-op the second time (ready, failed and purged rows).
 *
 * Order: row checks -> HeadObject size -> magic bytes (a ranged GET) -> download and render ->
 * verify (bytes reserved -> used) -> upload derivatives -> ready -> faces job. Rendering comes
 * before the verify transaction, so undecodable files are rejected while their bytes are still
 * only reserved.
 */
export async function processOriginal(
  original: Pick<MediaOriginal, 'key' | 'fileId' | 'photographerId'>,
  deps: MediaDeps,
  log: Logger,
  signal: AbortSignal,
): Promise<OriginalOutcome> {
  const { db, store } = deps;
  const { key, fileId, photographerId } = original;

  if (!isUuid(fileId) || !isUuid(photographerId)) {
    // No row can have this key: the API builds keys from uuid ids.
    await store.deleteObjects([key]);
    log.warn('deleted an original whose key has no file row');
    return 'stray-deleted';
  }
  const row = await findFileByKey(db, key);
  if (row === null) {
    // Aborted, expired or purged upload: the object must not linger outside the quota.
    await store.deleteObjects([key]);
    log.info('deleted an original that has no file row');
    return 'stray-deleted';
  }
  if (row.id !== fileId || row.ownerId !== photographerId) {
    log.error('file row does not match the key; leaving the object alone');
    return 'mismatch-ignored';
  }
  if (row.purgeRequestedAt !== null) {
    await store.deleteObjects([key]);
    log.info('purge requested; deleted the original');
    return 'purged-deleted';
  }
  if (row.status === 'ready') {
    // A redelivery, the other variant of the same upload, or a late original.completed (a timed-out
    // enqueue that landed after all): a no-op. A crash between ready and the faces send left the
    // `faces_queued_at` mark that markReady set, and faces.sweep re-sends from it.
    return 'already-ready';
  }
  if (row.status === 'failed') {
    // A rejected upload: make sure its object is gone (a crash may have left it).
    if (row.verifiedAt === null) await store.deleteObjects([key]);
    return 'already-failed';
  }

  const kind = mediaKind(row.mime);
  const verified = row.verifiedAt !== null;
  if (kind === null) return reject(row, 'UNSUPPORTED_MIME', deps, log);

  const head = await store.head(key);
  if (head === null) throw new Error('The original object does not exist (yet); retrying');
  if (!verified) {
    if (head.size !== row.sizeBytes) return reject(row, 'SIZE_MISMATCH', deps, log);
    const magic = await store.getRange(key, 0, MAGIC_BYTES_LENGTH - 1);
    if (!magicBytesMatch(magic, row.mime)) return reject(row, 'MAGIC_MISMATCH', deps, log);
  }

  signal.throwIfAborted();
  const workDir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), `media-${fileId}-`));
  try {
    const originalPath = join(workDir, 'original');
    const downloaded = await store.download(key, originalPath, signal);
    if (downloaded.bytes !== row.sizeBytes) {
      if (!verified) return reject(row, 'SIZE_MISMATCH', deps, log);
      throw new Error('Downloaded size differs from the verified size');
    }

    let rendered: { fields: ReadyFields; uploads: Upload[] };
    try {
      rendered =
        kind === 'image'
          ? await renderImage(originalPath, row, deps)
          : await renderVideo(originalPath, workDir, row, deps, signal);
    } catch (error) {
      if (!(error instanceof MediaDecodeError)) throw error;
      if (!verified) return reject(row, 'UNDECODABLE', deps, log);
      // Verified by an earlier attempt that crashed before ready, and now it doesn't decode: the
      // bytes stay counted (as for any verified file) until the photographer deletes it.
      await markFailedAfterVerify(db, row.id);
      log.warn('verified original does not decode; marked failed');
      return 'rejected';
    }

    signal.throwIfAborted();
    if (!verified && !(await verifyFile(db, row.id, downloaded.sha256, log))) {
      return settleSuperseded(row, deps, log, []);
    }

    for (const upload of rendered.uploads) {
      signal.throwIfAborted();
      if (upload.body !== undefined) await store.put(upload.key, upload.body, upload.contentType);
      else if (upload.path !== undefined) {
        await store.putFile(upload.key, upload.path, upload.contentType, signal);
      }
    }

    const now = new Date((deps.now ?? Date.now)());
    const ready = await markReady(db, row.id, rendered.fields, now, deps.faceIndexExpiryDays);
    if (ready === null) {
      return settleSuperseded(
        row,
        deps,
        log,
        rendered.uploads.map((u) => u.key),
      );
    }
    log.info('file ready', {
      kind,
      sizeBytes: row.sizeBytes,
      width: rendered.fields.width,
      height: rendered.fields.height,
    });
    if (ready.facesQueued) await sendIndexFile(row.id, deps, log);
    return 'ready';
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

async function reject(
  row: FileRow,
  reason: RejectReason,
  deps: MediaDeps,
  log: Logger,
): Promise<OriginalOutcome> {
  // Row first, then the object: if we crash in between, the redelivery sees `failed` and
  // deletes the object again.
  const changed = await rejectFile(deps.db, row.id, log);
  await deps.store.deleteObjects([row.s3Key]);
  log.warn('rejected upload', { reason, released: changed, sizeBytes: row.sizeBytes });
  return 'rejected';
}

/**
 * The row changed under us (purge requested, deleted by abort or expiry, or failed). Remove what
 * this attempt wrote if nothing references it any more.
 */
async function settleSuperseded(
  row: FileRow,
  deps: MediaDeps,
  log: Logger,
  writtenKeys: string[],
): Promise<OriginalOutcome> {
  const current = await findFileById(deps.db, row.id);
  if (current === null) {
    await deps.store.deleteObjects([row.s3Key, ...writtenKeys]);
  } else if (current.purgeRequestedAt !== null) {
    await deps.store.deleteObjects([row.s3Key, ...writtenKeys]);
  }
  log.info('file changed while processing; stopped', {
    status: current?.status ?? 'deleted',
    purgeRequested: current?.purgeRequestedAt != null,
  });
  return 'superseded';
}

async function renderImage(
  path: string,
  row: FileRow,
  deps: MediaDeps,
): Promise<{ fields: ReadyFields; uploads: Upload[] }> {
  const parts = { photographerId: row.ownerId, fileId: row.id };
  const out = await renderImageDerivatives(path, deps.media, deps.exifDefaultUtcOffset);
  const keys = {
    thumb: derivedKey(parts, 'thumb'),
    preview: derivedKey(parts, 'preview'),
    web: derivedKey(parts, 'web'),
  };
  return {
    fields: {
      width: out.width,
      height: out.height,
      takenAt: out.takenAt,
      thumbKey: keys.thumb,
      previewKey: keys.preview,
      webKey: keys.web,
      posterKey: null,
      webSizeBytes: out.web.length,
    },
    uploads: [
      { key: keys.thumb, body: out.thumb, contentType: 'image/webp' },
      { key: keys.preview, body: out.preview, contentType: 'image/webp' },
      { key: keys.web, body: out.web, contentType: 'image/jpeg' },
    ],
  };
}

async function renderVideo(
  path: string,
  workDir: string,
  row: FileRow,
  deps: MediaDeps,
  signal: AbortSignal,
): Promise<{ fields: ReadyFields; uploads: Upload[] }> {
  const parts = { photographerId: row.ownerId, fileId: row.id };
  const probe = await probeVideo(path, deps.video, signal);
  const frame = await extractPosterFrame(path, probe, workDir, deps.video, signal);
  const poster = await renderPosterDerivatives(frame, deps.media);
  const preview = await transcodePreview(path, probe, workDir, deps.media, deps.video, signal);
  const keys = {
    thumb: derivedKey(parts, 'thumb'),
    poster: derivedKey(parts, 'poster'),
    preview: derivedKey(parts, 'videoPreview'),
  };
  return {
    fields: {
      width: probe.width,
      height: probe.height,
      takenAt: probe.takenAt,
      thumbKey: keys.thumb,
      previewKey: keys.preview,
      webKey: null,
      posterKey: keys.poster,
      webSizeBytes: (await stat(preview)).size,
    },
    uploads: [
      { key: keys.thumb, body: poster.thumb, contentType: 'image/webp' },
      { key: keys.poster, body: poster.poster, contentType: 'image/jpeg' },
      { key: keys.preview, path: preview, contentType: 'video/mp4' },
    ],
  };
}

/**
 * Sends `index.file` for a file whose outbox mark (`faces_queued_at`) was just set in the same
 * UPDATE that made it ready (or re-set on a redelivery). A crash before the send leaves the mark,
 * and faces.sweep re-sends it; the faces consumer tolerates duplicates (packages/face README,
 * rule 5) and clears the mark when the job ends. Videos are never marked.
 */
async function sendIndexFile(fileId: string, deps: MediaDeps, log: Logger): Promise<void> {
  await deps.queues.sendMessage(
    deps.facesQueueUrl,
    serializeQueueMessage('faces', { type: 'index.file', fileId }),
  );
  log.info('queued face indexing');
}
