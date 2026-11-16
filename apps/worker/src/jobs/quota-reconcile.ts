import { designAssets, files, photographerPackages, storageUsage } from '@shotx/db';
import {
  designAssetKey,
  designAssetsPrefix,
  expectedUsage,
  fileQuotaBucket,
  type FileStatus,
  originalsPrefix,
  parseS3Key,
} from '@shotx/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { isUuid, rows } from '../db';
import { errorFields } from '../logger';
import { recoverCompletedUpload, storedOriginal } from '../media/recovery';
import { applyQuotaMove, lockUsage, writeUsage } from '../quota';
import { chunk, type JobContext, mayContinue } from './context';

export interface QuotaReconcileResult {
  uploadsExpired: number;
  /** Expired upload rows whose object was complete: completed and sent to the media pipeline. */
  uploadsRecovered: number;
  uploadsSkipped: number;
  /** Design image uploads (ADR 0013) past `upload_expires_at`: failed, reservation released. */
  designUploadsExpired: number;
  designUploadsSkipped: number;
  photographersChecked: number;
  /** Photographers whose storage_usage counters were corrected. */
  countersFixed: number;
  /** Photographers whose S3 originals disagree with their rows (reported only). */
  s3Drift: number;
  complete: boolean;
}

/**
 * Upload sessions past `upload_expires_at` that never completed: abort the multipart upload, then
 * HeadObject. An object of exactly the declared size means CompleteMultipartUpload succeeded and
 * the API's markCompleted was lost: the row is completed and sent to the media pipeline
 * (recoverCompletedUpload), never deleted. Otherwise delete the row, give its photo back to the
 * package (ADR 0026) and release its reservation in one guarded transaction (the same guard and
 * lock order as `DELETE /uploads/:id`), then delete any object that made it to storage.
 */
async function expireAbandonedUploads(
  ctx: JobContext,
): Promise<{ expired: number; recovered: number; skipped: number }> {
  const now = new Date(ctx.now());
  const abandoned = and(
    isNotNull(files.uploadId),
    lt(files.uploadExpiresAt, now),
    eq(files.status, 'uploading'),
    isNull(files.verifiedAt),
    isNull(files.purgeRequestedAt),
  );
  const skippedIds = new Set<string>();
  let expired = 0;
  let recovered = 0;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({
        id: files.id,
        ownerId: files.ownerId,
        s3Key: files.s3Key,
        uploadId: files.uploadId,
        sizeBytes: files.sizeBytes,
      })
      .from(files)
      .where(
        skippedIds.size === 0 ? abandoned : and(abandoned, notInArray(files.id, [...skippedIds])),
      )
      .orderBy(asc(files.uploadExpiresAt), asc(files.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    for (const upload of batch) {
      const log = ctx.log.child({ fileId: upload.id });
      try {
        if (upload.uploadId !== null) {
          // Abort first: after it no CompleteMultipartUpload can still succeed, so the HeadObject
          // below is the final answer.
          await ctx.store.abortMultipartUpload(upload.s3Key, upload.uploadId);
          if ((await storedOriginal(ctx.store, upload)) === 'completed') {
            const done = await recoverCompletedUpload(
              { db: ctx.db, queues: ctx.queues, mediaQueue: ctx.destinations.media },
              { ...upload, uploadId: upload.uploadId },
            );
            if (done) {
              recovered++;
              log.warn('expired upload was complete (markCompleted lost); recovered it');
            }
            continue;
          }
        }
        const removed = await ctx.db.transaction(async (tx) => {
          const [row] = await tx
            .delete(files)
            .where(and(eq(files.id, upload.id), abandoned))
            .returning({ ownerId: files.ownerId, sizeBytes: files.sizeBytes });
          if (row === undefined) return false;
          // ADR 0026: an abandoned upload counts as an abort: its photo goes back to the package
          // (never below 0; no package row: unlimited, nothing to do). Before storage_usage, the
          // api's lock order (photographer_packages, then storage_usage).
          await tx
            .update(photographerPackages)
            .set({
              photosUsed: sql`greatest(0, ${photographerPackages.photosUsed} - 1)`,
              updatedAt: now,
            })
            .where(eq(photographerPackages.photographerId, row.ownerId));
          await applyQuotaMove(tx, row.ownerId, 'releaseReserved', row.sizeBytes, log);
          return true;
        });
        if (removed) {
          // A completed object without a verified row must not stay outside the quota.
          await ctx.store.deleteObjects([upload.s3Key]);
          expired++;
        }
      } catch (error) {
        log.warn('could not expire an abandoned upload; retrying next run', errorFields(error));
        skippedIds.add(upload.id);
      }
    }
  }
  return { expired, recovered, skipped: skippedIds.size };
}

/**
 * ADR 0013: design image uploads still `uploading` past `upload_expires_at` (one presigned PUT, no
 * multipart upload to recover): `failed` with the reservation released in one guarded
 * transaction, then the `original` object, if the PUT made it, is deleted. A failed asset is
 * later orphan-purged with its row by trash.purge.daily.
 */
async function expireDesignUploads(ctx: JobContext): Promise<{ expired: number; skipped: number }> {
  const now = new Date(ctx.now());
  const abandoned = and(
    eq(designAssets.status, 'uploading'),
    lt(designAssets.uploadExpiresAt, now),
    isNull(designAssets.verifiedAt),
    isNull(designAssets.purgeRequestedAt),
  );
  const skippedIds = new Set<string>();
  let expired = 0;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: designAssets.id, ownerId: designAssets.ownerId })
      .from(designAssets)
      .where(
        skippedIds.size === 0
          ? abandoned
          : and(abandoned, notInArray(designAssets.id, [...skippedIds])),
      )
      .orderBy(asc(designAssets.uploadExpiresAt), asc(designAssets.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    for (const upload of batch) {
      const log = ctx.log.child({ assetId: upload.id });
      try {
        const failed = await ctx.db.transaction(async (tx) => {
          const [row] = await tx
            .update(designAssets)
            .set({ status: 'failed' })
            .where(and(eq(designAssets.id, upload.id), abandoned))
            .returning({ ownerId: designAssets.ownerId, sizeBytes: designAssets.sizeBytes });
          if (row === undefined) return false;
          await applyQuotaMove(tx, row.ownerId, 'releaseReserved', row.sizeBytes, log);
          return true;
        });
        if (failed) {
          await ctx.store.deleteObjects([
            designAssetKey({ photographerId: upload.ownerId, assetId: upload.id }, 'original'),
          ]);
          expired++;
        }
      } catch (error) {
        log.warn('could not expire an abandoned design image upload; retrying next run', {
          ...errorFields(error),
        });
        skippedIds.add(upload.id);
      }
    }
  }
  return { expired, skipped: skippedIds.size };
}

