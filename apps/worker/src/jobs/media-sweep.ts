import { designAssets, files } from '@shotx/db';
import {
  originalCompletedMessage,
  serializeQueueMessage,
  type WorkerSweepSettings,
} from '@shotx/shared';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { rows } from '../db';
import { errorFields } from '../logger';
import { checkOpenUpload, recoverCompletedUpload } from '../media/recovery';
import { type JobContext, mayContinue } from './context';

export interface MediaSweepResult {
  /** `processing` rows whose `original.completed` was sent again. */
  requeued: number;
  /** `processing` rows past MEDIA_SWEEP_MAX_REQUEUES (left for the operator). */
  overCap: number;
  /** `processing` design images (ADR 0013) whose `design.asset` was sent again. */
  designAssetsRequeued: number;
  /** `processing` design images past MEDIA_SWEEP_MAX_REQUEUES (left for the operator). */
  designAssetsOverCap: number;
  /** Ready images whose web.jpg is over MEDIA_WEB_MAX_BYTES, sent `web.rerender` (ADR 0028). */
  webRerenders: number;
  /** `uploading` rows completed from their object (markCompleted lost). */
  uploadsRecovered: number;
  /** `uploading` rows still being uploaded, or without a complete object (left alone). */
  uploadsLeft: number;
  /** Rows a storage or queue error stopped; the next run tries again. */
  errors: number;
  complete: boolean;
}

/** File ids per error log line for the operator (the count is always complete). */
const MAX_LOGGED_IDS = 20;

type Settings = WorkerSweepSettings['media'];

/** `processing`, not purge-requested, last started more than the age ago. */
const staleProcessing = (settings: Settings) => sql`
  ${files.status} = 'processing'
  AND ${files.purgeRequestedAt} IS NULL
  AND coalesce(${files.mediaQueuedAt}, ${files.createdAt})
    < now() - make_interval(secs => ${settings.processingAgeSeconds})`;

/**
 * Re-sends `original.completed` for stale `processing` rows below the requeue cap. The guarded
 * UPDATE (age and cap re-checked on the locked row) bumps `media_queued_at` and `media_requeues`
 * before the send, so concurrent sweeps can't both send for one row, and a failed send waits for
 * the next age window. The media consumer is idempotent, so a row whose first message was only
 * slow costs a duplicate run, nothing more.
 */
async function requeueProcessing(
  ctx: JobContext,
  settings: Settings,
): Promise<{ requeued: number; errors: number }> {
  const below = sql`${files.mediaRequeues} < ${settings.maxRequeues}`;
  const updated = await rows<{
    id: string;
    owner_id: string;
    s3_key: string;
    copied_from_file_id: string | null;
  }>(
    ctx.db,
    sql`UPDATE ${files}
      SET "media_queued_at" = now(), "media_requeues" = ${files.mediaRequeues} + 1
      WHERE ${files.id} IN (
          SELECT ${files.id} FROM ${files}
          WHERE ${staleProcessing(settings)} AND ${below}
          ORDER BY coalesce(${files.mediaQueuedAt}, ${files.createdAt})
          LIMIT ${settings.batchSize}
        )
        AND ${staleProcessing(settings)} AND ${below}
      RETURNING ${files.id} AS "id", ${files.ownerId} AS "owner_id", ${files.s3Key} AS "s3_key",
        ${files.copiedFromFileId} AS "copied_from_file_id"`,
  );
  const bodies: string[] = [];
  let errors = 0;
  for (const row of updated) {
    try {
      bodies.push(
        row.copied_from_file_id === null
          ? serializeQueueMessage(
              'media',
              originalCompletedMessage({
                fileId: row.id,
                photographerId: row.owner_id,
                key: row.s3_key,
              }),
            )
          : // A copy (POST /drive/files/:id/copy): its pipeline is the copy, not a render.
            serializeQueueMessage('media', {
              kind: 'file.copy',
              fileId: row.id,
              sourceFileId: row.copied_from_file_id,
              photographerId: row.owner_id,
            }),
      );
    } catch (error) {
      // A key this platform didn't build: no message can describe it.
      errors++;
      ctx.log.error('processing row has no valid original key; left for the operator', {
        fileId: row.id,
        ...errorFields(error),
      });
    }
  }
  if (bodies.length > 0) await ctx.queues.sendMessages(ctx.destinations.media, bodies);
  for (const row of updated) {
    ctx.log.info('re-sent the media message of a stale processing file', {
      fileId: row.id,
      kind: row.copied_from_file_id === null ? 'original.completed' : 'file.copy',
    });
  }
  return { requeued: bodies.length, errors };
}

