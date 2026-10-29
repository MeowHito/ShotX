import { files, zipJobEntries, zipJobs } from '@shotx/db';
import {
  contentDispositionAttachment,
  downloadObject,
  ErrorCode,
  multipartPlan,
  parseQueueMessage,
  parseZipEntries,
  UPLOAD_FILE_TYPES,
  zipKey,
  ZipEntriesError,
} from '@shotx/shared';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { ObjectStore } from '../aws/object-store';
import type { ZipConfig } from '../config';
import type { Db } from '../db';
import { errorFields, type Logger } from '../logger';
import type { MessageHandler } from '../sqs/consumer';
import { type ArchiveEntry, streamZip, ZipJobFailure } from './archive';

export interface ZipDeps {
  db: Db;
  store: ObjectStore;
  zip: ZipConfig;
  /** Preferred multipart part size (UPLOAD_PART_BYTES); grown when the archive needs it. */
  partBytes: number;
  /**
   * Longest one attempt may stream (WORKER_ZIP_MAX_PROCESSING_SECONDS). A `running` job whose
   * attempt started longer ago than this is taken over by the next delivery.
   */
  maxProcessingMs: number;
  now?: () => number;
}

export type ZipOutcome = 'missing' | 'finished' | 'busy' | 'ready' | 'failed' | 'superseded';

interface ClaimedJob {
  attempts: number;
  photographerId: string;
  downloadSize: 'web' | 'original';
  fileCount: number;
  /**
   * Owner jobs (`share_id` null, migration 0008): the archive's download name, stored on the
   * object as Content-Disposition. Null for share jobs (the API names those when it signs).
   */
  archiveName: string | null;
}

/**
 * Claims the job for this attempt: `queued` -> `running`, `attempts + 1`. A `running` job is taken
 * over only when its attempt looks dead: this message was delivered before (the previous holder
 * stopped heartbeating it), or the attempt started more than WORKER_ZIP_MAX_PROCESSING_SECONDS
 * ago. A first delivery of a duplicate message for a running job leaves it to its attempt.
 */
async function claim(
  db: Db,
  jobId: string,
  redelivered: boolean,
  staleMs: number,
): Promise<ClaimedJob | 'missing' | 'finished' | 'busy'> {
  const [claimed] = await db
    .update(zipJobs)
    .set({ status: 'running', attempts: sql`${zipJobs.attempts} + 1`, startedAt: sql`now()` })
    .where(
      and(
        eq(zipJobs.id, jobId),
        sql`(${zipJobs.status} = 'queued' OR (${zipJobs.status} = 'running' AND (${redelivered} OR ${zipJobs.startedAt} < now() - make_interval(secs => ${staleMs / 1000}))))`,
      ),
    )
    .returning({
      attempts: zipJobs.attempts,
      photographerId: zipJobs.photographerId,
      downloadSize: zipJobs.downloadSize,
      fileCount: zipJobs.fileCount,
      archiveName: zipJobs.archiveName,
    });
  if (claimed !== undefined) return claimed;
  const [job] = await db
    .select({ status: zipJobs.status })
    .from(zipJobs)
    .where(eq(zipJobs.id, jobId));
  if (job === undefined) return 'missing';
  return job.status === 'running' ? 'busy' : 'finished';
}

const KIND_BY_MIME = new Map<string, 'image' | 'video'>(
  UPLOAD_FILE_TYPES.map((t) => [t.mime, t.kind]),
);

/**
 * Rebuilds the job's entries from `zip_job_entries` and the files as they are now, and checks them
 * with parseZipEntries. Files purged since the job was created (their entries cascade away, so
 * fewer than `file_count` remain), trashed, or without the requested variant fail the job with
 * NOT_FOUND.
 */
