import { faces, files, folders, subscriptions } from '@shotx/db';
import { faceCollectionId } from '@shotx/face';
import {
  derivedPrefix,
  fileQuotaBucket,
  originalsPrefix,
  subscriptionDeadlines,
} from '@shotx/shared';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { DELETE_OBJECTS_BATCH } from '../../aws/object-store';
import { type Db, rows } from '../../db';
import { errorFields } from '../../logger';
import { applyQuotaMove, releaseMoveFor } from '../../quota';
import { type JobContext, mayContinue } from '../context';
import { reconcileScanKey } from '../orphan-scans';
import { deleteSharesOf } from '../trash-purge';
import {
  insertEvent,
  selectSubscription,
  type SubscriptionJobDeps,
  type SubscriptionRow,
} from './common';

export type PurgeOutcome =
  /** Everything is gone and the subscription is `purged`. */
  | 'purged'
  /** The runtime budget ran out; the next run continues where this one stopped. */
  | 'incomplete'
  /** The subscription is no longer expired and due (renewed meanwhile): stopped at once. */
  | 'not-due'
  /** A newer subscription row owns the photographer's data: only this row was marked purged. */
  | 'superseded';

/** Still `expired` and past purge_at (re-read, optionally under the caller's lock). */
async function stillDue(
  db: Db,
  id: string,
  at: Date,
  deps: SubscriptionJobDeps,
  lock?: 'update' | 'share',
): Promise<SubscriptionRow | null> {
  const row = await selectSubscription(db, id, lock);
  if (row === undefined || row.status !== 'expired') return null;
  const { purgeAt } = subscriptionDeadlines(row.periodEnd, deps.lifecycle);
  return at.getTime() >= purgeAt.getTime() ? row : null;
}

/** True when this is not the photographer's latest subscription row (a history row). */
export async function isSupersededSubscription(db: Db, row: SubscriptionRow): Promise<boolean> {
  const [latest] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.photographerId, row.photographerId))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);
  return latest !== undefined && latest.id !== row.id;
}

class NotDue extends Error {}

/**
 * Step 1: every S3 object under `originals/{photographerId}/` and `derived/{photographerId}/`
 * (prefixes from the shared builders), orphans included, in DeleteObjects batches.
 */
async function deleteObjects(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  at: Date,
): Promise<boolean> {
  for (const prefix of [originalsPrefix(row.photographerId), derivedPrefix(row.photographerId)]) {
    let keys: string[] = [];
    const flush = async () => {
      if (keys.length === 0) return;
      if ((await stillDue(ctx.db, row.id, at, deps)) === null) throw new NotDue();
      await ctx.store.deleteObjects(keys);
      keys = [];
    };
    for await (const object of ctx.store.list(prefix)) {
      keys.push(object.key);
      if (keys.length >= DELETE_OBJECTS_BATCH) {
        await flush();
        if (!mayContinue(ctx)) return false;
      }
    }
    await flush();
    if (!mayContinue(ctx)) return false;
  }
  return true;
}

/**
 * Step 3a: file rows in batches, each in one transaction with the subscription locked FOR SHARE
 * and re-checked (a renewal waits for the batch, and stops the purge after it): faces rows (the
 * collection is already gone), quota released per file bucket, shares of the files with their
 * consents (zip jobs and feedback cascade), then the files. Lock order: subscription, files,
 * storage_usage, as the api's reservation.
 */
async function deleteFileRows(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  at: Date,
): Promise<boolean> {
  const owner = row.photographerId;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: files.id, s3Key: files.s3Key, uploadId: files.uploadId })
      .from(files)
      .where(eq(files.ownerId, owner))
      .orderBy(asc(files.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) return true;
    for (const file of batch) {
      if (file.uploadId === null) continue;
      try {
        await ctx.store.abortMultipartUpload(file.s3Key, file.uploadId);
      } catch (error) {
        // The bucket's 2-day lifecycle rule aborts it anyway.
        ctx.log.warn('AbortMultipartUpload failed during account purge', {
          ...errorFields(error),
          fileId: file.id,
        });
      }
    }
    const ids = batch.map((f) => f.id);
    await ctx.db.transaction(async (tx) => {
      if ((await stillDue(tx, row.id, at, deps, 'share')) === null) throw new NotDue();
      await tx.delete(faces).where(and(eq(faces.ownerId, owner), inArray(faces.fileId, ids)));
      const locked = await tx
        .select({
          id: files.id,
          sizeBytes: files.sizeBytes,
          status: files.status,
          verifiedAt: files.verifiedAt,
          purgeRequestedAt: files.purgeRequestedAt,
        })
        .from(files)
        .where(and(eq(files.ownerId, owner), inArray(files.id, ids)))
        .orderBy(asc(files.id))
        .for('update');
      let used = 0;
      let reserved = 0;
      for (const f of locked) {
        const move = releaseMoveFor(fileQuotaBucket(f));
        if (move === 'releaseUsed') used += f.sizeBytes;
        else if (move === 'releaseReserved') reserved += f.sizeBytes;
      }
      if (used > 0) await applyQuotaMove(tx, owner, 'releaseUsed', used, ctx.log);
      if (reserved > 0) await applyQuotaMove(tx, owner, 'releaseReserved', reserved, ctx.log);
      await deleteSharesOf(tx, 'file', ids);
      await tx.delete(files).where(and(eq(files.ownerId, owner), inArray(files.id, ids)));
    });
  }
  return false;
}