/** Stale `processing` rows that used up their requeues: logged at error level, left as they are. */
async function reportOverCap(ctx: JobContext, settings: Settings): Promise<number> {
  const stuck = await rows<{ id: string }>(
    ctx.db,
    sql`SELECT ${files.id} AS "id" FROM ${files}
      WHERE ${staleProcessing(settings)} AND ${files.mediaRequeues} >= ${settings.maxRequeues}
      ORDER BY coalesce(${files.mediaQueuedAt}, ${files.createdAt})
      LIMIT ${settings.batchSize}`,
  );
  if (stuck.length > 0) {
    ctx.log.error('files stuck in processing after every requeue; the operator must look', {
      count: stuck.length,
      maxRequeues: settings.maxRequeues,
      fileIds: stuck
        .slice(0, MAX_LOGGED_IDS)
        .map((r) => r.id)
        .join(','),
    });
  }
  return stuck.length;
}

/** A `processing`, not purge-requested design image last sent more than the age ago. */
const staleDesignAsset = (settings: Settings) => sql`
  ${designAssets.status} = 'processing'
  AND ${designAssets.purgeRequestedAt} IS NULL
  AND coalesce(${designAssets.queuedAt}, ${designAssets.createdAt})
    < now() - make_interval(secs => ${settings.processingAgeSeconds})`;

/**
 * ADR 0013: re-sends `design.asset` for stale `processing` design images below the requeue cap,
 * bumping `queued_at` and `requeues` in the same guarded UPDATE first (as for files), so
 * concurrent sweeps can't both send and a failed send waits for the next age window.
 */
async function requeueDesignAssets(
  ctx: JobContext,
  settings: Settings,
): Promise<{ requeued: number; overCap: number }> {
  const below = sql`${designAssets.requeues} < ${settings.maxRequeues}`;
  const updated = await rows<{ id: string; owner_id: string }>(
    ctx.db,
    sql`UPDATE ${designAssets}
      SET "queued_at" = now(), "requeues" = ${designAssets.requeues} + 1
      WHERE ${designAssets.id} IN (
          SELECT ${designAssets.id} FROM ${designAssets}
          WHERE ${staleDesignAsset(settings)} AND ${below}
          ORDER BY coalesce(${designAssets.queuedAt}, ${designAssets.createdAt})
          LIMIT ${settings.batchSize}
        )
        AND ${staleDesignAsset(settings)} AND ${below}
      RETURNING ${designAssets.id} AS "id", ${designAssets.ownerId} AS "owner_id"`,
  );
  if (updated.length > 0) {
    await ctx.queues.sendMessages(
      ctx.destinations.media,
      updated.map((row) =>
        serializeQueueMessage('media', {
          kind: 'design.asset',
          assetId: row.id,
          photographerId: row.owner_id,
        }),
      ),
    );
  }
  for (const row of updated) {
    ctx.log.info('re-sent the design.asset message of a stale processing design image', {
      assetId: row.id,
    });
  }
  const stuck = await rows<{ id: string }>(
    ctx.db,
    sql`SELECT ${designAssets.id} AS "id" FROM ${designAssets}
      WHERE ${staleDesignAsset(settings)} AND ${designAssets.requeues} >= ${settings.maxRequeues}
      ORDER BY coalesce(${designAssets.queuedAt}, ${designAssets.createdAt})
      LIMIT ${settings.batchSize}`,
  );
  if (stuck.length > 0) {
    ctx.log.error('design images stuck in processing after every requeue; the operator must look', {
      count: stuck.length,
      maxRequeues: settings.maxRequeues,
      assetIds: stuck
        .slice(0, MAX_LOGGED_IDS)
        .map((r) => r.id)
        .join(','),
    });
  }
  return { requeued: updated.length, overCap: stuck.length };
}

/**
 * ADR 0028: sends `web.rerender` for ready, live images whose web.jpg is over the cap (rendered
 * before it, or under a larger one). No outbox mark: a row stays selected until the worker has
 * rendered it under the cap, and the worker re-checks the row, so a duplicate is a no-op.
 */
