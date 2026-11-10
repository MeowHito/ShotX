import { plans, storageUsage, subscriptions } from '@shotx/db';
import {
  availableBytes,
  type QuotaState,
  type StorageUsageCounters,
  type SubscriptionStatus,
  subscriptionAllowsUploads,
} from '@shotx/shared';
import { desc, eq, sql } from 'drizzle-orm';
import { type ApiConfig, billingOnline } from '../config';
import type { Queryable } from '../db/db';

/**
 * What gates uploads and copies (ADR 0010): the subscription only with BILLING_MODE=gateway, the
 * plan quota only with STORAGE_QUOTA_ENFORCED. Both off (the defaults): nothing but the per-file
 * limits and the MIME allowlist; storage_usage is still reserved and released exactly.
 */
export interface UploadGate {
  subscription: boolean;
  quota: boolean;
}

export function uploadGate(config: Pick<ApiConfig, 'billingMode' | 'storageQuota'>): UploadGate {
  return { subscription: billingOnline(config), quota: config.storageQuota.enforced };
}

/**
 * Why uploads are blocked right now under `gate` (GET /drive/usage `uploadsBlockedBy`): the
 * subscription first, then a full quota, each only when it gates; null when uploads are possible.
 */
export function uploadsBlockedUnder(
  gate: UploadGate,
  status: SubscriptionStatus | null,
  state: QuotaState,
): 'SUBSCRIPTION_INACTIVE' | 'QUOTA_EXCEEDED' | null {
  if (gate.subscription && !subscriptionAllowsUploads(status)) return 'SUBSCRIPTION_INACTIVE';
  if (gate.quota && availableBytes(state) === 0) return 'QUOTA_EXCEEDED';
  return null;
}

/** Subscription statuses that hold the photographer's one live subscription. */
const LIVE = sql`${subscriptions.status} IN ('trial', 'active', 'grace')`;

export interface SubscriptionInfo {
  status: SubscriptionStatus;
  planCode: string;
  periodEnd: Date;
  /** The plan's quota if this subscription is live, else 0. */
  quotaBytes: number;
}

/**
 * The live subscription (trial, active or grace), or else the latest one (expired or purged),
 * or null when the photographer never had one. Status is maintained by the daily
 * `subscriptions.transition.daily` job and trusted here.
 *
 * `lock: 'share'` (inside a transaction) locks the subscription row FOR SHARE, so a quota read for
 * an upload reservation serialises with a plan change (checkout and webhook transactions lock it
 * FOR UPDATE): the reservation sees either the old or the new quota, never a change halfway.
 */
export async function currentSubscription(
  q: Queryable,
  ownerId: string,
  options: { lock?: 'share' } = {},
): Promise<SubscriptionInfo | null> {
  const query = q
    .select({
      status: subscriptions.status,
      periodEnd: subscriptions.periodEnd,
      planCode: plans.code,
      quotaBytes: plans.quotaBytes,
      live: sql<boolean>`${LIVE}`,
    })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.photographerId, ownerId))
    .orderBy(desc(LIVE), desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);
  const [row] = await (options.lock === 'share'
    ? query.for('share', { of: subscriptions })
    : query);
  if (row === undefined) return null;
  return {
    status: row.status,
    planCode: row.planCode,
    periodEnd: row.periodEnd,
    quotaBytes: row.live ? row.quotaBytes : 0,
  };
}

/** The photographer's counters (zero when there is no row yet). */
export async function storageCounters(
  q: Queryable,
  ownerId: string,
): Promise<StorageUsageCounters> {
  const [row] = await q
    .select({ usedBytes: storageUsage.usedBytes, reservedBytes: storageUsage.reservedBytes })
    .from(storageUsage)
    .where(eq(storageUsage.photographerId, ownerId));
  return row ?? { usedBytes: 0, reservedBytes: 0 };
}

/**
 * Reserves `bytes` against `quotaBytes` in one guarded statement (`used + reserved + bytes <=
 * quota`, creating the counters row when missing). True when reserved; false when the quota
 * doesn't allow it. `quotaBytes` null (STORAGE_QUOTA_ENFORCED=false): reserved unconditionally,
 * the same counters, no limit. Run it inside the transaction that inserts the row the bytes are
 * for.
 */
export async function reserveQuotaBytes(
  q: Queryable,
  ownerId: string,
  bytes: number,
  quotaBytes: number | null,
): Promise<boolean> {
  if (quotaBytes === null) {
    await q.execute(
      sql`INSERT INTO ${storageUsage} (photographer_id, used_bytes, reserved_bytes)
          VALUES (${ownerId}::uuid, 0, ${bytes}::bigint)
          ON CONFLICT (photographer_id) DO UPDATE
            SET reserved_bytes = ${storageUsage}.reserved_bytes + EXCLUDED.reserved_bytes`,
    );
    return true;
  }
  const reserved = await q.execute(
    sql`INSERT INTO ${storageUsage} (photographer_id, used_bytes, reserved_bytes)
        SELECT ${ownerId}::uuid, 0, ${bytes}::bigint WHERE ${bytes}::bigint <= ${quotaBytes}::bigint
        ON CONFLICT (photographer_id) DO UPDATE
          SET reserved_bytes = ${storageUsage}.reserved_bytes + EXCLUDED.reserved_bytes
          WHERE ${storageUsage}.used_bytes + ${storageUsage}.reserved_bytes + EXCLUDED.reserved_bytes <= ${quotaBytes}::bigint
        RETURNING used_bytes::text`,
  );
  return (reserved as { rows: unknown[] }).rows.length > 0;
}
