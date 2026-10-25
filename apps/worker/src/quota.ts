import { storageUsage } from '@shotx/db';
import {
  commitReservation,
  type QuotaBucket,
  releaseReservation,
  releaseUsed,
  type StorageUsageCounters,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import type { Db } from './db';
import type { Logger } from './logger';

/**
 * Locks a photographer's storage_usage row (FOR UPDATE), creating it at 0/0 if it is missing.
 * Call inside a transaction, after locking the `files` rows involved (lock order: files, then
 * storage_usage, as the API does).
 */
export async function lockUsage(tx: Db, photographerId: string): Promise<StorageUsageCounters> {
  await tx.insert(storageUsage).values({ photographerId }).onConflictDoNothing();
  const [row] = await tx
    .select({ usedBytes: storageUsage.usedBytes, reservedBytes: storageUsage.reservedBytes })
    .from(storageUsage)
    .where(eq(storageUsage.photographerId, photographerId))
    .for('update');
  if (row === undefined) throw new Error('storage_usage row vanished inside the transaction');
  return row;
}

export async function writeUsage(
  tx: Db,
  photographerId: string,
  counters: StorageUsageCounters,
): Promise<void> {
  await tx
    .update(storageUsage)
    .set({ usedBytes: counters.usedBytes, reservedBytes: counters.reservedBytes })
    .where(eq(storageUsage.photographerId, photographerId));
}

/** A quota transition of drive/quota in @shotx/shared. */
export type QuotaMove =
  /** The worker verified the object: reserved -> used. */
  | 'commit'
  /** Rejected bytes, an expired upload: reserved -= size. */
  | 'releaseReserved'
  /** Purge of a verified file: used -= size. */
  | 'releaseUsed';

function apply(move: QuotaMove, usage: StorageUsageCounters, size: number): StorageUsageCounters {
  switch (move) {
    case 'commit':
      return commitReservation(usage, size);
    case 'releaseReserved':
      return releaseReservation(usage, size);
    case 'releaseUsed':
      return releaseUsed(usage, size);
  }
}

function clamped(move: QuotaMove, usage: StorageUsageCounters, size: number): StorageUsageCounters {
  const reserved = Math.max(0, usage.reservedBytes - size);
  const used = Math.max(0, usage.usedBytes - size);
  switch (move) {
    case 'commit':
      return { usedBytes: usage.usedBytes + size, reservedBytes: reserved };
    case 'releaseReserved':
      return { usedBytes: usage.usedBytes, reservedBytes: reserved };
    case 'releaseUsed':
      return { usedBytes: used, reservedBytes: usage.reservedBytes };
  }
}

/**
 * Applies one quota transition inside the caller's transaction, after the guarded row update
 * that causes it. Counters that are already off (less reserved than the file's size) are clamped
 * at 0 with a warning instead of failing the message forever; `quota.reconcile.nightly`
 * recomputes them from the files.
 */
export async function applyQuotaMove(
  tx: Db,
  photographerId: string,
  move: QuotaMove,
  sizeBytes: number,
  log: Logger,
): Promise<StorageUsageCounters> {
  const before = await lockUsage(tx, photographerId);
  let after: StorageUsageCounters;
  try {
    after = apply(move, before, sizeBytes);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    log.warn('storage_usage is off; clamping at 0 until the nightly reconciliation', {
      photographerId,
      move,
      sizeBytes,
      usedBytes: before.usedBytes,
      reservedBytes: before.reservedBytes,
    });
    after = clamped(move, before, sizeBytes);
  }
  await writeUsage(tx, photographerId, after);
  return after;
}

/** The transition that takes a file's bytes out of `bucket` (purge requests). */
export function releaseMoveFor(bucket: QuotaBucket): QuotaMove | null {
  if (bucket === 'used') return 'releaseUsed';
  if (bucket === 'reserved') return 'releaseReserved';
  return null;
}