/** Step 3b: folders, leaves first, with their shares and consents. */
async function deleteFolderRows(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  at: Date,
): Promise<boolean> {
  const owner = row.photographerId;
  const leaf = and(
    eq(folders.ownerId, owner),
    sql`NOT EXISTS (SELECT 1 FROM ${files} WHERE ${files.folderId} = ${folders.id})`,
    sql`NOT EXISTS (SELECT 1 FROM ${folders} AS c WHERE c.parent_id = ${folders.id})`,
  );
  while (mayContinue(ctx)) {
    const deleted = await ctx.db.transaction(async (tx) => {
      if ((await stillDue(tx, row.id, at, deps, 'share')) === null) throw new NotDue();
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
    if (deleted === 0) {
      const [left] = await rows<{ n: number | string }>(
        ctx.db,
        sql`SELECT count(*) AS n FROM ${folders} WHERE ${folders.ownerId} = ${owner}`,
      );
      return Number(left?.n ?? 0) === 0;
    }
  }
  return false;
}

/**
 * The purge of an expired account (spec: `purged` SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS after
 * expiry), in batches that resume across runs:
 * 1. delete every S3 object of the photographer (originals and derived, orphans included);
 * 2. delete the Rekognition collection `faceCollectionId(photographerId)` through FaceProvider
 *    (missing is fine), and the faces.reconcile scan state;
 * 3. delete the drive rows in the FK RESTRICT order of trash purge: faces, shares → consents →
 *    files, then folders leaves first with their shares;
 * 4. mark the subscription `purged` with a `purged` event, in one transaction that re-checks it.
 * Billing records (payments, subscriptions, subscription_events, checkouts, notices) are kept,
 * and so are face_deletions (the audit trail of "ขอลบใบหน้าของฉัน", no biometrics).
 *
 * The subscription stays `expired` until the end, so a run that stops (budget, crash) is resumed
 * by the next one simply because the purge is still due, and every step is idempotent (objects
 * and collection already gone are fine; rows are re-selected). Each batch re-checks the status,
 * so a renewal in the middle stops the purge (logged as an error: data is partly gone).
 */
export async function purgeAccount(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  subscriptionId: string,
  at: Date,
): Promise<PurgeOutcome> {
  const row = await stillDue(ctx.db, subscriptionId, at, deps);
  if (row === null) return 'not-due';
  const log = ctx.log.child({ subscriptionId, photographerId: row.photographerId });

  if (await isSupersededSubscription(ctx.db, row)) {
    // History row: the photographer's data now belongs to the newer subscription.
    const marked = await markPurged(ctx, deps, subscriptionId, at, { superseded: true });
    if (marked) log.info('superseded expired subscription marked purged; data kept');
    return marked ? 'superseded' : 'not-due';
  }

  try {
    if (!(await deleteObjects(ctx, deps, row, at))) return 'incomplete';
    if (!mayContinue(ctx)) return 'incomplete';
    await deps.faces.deleteCollection(faceCollectionId(row.photographerId));
    await ctx.store.deleteObjects([reconcileScanKey(row.photographerId)]);
    if (!(await deleteFileRows(ctx, deps, row, at))) return 'incomplete';
    if (!(await deleteFolderRows(ctx, deps, row, at))) return 'incomplete';
  } catch (error) {
    if (error instanceof NotDue) {
      log.error('subscription changed during the account purge; stopped, data partly deleted');
      return 'not-due';
    }
    throw error;
  }

  const marked = await markPurged(ctx, deps, subscriptionId, at, { superseded: false });
  if (!marked) {
    log.error('subscription changed at the end of the account purge; not marked purged');
    return 'not-due';
  }
  log.info('account purged');
  return 'purged';
}

async function markPurged(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  id: string,
  at: Date,
  options: { superseded: boolean },
): Promise<boolean> {
  return ctx.db.transaction(async (tx) => {
    const locked = await stillDue(tx, id, at, deps, 'update');
    if (locked === null) return false;
    if (!options.superseded) {
      const [left] = await tx
        .select({ id: files.id })
        .from(files)
        .where(eq(files.ownerId, locked.photographerId))
        .limit(1);
      const [leftFolder] = await tx
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.ownerId, locked.photographerId))
        .limit(1);
      if (left !== undefined || leftFolder !== undefined) return false;
    }
    await tx
      .update(subscriptions)
      .set({ status: 'purged', updatedAt: at })
      .where(eq(subscriptions.id, id));
    await insertEvent(tx, locked, {
      type: 'purged',
      fromStatus: 'expired',
      toStatus: 'purged',
      fromPlanId: locked.planId,
      toPlanId: locked.planId,
      periodEndBefore: locked.periodEnd,
      periodEndAfter: locked.periodEnd,
      meta: options.superseded ? { superseded: true } : {},
    });
    return true;
  });
}
