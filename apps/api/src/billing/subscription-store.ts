import { plans, subscriptionEvents, subscriptions } from '@shotx/db';
import type {
  AppliedChange,
  AutoRenewMonths,
  BillingActor,
  CurrentSubscription,
  SubscriptionEventType,
  SubscriptionValues,
  TargetPlan,
} from '@shotx/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Queryable, Tx } from '../db/db';

/*
 * Subscription rows as the billing rules of @shotx/shared (billing/subscription) see them, and the
 * one place that writes a subscription change together with its subscription_events rows.
 */

export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type PlanRow = typeof plans.$inferSelect;

const LIVE = sql`${subscriptions.status} IN ('trial', 'active', 'grace')`;

/**
 * The photographer's subscription the billing routes act on: the live one, else the latest (the
 * ordering of drive/account currentSubscription). `forUpdate` locks the subscription row
 * (checkout and webhook transactions), which serialises with upload reservations (FOR SHARE).
 */
export async function latestSubscription(
  q: Queryable,
  photographerId: string,
  options: { forUpdate?: boolean } = {},
): Promise<{ row: SubscriptionRow; plan: PlanRow } | null> {
  const query = q
    .select({ row: subscriptions, plan: plans })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.photographerId, photographerId))
    .orderBy(desc(LIVE), desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(1);
  const [found] = await (options.forUpdate === true
    ? query.for('update', { of: subscriptions })
    : query);
  return found ?? null;
}

/** A purchasable plan by code: active and not the trial; else null (PLAN_NOT_FOUND). */
export async function purchasablePlan(q: Queryable, code: string): Promise<PlanRow | null> {
  const [plan] = await q
    .select()
    .from(plans)
    .where(and(eq(plans.code, code), eq(plans.isActive, true), isNull(plans.trialDays)));
  return plan ?? null;
}

/** Every purchasable plan, by quota then monthly price. */
export function purchasablePlans(q: Queryable): Promise<PlanRow[]> {
  return q
    .select()
    .from(plans)
    .where(and(eq(plans.isActive, true), isNull(plans.trialDays)))
    .orderBy(asc(plans.quotaBytes), asc(plans.priceMonthSatang), asc(plans.code));
}

export async function planById(q: Queryable, id: string): Promise<PlanRow> {
  const [plan] = await q.select().from(plans).where(eq(plans.id, id));
  if (plan === undefined) throw new Error('plan row missing');
  return plan;
}

export function targetPlan(plan: PlanRow): TargetPlan {
  return {
    id: plan.id,
    quotaBytes: plan.quotaBytes,
    priceMonthSatang: plan.priceMonthSatang,
    priceYearSatang: plan.priceYearSatang,
  };
}

export function planSummary(plan: PlanRow) {
  return { code: plan.code, name: plan.name, quotaBytes: plan.quotaBytes };
}

/** The checkout rules' view of the current state; null when there is none. */
export function currentOf(
  found: { row: SubscriptionRow; plan: PlanRow } | null,
): CurrentSubscription | null {
  if (found === null) return null;
  const { row, plan } = found;
  return {
    status: row.status,
    planId: row.planId,
    quotaBytes: plan.quotaBytes,
    priceMonthSatang: plan.priceMonthSatang,
    billing: row.billing,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    pendingPlanId: row.pendingPlanId,
  };
}

export function valuesOf(row: SubscriptionRow): SubscriptionValues {
  return {
    status: row.status,
    planId: row.planId,
    billing: row.billing,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    autoRenewMonths: row.autoRenewMonths as AutoRenewMonths | null,
    paymentMethodGateway: row.paymentMethodGateway,
    paymentMethodRef: row.paymentMethodRef,
    pendingPlanId: row.pendingPlanId,
    pendingPlanEffectiveAt: row.pendingPlanEffectiveAt,
  };
}

export interface ChangeContext {
  photographerId: string;
  actor: BillingActor;
  actorUserId: string | null;
  paymentId: string | null;
  checkoutId: string | null;
  now: Date;
  meta?: Record<string, string | number | boolean>;
}

/**
 * Writes `applied` to `existing` (UPDATE), or inserts a new row when `existing` is null (first
 * subscription, or after purge), and one subscription_events row per event, all in `tx`. Returns
 * the subscription row as written.
 */
export async function writeChange(
  tx: Tx,
  existing: SubscriptionRow | null,
  applied: AppliedChange,
  ctx: ChangeContext,
): Promise<SubscriptionRow> {
  const values = { ...applied.values, updatedAt: ctx.now };
  let row: SubscriptionRow | undefined;
  if (existing === null) {
    [row] = await tx
      .insert(subscriptions)
      .values({ photographerId: ctx.photographerId, ...values })
      .returning();
  } else {
    [row] = await tx
      .update(subscriptions)
      .set(values)
      .where(
        and(
          eq(subscriptions.id, existing.id),
          eq(subscriptions.photographerId, ctx.photographerId),
        ),
      )
      .returning();
  }
  if (row === undefined) throw new Error('subscription write returned no row');
  for (const type of applied.events) {
    await recordSubscriptionEvent(tx, row, type, ctx, {
      fromStatus: existing?.status ?? null,
      fromPlanId: existing?.planId ?? null,
      periodEndBefore: existing?.periodEnd ?? null,
    });
  }
  return row;
}

/** One subscription_events row (codes and counts only in `meta`). */
export async function recordSubscriptionEvent(
  tx: Tx,
  row: SubscriptionRow,
  type: SubscriptionEventType,
  ctx: ChangeContext,
  before: {
    fromStatus: SubscriptionRow['status'] | null;
    fromPlanId: string | null;
    periodEndBefore: Date | null;
  },
): Promise<void> {
  await tx.insert(subscriptionEvents).values({
    subscriptionId: row.id,
    photographerId: ctx.photographerId,
    type,
    actor: ctx.actor,
    actorUserId: ctx.actorUserId,
    fromStatus: before.fromStatus,
    toStatus: row.status,
    fromPlanId: before.fromPlanId,
    // A scheduled downgrade records the plan it moves to.
    toPlanId: type === 'downgrade_scheduled' ? (row.pendingPlanId ?? row.planId) : row.planId,
    periodEndBefore: before.periodEndBefore,
    periodEndAfter: row.periodEnd,
    paymentId: ctx.paymentId,
    checkoutId: ctx.checkoutId,
    meta: ctx.meta ?? {},
    createdAt: ctx.now,
  });
}
