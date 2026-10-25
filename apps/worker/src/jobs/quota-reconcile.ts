import { files, storageUsage } from '@shotx/db';
import { expectedUsage, fileQuotaBucket, originalsPrefix } from '@shotx/shared';
import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { isUuid, rows } from '../db';
import { errorFields } from '../logger';
import { applyQuotaMove, lockUsage, writeUsage } from '../quota';
import { chunk, type JobContext, mayContinue } from './context';

export interface QuotaReconcileResult {
  uploadsExpired: number;
  uploadsSkipped: number;
  photographersChecked: number;
  /** Photographers whose storage_usage counters were corrected. */
  countersFixed: number;
  /** Photographers whose S3 originals disagree with their rows (reported only). */
  s3Drift: number;
  complete: boolean;
}

/**
 * Upload sessions past `upload_expires_at` that never completed: abort the multipart upload, then
 * delete the row and release its reservation in one guarded transaction (the same guard as
 * `DELETE /uploads/:id`), then delete any object that made it to S3.
 */
async function expireAbandonedUploads(
  ctx: JobContext,
): Promise<{ expired: number; skipped: number }> {
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
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: files.id, s3Key: files.s3Key, uploadId: files.uploadId })
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
          await ctx.store.abortMultipartUpload(upload.s3Key, upload.uploadId);
        }
        const removed = await ctx.db.transaction(async (tx) => {
          const [row] = await tx
            .delete(files)
            .where(and(eq(files.id, upload.id), abandoned))
            .returning({ ownerId: files.ownerId, sizeBytes: files.sizeBytes });
          if (row === undefined) return false;
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
  return { expired, skipped: skippedIds.size };
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
    const expected = expectedUsage(owned);
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
  // so a verified row missing from the later listing is real drift (purges excluded).
  const fileRows = await ctx.db
    .select({
      s3Key: files.s3Key,
      status: files.status,
      verifiedAt: files.verifiedAt,
      purgeRequestedAt: files.purgeRequestedAt,
      sizeBytes: files.sizeBytes,
    })
    .from(files)
    .where(eq(files.ownerId, photographerId));
  const listed = new Map<string, number>();
  for await (const object of ctx.store.list(originalsPrefix(photographerId))) {
    listed.set(object.key, object.size);
  }
  const known = new Set(fileRows.map((r) => r.s3Key));
  let candidates = [...listed.keys()].filter((key) => !known.has(key));
  // Rows created after the read above (new uploads) are not orphans: look them up again.
  for (const keys of chunk(candidates, 500)) {
    const found = await ctx.db
      .select({ s3Key: files.s3Key })
      .from(files)
      .where(inArray(files.s3Key, keys));
    const foundKeys = new Set(found.map((r) => r.s3Key));
    candidates = candidates.filter((k) => !foundKeys.has(k));
  }
  const counted = fileRows.filter((r) => fileQuotaBucket(r) === 'used');
  const missing = counted.filter((r) => !listed.has(r.s3Key));
  const sizeMismatch = counted.filter((r) => {
    const size = listed.get(r.s3Key);
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
 * `quota.reconcile.nightly`. First expires abandoned uploads (so their reservations are gone),
 * then per photographer recomputes storage_usage from `expectedUsage(files)` and fixes the
 * counters, and compares the rows with the objects under `originals/{photographerId}/`, reporting
 * drift. Idempotent: every step recomputes from the current state.
 */
export async function runQuotaReconcile(ctx: JobContext): Promise<QuotaReconcileResult> {
  const uploads = await expireAbandonedUploads(ctx);
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
    uploadsSkipped: uploads.skipped,
    photographersChecked: checked,
    countersFixed,
    s3Drift,
    complete: ctx.now() < ctx.deadline,
  };
}