async function buildEntries(db: Db, jobId: string, job: ClaimedJob): Promise<ArchiveEntry[]> {
  const found = await db
    .select({
      fileId: zipJobEntries.fileId,
      entryName: zipJobEntries.name,
      ownerId: files.ownerId,
      name: files.name,
      mime: files.mime,
      s3Key: files.s3Key,
      webKey: files.webKey,
      previewKey: files.previewKey,
      sizeBytes: files.sizeBytes,
      webSizeBytes: files.webSizeBytes,
      status: files.status,
      deletedAt: files.deletedAt,
      purgeRequestedAt: files.purgeRequestedAt,
      takenAt: files.takenAt,
      createdAt: files.createdAt,
    })
    .from(zipJobEntries)
    .innerJoin(
      files,
      and(eq(files.id, zipJobEntries.fileId), eq(files.ownerId, zipJobEntries.photographerId)),
    )
    .where(eq(zipJobEntries.jobId, jobId))
    .orderBy(asc(zipJobEntries.position));
  if (found.length !== job.fileCount) {
    throw new ZipJobFailure(
      ErrorCode.NOT_FOUND,
      `${job.fileCount - found.length} of ${job.fileCount} files were deleted`,
    );
  }
  const entries = found.map((row, position) => {
    const kind = KIND_BY_MIME.get(row.mime);
    const served =
      kind === undefined ||
      row.status !== 'ready' ||
      row.deletedAt !== null ||
      row.purgeRequestedAt !== null
        ? null
        : downloadObject({ ...row, mediaKind: kind }, job.downloadSize);
    if (served === null) {
      throw new ZipJobFailure(
        ErrorCode.NOT_FOUND,
        `Entry ${position} is no longer available (trashed, not ready or no ${job.downloadSize} variant)`,
      );
    }
    return {
      fileId: row.fileId,
      key: served.key,
      name: row.entryName,
      bytes: served.bytes,
      date: row.takenAt ?? row.createdAt,
    };
  });
  try {
    parseZipEntries({ photographerId: job.photographerId, entries });
  } catch (error) {
    if (error instanceof ZipEntriesError) {
      throw new ZipJobFailure(ErrorCode.INTERNAL_ERROR, error.message);
    }
    throw error;
  }
  return entries;
}

/** Real sizes from S3 (web_size_bytes may be unknown), checked against the limits. */
async function sizeEntries(
  store: ObjectStore,
  entries: ArchiveEntry[],
  zip: ZipConfig,
): Promise<number> {
  if (entries.length > zip.maxFiles) {
    throw new ZipJobFailure(
      ErrorCode.ZIP_TOO_LARGE,
      `${entries.length} files is over ZIP_MAX_FILES (${zip.maxFiles})`,
    );
  }
  let total = 0;
  for (const [position, entry] of entries.entries()) {
    const head = await store.head(entry.key);
    if (head === null) {
      throw new ZipJobFailure(ErrorCode.NOT_FOUND, `Entry ${position}'s object does not exist`);
    }
    entry.bytes = head.size;
    total += head.size;
  }
  if (total > zip.maxBytes) {
    throw new ZipJobFailure(
      ErrorCode.ZIP_TOO_LARGE,
      `${total} bytes is over ZIP_MAX_BYTES (${zip.maxBytes})`,
    );
  }
  return total;
}

/** Upper bound of the archive's size: data plus local and central headers with ZIP64 extras. */
function archiveSizeBound(entries: readonly ArchiveEntry[], dataBytes: number): number {
  const perEntry = 30 + 46 + 2 * 255 + 2 * 32 + 24; // headers, name twice, zip64 extras, descriptor
  return dataBytes + entries.length * perEntry + 22 + 56 + 20;
}

async function finish(
  db: Db,
  jobId: string,
  attempt: number,
  set: Record<string, unknown>,
): Promise<boolean> {
  const updated = await db
    .update(zipJobs)
    .set(set)
    .where(and(eq(zipJobs.id, jobId), eq(zipJobs.status, 'running'), eq(zipJobs.attempts, attempt)))
    .returning({ id: zipJobs.id });
  return updated.length > 0;
}

