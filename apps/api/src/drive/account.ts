import { plans, storageUsage, subscriptions } from '@shotx/db';
import type { StorageUsageCounters, SubscriptionStatus } from '@shotx/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../db/db';

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