interface QuotaRowFields {
  status: FileStatus;
  verifiedAt: Date | null;
  purgeRequestedAt: Date | null;
  sizeBytes: number;
}

/** A counted object: a drive original or a design image's `original` (ADR 0013). */
interface StoredRow extends QuotaRowFields {
  key: string;
}

/** The photographer's design image rows with their `original` keys. */
async function designRows(db: JobContext['db'], photographerId: string): Promise<StoredRow[]> {
  const owned = await db
    .select({
      id: designAssets.id,
      status: designAssets.status,
      verifiedAt: designAssets.verifiedAt,
      purgeRequestedAt: designAssets.purgeRequestedAt,
      sizeBytes: designAssets.sizeBytes,
    })
    .from(designAssets)
    .where(eq(designAssets.ownerId, photographerId));
  return owned.map(({ id, ...fields }) => ({
    ...fields,
    key: designAssetKey({ photographerId, assetId: id }, 'original'),
  }));
}

interface Drift {
  countersFixed: boolean;
  s3Drift: boolean;
}

async function reconcilePhotographer(ctx: JobContext, photographerId: string): Promise<Drift> {
  const log = ctx.log.child({ photographerId });
  // Counters: lock storage_usage first, then read the files. Every quota transition updates
  // storage_usage in the same transaction as the file row, so after the lock the files read is
  // consistent with the counters.
  const countersFixed = await ctx.db.transaction(async (tx) => {
    const before = await lockUsage(tx, photographerId);
    const owned = await tx
      .select({
        status: files.status,
        verifiedAt: files.verifiedAt,
        purgeRequestedAt: files.purgeRequestedAt,
        sizeBytes: files.sizeBytes,
      })
      .from(files)
      .where(eq(files.ownerId, photographerId));
    // Design images count like originals (ADR 0013); the same lock covers their transitions.
    const expected = expectedUsage([...owned, ...(await designRows(tx, photographerId))]);
    if (
      expected.usedBytes === before.usedBytes &&
      expected.reservedBytes === before.reservedBytes
    ) {
      return false;
    }
    await writeUsage(tx, photographerId, expected);
    log.warn('storage_usage drift corrected', {
      usedBefore: before.usedBytes,
      usedAfter: expected.usedBytes,
      reservedBefore: before.reservedBytes,
      reservedAfter: expected.reservedBytes,
    });
    return true;
  });

  // S3: rows first, then the listing. A verified row's object existed before it was verified,
  // so a verified row missing from the later listing is real drift (purges excluded). Design
  // images: only their `original` objects count (web.webp is a derivative).
  const fileRows: StoredRow[] = (
    await ctx.db
      .select({
        s3Key: files.s3Key,
        status: files.status,
        verifiedAt: files.verifiedAt,
        purgeRequestedAt: files.purgeRequestedAt,
        sizeBytes: files.sizeBytes,
      })
      .from(files)
      .where(eq(files.ownerId, photographerId))
  ).map(({ s3Key, ...fields }) => ({ ...fields, key: s3Key }));
  const assetRows = await designRows(ctx.db, photographerId);
  const listed = new Map<string, number>();
  for await (const object of ctx.store.list(originalsPrefix(photographerId))) {
    listed.set(object.key, object.size);
  }
  let designOriginals = 0;
  for await (const object of ctx.store.list(designAssetsPrefix(photographerId))) {
    const parsed = parseS3Key(object.key);
    if (parsed?.kind !== 'designAsset' || parsed.variant !== 'original') continue;
    listed.set(object.key, object.size);
    designOriginals++;
  }
  const allRows = [...fileRows, ...assetRows];
  const known = new Set(allRows.map((r) => r.key));
  let candidates = [...listed.keys()].filter((key) => !known.has(key));
  // Rows created after the read above (new uploads) are not orphans: look them up again.
  for (const keys of chunk(candidates, 500)) {
    // Design originals are looked up by asset id, drive originals by key.
    const keyByAssetId = new Map<string, string>();
    const fileKeys: string[] = [];
    for (const key of keys) {
      const parsed = parseS3Key(key);
      if (parsed?.kind === 'designAsset') {
        if (isUuid(parsed.assetId)) keyByAssetId.set(parsed.assetId, key);
      } else {
        fileKeys.push(key);
      }
    }
    const foundKeys = new Set<string>();
    if (fileKeys.length > 0) {
      const found = await ctx.db
        .select({ s3Key: files.s3Key })
        .from(files)
        .where(inArray(files.s3Key, fileKeys));
      for (const r of found) foundKeys.add(r.s3Key);
    }
    if (keyByAssetId.size > 0) {
      const found = await ctx.db
        .select({ id: designAssets.id })
        .from(designAssets)
        .where(
          and(
            eq(designAssets.ownerId, photographerId),
            inArray(designAssets.id, [...keyByAssetId.keys()]),
          ),
        );
      for (const r of found) {
        const key = keyByAssetId.get(r.id);
        if (key !== undefined) foundKeys.add(key);
      }
    }
    candidates = candidates.filter((k) => !foundKeys.has(k));
  }
  const counted = allRows.filter((r) => fileQuotaBucket(r) === 'used');
  const missing = counted.filter((r) => !listed.has(r.key));
  const sizeMismatch = counted.filter((r) => {
    const size = listed.get(r.key);
    return size !== undefined && size !== r.sizeBytes;
  });
  const orphanBytes = candidates.reduce((sum, key) => sum + (listed.get(key) ?? 0), 0);
  const s3Bytes = [...listed.values()].reduce((a, b) => a + b, 0);
  const s3Drift = candidates.length > 0 || missing.length > 0 || sizeMismatch.length > 0;
  if (s3Drift) {
    // Reported, not repaired: deleting objects or rows on a listing is left to an operator.
    log.warn('S3 originals disagree with the files rows', {
      s3Objects: listed.size,
      s3Bytes,
      designOriginals,
      usedBytes: counted.reduce((sum, r) => sum + r.sizeBytes, 0),
      orphanObjects: candidates.length,
      orphanBytes,
      missingObjects: missing.length,
      sizeMismatches: sizeMismatch.length,
    });
  }
  return { countersFixed, s3Drift };
}

