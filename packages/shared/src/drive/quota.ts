import type { FileStatus, SubscriptionStatus } from '../domain';
import { ErrorCode } from '../errors';

/**
 * Quota accounting. Quota counts originals only, trash included, until the file is purged.
 * `storage_usage` holds two counters per photographer, and every file is in exactly one bucket
 * ({@link fileQuotaBucket}):
 *
 *   reserved_bytes  files not yet verified by the worker (`verified_at IS NULL`, not failed)
 *   used_bytes      files the worker verified (`verified_at IS NOT NULL`)
 *   neither         failed files, and files whose purge was requested (`purge_requested_at`)
 *
 * Every transition moves a file's `size_bytes` between buckets in the same transaction as the
 * row change that causes it, guarded so a retry (SQS delivers at least once) moves nothing twice:
 *
 *   POST /uploads/init     insert row (uploading)                  reserved += size
 *                          only if used + reserved + size <= quota  (else QUOTA_EXCEEDED)
 *   DELETE /uploads/:id    delete row WHERE status = 'uploading'
 *                            AND verified_at IS NULL AND purge_requested_at IS NULL
 *                                                                  reserved -= size
 *   worker verifies        SET verified_at WHERE verified_at IS NULL
 *                            AND status <> 'failed' AND purge_requested_at IS NULL
 *                                                                  reserved -= size, used += size
 *   worker rejects bytes   SET status = 'failed' WHERE verified_at IS NULL
 *                            AND status <> 'failed' AND purge_requested_at IS NULL
 *                                                                  reserved -= size
 *   purge requested        SET purge_requested_at WHERE purge_requested_at IS NULL
 *   (empty trash, or the   (lock rows FOR UPDATE; bucket from the row)
 *   30-day trash purge)                                            that bucket -= size
 *
 * The reservation itself must be one guarded statement, so concurrent inits can't both pass:
 *
 *   INSERT INTO storage_usage (photographer_id, reserved_bytes) VALUES ($p, $size)
 *   ON CONFLICT (photographer_id) DO UPDATE
 *     SET reserved_bytes = storage_usage.reserved_bytes + EXCLUDED.reserved_bytes
 *     WHERE storage_usage.used_bytes + storage_usage.reserved_bytes + EXCLUDED.reserved_bytes <= $quota
 *   RETURNING used_bytes, reserved_bytes
 *
 * (no row returned: QUOTA_EXCEEDED; the fresh-insert branch must also check `$size <= $quota`).
 * The helpers below are the same arithmetic in TypeScript, for responses, tests and the nightly
 * reconciliation.
 */
export interface StorageUsageCounters {
  usedBytes: number;
  reservedBytes: number;
}

export interface QuotaState extends StorageUsageCounters {
  quotaBytes: number;
}