async function runJob(
  deps: ZipDeps,
  jobId: string,
  receiveCount: number,
  log: Logger,
  outer: AbortSignal,
): Promise<ZipOutcome> {
  const { db, store, zip } = deps;
  const claimed = await claim(db, jobId, receiveCount > 1, deps.maxProcessingMs);
  if (typeof claimed === 'string') return claimed;
  const attempt = claimed.attempts;
  const started = (deps.now ?? Date.now)();
  const signal = AbortSignal.any([outer, AbortSignal.timeout(deps.maxProcessingMs)]);
  const key = zipKey(jobId);
  try {
    const entries = await buildEntries(db, jobId, claimed);
    const dataBytes = await sizeEntries(store, entries, zip);
    const plan = multipartPlan(archiveSizeBound(entries, dataBytes), deps.partBytes);
    const resultBytes = await streamZip(store, key, entries, {
      maxBytes: zip.maxBytes,
      partBytes: plan.partSize,
      signal,
      // Zip results are never renamed, so a stored name can't go stale; the API's signed URL
      // still sets response-content-disposition (ADR 0008: verify it on R2 before launch).
      ...(claimed.archiveName === null
        ? {}
        : { contentDisposition: contentDispositionAttachment(claimed.archiveName) }),
    });
    const done = await finish(db, jobId, attempt, {
      status: 'ready',
      resultKey: key,
      resultBytes,
      completedAt: sql`now()`,
      expiresAt: sql`now() + make_interval(secs => ${zip.resultTtlSeconds})`,
    });
    if (!done) return 'superseded';
    log.info('zip ready', {
      files: entries.length,
      dataBytes,
      resultBytes,
      attempt,
      durationMs: (deps.now ?? Date.now)() - started,
    });
    return 'ready';
  } catch (error) {
    // Lost or shutting down: another delivery of the message finishes the job.
    if (outer.aborted) throw outer.reason instanceof Error ? outer.reason : error;
    const failure =
      error instanceof ZipJobFailure
        ? error
        : new ZipJobFailure(
            ErrorCode.INTERNAL_ERROR,
            signal.aborted
              ? 'Streaming took longer than WORKER_ZIP_MAX_PROCESSING_SECONDS'
              : `Streaming failed: ${error instanceof Error ? error.name : 'unknown error'}`,
          );
    // A failed job is final: the viewer asks again (a new job). Retrying here could keep a job
    // `running` until its message reached the DLQ, and the viewer would poll forever.
    const done = await finish(db, jobId, attempt, {
      status: 'failed',
      errorCode: failure.code,
      errorMessage: failure.message,
      completedAt: sql`now()`,
    });
    log.warn('zip failed', {
      code: failure.code,
      ...(error instanceof ZipJobFailure ? {} : errorFields(error)),
      attempt,
      recorded: done,
    });
    return done ? 'failed' : 'superseded';
  }
}

/**
 * Consumer of the `zip` queue. Builds `tmp/zips/{jobId}.zip` for a multi-file download and marks
 * the job `ready` (`expires_at = completed_at + ZIP_RESULT_TTL_SECONDS`) or `failed`.
 *
 * Idempotent: only a claim (`queued`, or a `running` attempt that looks dead) starts work; ready
 * and failed jobs are acknowledged; the result is written only by the attempt that holds the
 * claim (`attempts` must still match), and every attempt writes the same key, so a superseded
 * attempt's archive is identical and harmless.
 */
export function createZipHandler(deps: ZipDeps): MessageHandler {
  return async (body, context) => {
    const { jobId } = parseQueueMessage('zip', body);
    const log = context.log.child({ jobId });
    const outcome = await runJob(deps, jobId, context.receiveCount, log, context.signal);
    if (outcome !== 'ready' && outcome !== 'failed') log.info('zip message done', { outcome });
  };
}