async function requeueOversizedWeb(ctx: JobContext, settings: Settings): Promise<number> {
  if (settings.webMaxBytes === 0) return 0;
  const found = await rows<{ id: string; owner_id: string }>(
    ctx.db,
    sql`SELECT ${files.id} AS "id", ${files.ownerId} AS "owner_id" FROM ${files}
      WHERE ${files.status} = 'ready'
        AND ${files.purgeRequestedAt} IS NULL
        AND ${files.webKey} IS NOT NULL
        AND ${files.mime} LIKE 'image/%'
        AND ${files.webSizeBytes} > ${settings.webMaxBytes}
      ORDER BY ${files.id}
      LIMIT ${settings.batchSize}`,
  );
  if (found.length === 0) return 0;
  await ctx.queues.sendMessages(
    ctx.destinations.media,
    found.map((row) =>
      serializeQueueMessage('media', {
        kind: 'web.rerender',
        fileId: row.id,
        photographerId: row.owner_id,
      }),
    ),
  );
  ctx.log.info('sent web.rerender for web.jpg over the cap', {
    count: found.length,
    maxBytes: settings.webMaxBytes,
  });
  return found.length;
}

/**
 * `uploading` rows older than MEDIA_SWEEP_UPLOADING_AGE_SECONDS: when the multipart upload is gone
 * (ListParts) and the object exists with exactly `size_bytes` (HeadObject), the API crashed between
 * CompleteMultipartUpload and markCompleted; complete the row and send `original.completed`. A live
 * upload, a missing object or one of another size is left alone (quota.reconcile.nightly expires
 * abandoned uploads, with the same recovery first).
 */
async function recoverUploads(
  ctx: JobContext,
  settings: Settings,
): Promise<{ recovered: number; left: number; errors: number }> {
  const candidates = await ctx.db
    .select({
      id: files.id,
      ownerId: files.ownerId,
      s3Key: files.s3Key,
      uploadId: files.uploadId,
      sizeBytes: files.sizeBytes,
    })
    .from(files)
    .where(
      and(
        isNotNull(files.uploadId),
        eq(files.status, 'uploading'),
        isNull(files.verifiedAt),
        isNull(files.purgeRequestedAt),
        sql`${files.createdAt} < now() - make_interval(secs => ${settings.uploadingAgeSeconds})`,
      ),
    )
    .orderBy(asc(files.createdAt), asc(files.id))
    .limit(settings.batchSize);
  let recovered = 0;
  let left = 0;
  let errors = 0;
  for (const candidate of candidates) {
    if (!mayContinue(ctx)) break;
    if (candidate.uploadId === null) continue;
    const row = { ...candidate, uploadId: candidate.uploadId };
    const log = ctx.log.child({ fileId: row.id });
    try {
      const stored = await checkOpenUpload(ctx.store, row);
      if (stored !== 'completed') {
        left++;
        continue;
      }
      const done = await recoverCompletedUpload(
        { db: ctx.db, queues: ctx.queues, mediaQueue: ctx.destinations.media },
        row,
      );
      if (done) {
        recovered++;
        log.warn('upload was complete but never marked (markCompleted lost); recovered it');
      }
    } catch (error) {
      errors++;
      log.warn('could not check an open upload; retrying next run', errorFields(error));
    }
  }
  return { recovered, left, errors };
}

/**
 * `media.sweep` (ADR 0008 section 3, "Lost jobs"): restarts media work whose queue message was
 * lost. See SCHEDULED_JOB_TYPES in @shotx/shared for the contract. Idempotent: every step is a
 * guarded UPDATE or a check of storage, and the media consumer tolerates duplicates.
 */
export async function runMediaSweep(
  ctx: JobContext,
  settings: Settings,
): Promise<MediaSweepResult> {
  mayContinue(ctx);
  const processing = await requeueProcessing(ctx, settings);
  const overCap = await reportOverCap(ctx, settings);
  const design = mayContinue(ctx)
    ? await requeueDesignAssets(ctx, settings)
    : { requeued: 0, overCap: 0 };
  const uploads = mayContinue(ctx)
    ? await recoverUploads(ctx, settings)
    : { recovered: 0, left: 0, errors: 0 };
  const webRerenders = mayContinue(ctx) ? await requeueOversizedWeb(ctx, settings) : 0;
  return {
    requeued: processing.requeued,
    overCap,
    designAssetsRequeued: design.requeued,
    designAssetsOverCap: design.overCap,
    webRerenders,
    uploadsRecovered: uploads.recovered,
    uploadsLeft: uploads.left,
    errors: processing.errors + uploads.errors,
    complete: ctx.now() < ctx.deadline,
  };
}