function assertBytes(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${value}`);
  }
}

function assertState(state: QuotaState): void {
  assertBytes('usedBytes', state.usedBytes);
  assertBytes('reservedBytes', state.reservedBytes);
  assertBytes('quotaBytes', state.quotaBytes);
}

/** Bytes still free: `quota - used - reserved`, never below 0 (a downgrade can overshoot). */
export function availableBytes(state: QuotaState): number {
  assertState(state);
  return Math.max(0, state.quotaBytes - state.usedBytes - state.reservedBytes);
}

/** True when `used + reserved + size <= quota`. */
export function canReserve(state: QuotaState, sizeBytes: number): boolean {
  assertState(state);
  assertBytes('sizeBytes', sizeBytes);
  return state.usedBytes + state.reservedBytes + sizeBytes <= state.quotaBytes;
}

export type ReserveResult =
  | { ok: true; usage: StorageUsageCounters }
  | {
      ok: false;
      code: typeof ErrorCode.QUOTA_EXCEEDED;
      details: {
        quotaBytes: number;
        usedBytes: number;
        reservedBytes: number;
        requestedBytes: number;
        availableBytes: number;
      };
    };

/** Reserves `sizeBytes`, or explains the QUOTA_EXCEEDED (the error's `details`). */
export function reserveQuota(state: QuotaState, sizeBytes: number): ReserveResult {
  if (!canReserve(state, sizeBytes)) {
    return {
      ok: false,
      code: ErrorCode.QUOTA_EXCEEDED,
      details: {
        quotaBytes: state.quotaBytes,
        usedBytes: state.usedBytes,
        reservedBytes: state.reservedBytes,
        requestedBytes: sizeBytes,
        availableBytes: availableBytes(state),
      },
    };
  }
  return {
    ok: true,
    usage: { usedBytes: state.usedBytes, reservedBytes: state.reservedBytes + sizeBytes },
  };
}

/** The worker verified the object: its bytes move from reserved to used. */
export function commitReservation(
  usage: StorageUsageCounters,
  sizeBytes: number,
): StorageUsageCounters {
  assertBytes('sizeBytes', sizeBytes);
  if (usage.reservedBytes < sizeBytes) {
    throw new RangeError('Cannot commit more bytes than are reserved');
  }
  return { usedBytes: usage.usedBytes + sizeBytes, reservedBytes: usage.reservedBytes - sizeBytes };
}

/** Abort, rejection or purge of an unverified file: its reservation is released. */
export function releaseReservation(
  usage: StorageUsageCounters,
  sizeBytes: number,
): StorageUsageCounters {
  assertBytes('sizeBytes', sizeBytes);
  if (usage.reservedBytes < sizeBytes) {
    throw new RangeError('Cannot release more bytes than are reserved');
  }
  return { usedBytes: usage.usedBytes, reservedBytes: usage.reservedBytes - sizeBytes };
}

/** Purge of a verified file: its bytes leave used. */
export function releaseUsed(usage: StorageUsageCounters, sizeBytes: number): StorageUsageCounters {
  assertBytes('sizeBytes', sizeBytes);
  if (usage.usedBytes < sizeBytes) {
    throw new RangeError('Cannot release more bytes than are used');
  }
  return { usedBytes: usage.usedBytes - sizeBytes, reservedBytes: usage.reservedBytes };
}

export type QuotaBucket = 'reserved' | 'used' | 'none';

export interface FileQuotaFields {
  status: FileStatus;
  verifiedAt: Date | string | null;
  purgeRequestedAt: Date | string | null;
}

/** Which storage_usage counter a file's bytes are in (see the table above). */
export function fileQuotaBucket(file: FileQuotaFields): QuotaBucket {
  if (file.purgeRequestedAt !== null) return 'none';
  if (file.verifiedAt !== null) return 'used';
  if (file.status === 'failed') return 'none';
  return 'reserved';
}

/** Expected counters for a set of files: what the nightly reconciliation compares against. */
export function expectedUsage(
  files: Iterable<FileQuotaFields & { sizeBytes: number }>,
): StorageUsageCounters {
  let usedBytes = 0;
  let reservedBytes = 0;
  for (const file of files) {
    assertBytes('sizeBytes', file.sizeBytes);
    const bucket = fileQuotaBucket(file);
    if (bucket === 'used') usedBytes += file.sizeBytes;
    else if (bucket === 'reserved') reservedBytes += file.sizeBytes;
  }
  return { usedBytes, reservedBytes };
}

/**
 * Subscription statuses that may upload: `trial` and `active`. In `grace`, `expired` and `purged`
 * uploads are blocked (SUBSCRIPTION_INACTIVE) while drive browsing, rename, move, trash and
 * restore keep working.
 */
export const UPLOAD_ALLOWED_SUBSCRIPTION_STATUSES = [
  'trial',
  'active',
] as const satisfies readonly SubscriptionStatus[];

export function subscriptionAllowsUploads(status: SubscriptionStatus | null): boolean {
  return (
    status !== null && (UPLOAD_ALLOWED_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Why the studio can't upload right now, for `GET /drive/usage`: the subscription first, then a
 * full quota (also after a downgrade below current usage). Null when uploads are possible.
 */
export function uploadsBlockedBy(
  status: SubscriptionStatus | null,
  state: QuotaState,
): typeof ErrorCode.SUBSCRIPTION_INACTIVE | typeof ErrorCode.QUOTA_EXCEEDED | null {
  if (!subscriptionAllowsUploads(status)) return ErrorCode.SUBSCRIPTION_INACTIVE;
  if (availableBytes(state) === 0) return ErrorCode.QUOTA_EXCEEDED;
  return null;
}