/**
 * `quota.reconcile.nightly`. First expires abandoned uploads, drive and design images (so their
 * reservations are gone), then per photographer recomputes storage_usage from
 * `expectedUsage(files + design_assets)` and fixes the counters, and compares the rows with the
 * objects under `originals/{photographerId}/` and the `original` objects under
 * `designs/{photographerId}/`, reporting drift. Idempotent: every step recomputes from the current state.
 */
export async function runQuotaReconcile(ctx: JobContext): Promise<QuotaReconcileResult> {
  const uploads = await expireAbandonedUploads(ctx);
  const designUploads = await expireDesignUploads(ctx);
  let cursor = '00000000-0000-0000-0000-000000000000';
  let checked = 0;
  let countersFixed = 0;
  let s3Drift = 0;
  while (mayContinue(ctx)) {
    const batch = await rows<{ id: string }>(
      ctx.db,
      sql`SELECT id FROM (
            SELECT ${storageUsage.photographerId} AS id FROM ${storageUsage}
            UNION SELECT DISTINCT ${files.ownerId} AS id FROM ${files}
            UNION SELECT DISTINCT ${designAssets.ownerId} AS id FROM ${designAssets}
          ) AS photographers
          WHERE id > ${cursor}::uuid ORDER BY id LIMIT ${ctx.batchSize}`,
    );
    if (batch.length === 0) break;
    cursor = batch.at(-1)!.id;
    for (const { id } of batch) {
      if (!mayContinue(ctx)) break;
      if (!isUuid(id)) continue;
      try {
        const drift = await reconcilePhotographer(ctx, id);
        checked++;
        if (drift.countersFixed) countersFixed++;
        if (drift.s3Drift) s3Drift++;
      } catch (error) {
        ctx.log.warn('reconciliation failed for a photographer', {
          ...errorFields(error),
          photographerId: id,
        });
      }
    }
  }
  return {
    uploadsExpired: uploads.expired,
    uploadsRecovered: uploads.recovered,
    uploadsSkipped: uploads.skipped,
    designUploadsExpired: designUploads.expired,
    designUploadsSkipped: designUploads.skipped,
    photographersChecked: checked,
    countersFixed,
    s3Drift,
    complete: ctx.now() < ctx.deadline,
  };
}
