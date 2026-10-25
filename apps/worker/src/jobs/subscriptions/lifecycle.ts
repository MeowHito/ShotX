import { payments, storageUsage } from '@shotx/db';
import { dueLifecycleSteps, downgradeQuotaNotice, type LifecycleStep } from '@shotx/shared';
import { and, eq, gt } from 'drizzle-orm';
import type { Db } from '../../db';
import type { JobContext } from '../context';
import {
  insertEvent,
  selectPlan,
  selectSubscription,
  type SubscriptionJobDeps,
  type SubscriptionRow,
  type SubscriptionRunResult,
  valuesOf,
  writeValues,
} from './common';

/**
 * A renewal charge for this period that the gateway is still deciding, made less than
 * BILLING_CHECKOUT_EXPIRY_SECONDS ago: grace waits for its webhook instead of emailing "your plan
 * ended" a few minutes before the payment lands. Older pending charges don't hold it back.
 */
async function freshPendingRenewal(
  tx: Db,
  row: SubscriptionRow,
  at: Date,
  maxAgeSeconds: number,
): Promise<boolean> {
  const [open] = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.subscriptionId, row.id),
        eq(payments.renewalPeriodEnd, row.periodEnd),
        eq(payments.status, 'pending'),
        gt(payments.createdAt, new Date(at.getTime() - maxAgeSeconds * 1000)),
      ),
    )
    .limit(1);
  return open !== undefined;
}

/**
 * The time-driven steps of one subscription at `at`, in one transaction with the row locked
 * FOR UPDATE (the api's checkout and webhook lock it the same way): dueLifecycleSteps, except
 * the purge, which runs separately in batches (purgeAccount) and marks `purged` when done.
 * - downgrade_applied: the pending plan becomes the plan. storage_usage is never touched and no
 *   file is deleted; when usage exceeds the smaller quota, uploads stay blocked (QUOTA_EXCEEDED,
 *   uploadsBlockedBy) until it fits, and the event's meta records the overage.
 * - grace_started, expired: the status. A missed run catches up through several steps.
 * One subscription_events row per step. Idempotent: the steps are recomputed from the locked row,
 * so a rerun finds nothing left to do.
 */
export async function applyLifecycle(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  id: string,
  at: Date,
  result: SubscriptionRunResult,
): Promise<SubscriptionRow | undefined> {
  return ctx.db.transaction(async (tx) => {
    const locked = await selectSubscription(tx, id, 'update');
    if (locked === undefined || locked.status === 'purged') return locked;
    let steps: LifecycleStep[] = dueLifecycleSteps(locked, at, deps.lifecycle).filter(
      (s) => s.type !== 'purged',
    );
    const graceAt = steps.findIndex((s) => s.type === 'grace_started');
    if (
      graceAt >= 0 &&
      locked.billing === 'auto_renew' &&
      (await freshPendingRenewal(tx, locked, at, deps.billing.checkoutExpirySeconds))
    ) {
      ctx.log.info('grace deferred: an auto-renew charge is pending at the gateway', {
        subscriptionId: id,
      });
      steps = steps.slice(0, graceAt);
    }
    if (steps.length === 0) return locked;

    let values = valuesOf(locked);
    for (const step of steps) {
      const before = values;
      const meta: Record<string, number> = {};
      switch (step.type) {
        case 'downgrade_applied': {
          values = {
            ...values,
            planId: step.planId,
            pendingPlanId: null,
            pendingPlanEffectiveAt: null,
          };
          const plan = await selectPlan(tx, step.planId);
          const [usage] = await tx
            .select({
              usedBytes: storageUsage.usedBytes,
              reservedBytes: storageUsage.reservedBytes,
            })
            .from(storageUsage)
            .where(eq(storageUsage.photographerId, locked.photographerId));
          const notice = downgradeQuotaNotice(
            usage ?? { usedBytes: 0, reservedBytes: 0 },
            plan.quotaBytes,
          );
          if (notice !== null) {
            meta.quotaBytes = notice.details.quotaBytes;
            meta.overBytes = notice.details.overBytes;
            ctx.log.info('downgrade applied over quota; uploads blocked until usage fits', {
              subscriptionId: id,
              overBytes: notice.details.overBytes,
            });
          }
          result.downgradesApplied++;
          break;
        }
        case 'grace_started':
          values = { ...values, status: 'grace' };
          result.graceStarted++;
          break;
        case 'expired':
          values = { ...values, status: 'expired' };
          result.expired++;
          break;
        case 'purged':
          break;
      }
      await insertEvent(tx, locked, {
        type: step.type,
        fromStatus: before.status,
        toStatus: values.status,
        fromPlanId: before.planId,
        toPlanId: values.planId,
        periodEndBefore: before.periodEnd,
        periodEndAfter: values.periodEnd,
        meta,
      });
    }
    await writeValues(tx, id, values, at);
    return { ...locked, ...values, updatedAt: at };
  });
}
