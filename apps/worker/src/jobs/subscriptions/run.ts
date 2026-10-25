import { subscriptions } from '@shotx/db';
import { subscriptionDeadlines } from '@shotx/shared';
import { and, asc, gt, inArray, isNotNull, lte, ne, or } from 'drizzle-orm';
import { errorFields } from '../../logger';
import { type JobContext, mayContinue } from '../context';
import {
  emptyResult,
  selectSubscription,
  type SubscriptionJobDeps,
  type SubscriptionRunResult,
} from './common';
import { applyLifecycle } from './lifecycle';
import { purgeWarnedLongEnough, sendDueNotices, sendDueReceipts } from './notices';
import { isSupersededSubscription, purgeAccount } from './purge';
import { chargeRenewalIfDue } from './renewal';

const DAY_MS = 86_400_000;

function isAbort(ctx: JobContext): boolean {
  return ctx.signal.aborted;
}

/**
 * `subscriptions.transition.daily` (EventBridge Scheduler, deduped on (type, scheduledTime) by
 * the jobs handler's ledger). One instant `at` (the run's start) decides every rule, so a run is
 * consistent from the first subscription to the last. Per subscription, each in its own
 * transactions, in order:
 * 1. auto-renew charge when due (chargeRenewalIfDue): a success extends the period before step 2
 *    could move it to grace;
 * 2. lifecycle steps (applyLifecycle): pending downgrade, grace, expired;
 * 3. lifecycle emails (sendDueNotices), each logged once in subscription_notices.
 * Then receipts for paid payments (sendDueReceipts), then the account purges, which are the slow
 * part and so go last: a run that reaches its budget there leaves the rest for the next run. A
 * purge also waits until the purge warning is SUBSCRIPTION_PURGE_WARNING_DAYS old
 * (purgeWarnedLongEnough), so no account is purged unwarned after missed runs.
 *
 * Only subscriptions that can have something due are read: grace and expired ones, those whose
 * period ends within the reminder or renewal lead window, and those with a pending downgrade
 * that is due. One subscription's error is logged and counted, and the run goes on (the next run
 * retries it); an abort stops the run.
 */
export async function runSubscriptionTransitions(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  options: { at?: Date } = {},
): Promise<SubscriptionRunResult> {
  const at = options.at ?? new Date(ctx.now());
  const result = emptyResult();
  const lookaheadMs = Math.max(
    ...deps.lifecycle.reminderDays.map((d) => d * DAY_MS),
    deps.billing.renewal.leadSeconds * 1000,
    0,
  );
  const horizon = new Date(at.getTime() + lookaheadMs);
  const purgeDue: string[] = [];

  let cursor = '00000000-0000-0000-0000-000000000000';
  outer: while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          gt(subscriptions.id, cursor),
          ne(subscriptions.status, 'purged'),
          or(
            inArray(subscriptions.status, ['grace', 'expired']),
            lte(subscriptions.periodEnd, horizon),
            and(
              isNotNull(subscriptions.pendingPlanId),
              lte(subscriptions.pendingPlanEffectiveAt, at),
            ),
          ),
        ),
      )
      .orderBy(asc(subscriptions.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    cursor = batch.at(-1)!.id;
    for (const { id } of batch) {
      if (!mayContinue(ctx)) break outer;
      result.examined++;
      try {
        const row = await selectSubscription(ctx.db, id);
        if (row === undefined || row.status === 'purged') continue;
        await chargeRenewalIfDue(ctx, deps, row, at, result);
        const after = await applyLifecycle(ctx, deps, id, at, result);
        if (after === undefined || after.status === 'purged') continue;
        const purgeTime =
          after.status === 'expired' &&
          at.getTime() >= subscriptionDeadlines(after.periodEnd, deps.lifecycle).purgeAt.getTime();
        // An expired history row behind a newer subscription: no emails about it, and its
        // "purge" only marks the row (purgeAccount keeps the data of the newer subscription).
        if (after.status === 'expired' && (await isSupersededSubscription(ctx.db, after))) {
          if (purgeTime) purgeDue.push(id);
          continue;
        }
        await sendDueNotices(ctx, deps, after, at, result);
        if (purgeTime && (await purgeWarnedLongEnough(ctx, deps, after, at, result))) {
          purgeDue.push(id);
        }
      } catch (error) {
        if (isAbort(ctx)) throw error;
        result.errors++;
        ctx.log.warn('subscription step failed; the next run retries', {
          ...errorFields(error),
          subscriptionId: id,
        });
      }
    }
  }

  if (mayContinue(ctx)) {
    try {
      await sendDueReceipts(ctx, deps, result);
    } catch (error) {
      if (isAbort(ctx)) throw error;
      result.errors++;
      ctx.log.warn('sending receipts failed; the next run retries', errorFields(error));
    }
  }

  for (const id of purgeDue) {
    if (!mayContinue(ctx)) {
      result.purgesIncomplete++;
      continue;
    }
    try {
      const outcome = await purgeAccount(ctx, deps, id, at);
      if (outcome === 'purged' || outcome === 'superseded') result.purged++;
      else if (outcome === 'incomplete') result.purgesIncomplete++;
    } catch (error) {
      if (isAbort(ctx)) throw error;
      result.errors++;
      result.purgesIncomplete++;
      ctx.log.warn('account purge failed; the next run continues it', {
        ...errorFields(error),
        subscriptionId: id,
      });
    }
  }

  result.complete = ctx.now() < ctx.deadline && result.purgesIncomplete === 0;
  return result;
}
