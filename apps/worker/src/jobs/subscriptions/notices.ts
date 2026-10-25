import {
  checkoutSessions,
  payments,
  plans,
  subscriptionEvents,
  subscriptionNotices,
  subscriptions,
} from '@shotx/db';
import {
  type AutoRenewMonths,
  dueRenewalReminder,
  type EmailMessage,
  type EmailTemplate,
  type EmailTemplateParams,
  purgeWarningDue,
  renewalAmountSatang,
  subscriptionDeadlines,
  type SubscriptionNoticeKind,
} from '@shotx/shared';
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { errorFields } from '../../logger';
import { type JobContext, mayContinue } from '../context';
import {
  billingUrl,
  photographerEmail,
  planIdAtPeriodEnd,
  selectPlan,
  type SubscriptionJobDeps,
  type SubscriptionRow,
  type SubscriptionRunResult,
} from './common';

interface Notice<T extends EmailTemplate> {
  kind: SubscriptionNoticeKind;
  daysBefore: number;
  template: T;
  params: EmailTemplateParams<T>;
}

/**
 * Sends one lifecycle email at most once: the subscription_notices row (PK subscription, kind,
 * period_end, days_before) is inserted ON CONFLICT DO NOTHING first, then the email is sent, and
 * on a send failure the row is deleted so the next run retries. A crash between insert and send
 * loses that one email rather than ever sending it twice. Photographers without an email
 * address (LINE accounts that did not share one) are skipped without a row.
 */
async function sendNotice<T extends EmailTemplate>(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  notice: Notice<T>,
  at: Date,
  result: SubscriptionRunResult,
): Promise<void> {
  const to = await photographerEmail(ctx.db, row.photographerId);
  if (to === null) {
    result.noticesSkippedNoEmail++;
    return;
  }
  const key = {
    subscriptionId: row.id,
    kind: notice.kind,
    periodEnd: row.periodEnd,
    daysBefore: notice.daysBefore,
  };
  const claimed = await ctx.db
    .insert(subscriptionNotices)
    .values({ ...key, sentAt: at })
    .onConflictDoNothing()
    .returning({ kind: subscriptionNotices.kind });
  if (claimed.length === 0) return;
  const message: EmailMessage<T> = {
    to,
    template: notice.template,
    locale: 'th',
    params: notice.params,
    idempotencyKey: `notice:${row.id}:${notice.kind}:${row.periodEnd.toISOString()}:${notice.daysBefore}`,
  };
  try {
    await deps.email.send(message);
    result.noticesSent++;
  } catch (error) {
    ctx.log.warn('lifecycle email failed; the next run retries', {
      ...errorFields(error),
      subscriptionId: row.id,
      kind: notice.kind,
    });
    await ctx.db
      .delete(subscriptionNotices)
      .where(
        and(
          eq(subscriptionNotices.subscriptionId, key.subscriptionId),
          eq(subscriptionNotices.kind, key.kind),
          eq(subscriptionNotices.periodEnd, key.periodEnd),
          eq(subscriptionNotices.daysBefore, key.daysBefore),
        ),
      );
    result.noticeFailures++;
  }
}

async function sentDays(
  ctx: JobContext,
  row: SubscriptionRow,
  kind: SubscriptionNoticeKind,
): Promise<Set<number>> {
  const sent = await ctx.db
    .select({ days: subscriptionNotices.daysBefore })
    .from(subscriptionNotices)
    .where(
      and(
        eq(subscriptionNotices.subscriptionId, row.id),
        eq(subscriptionNotices.kind, kind),
        eq(subscriptionNotices.periodEnd, row.periodEnd),
      ),
    );
  return new Set(sent.map((s) => s.days));
}

/**
 * The lifecycle emails due for the subscription's state after this run's steps:
 * - trial/active: the most urgent T-14/T-7/T-1 reminder not yet sent (dueRenewalReminder);
 * - grace: grace_started, while still in grace;
 * - expired: subscription_expired before the purge, and the purge warning
 *   SUBSCRIPTION_PURGE_WARNING_DAYS before it (purgeWarningDue).
 * State-based rather than tied to the transition, so a crash after the transition commits still
 * sends the email on the next run.
 */
export async function sendDueNotices(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  at: Date,
  result: SubscriptionRunResult,
): Promise<void> {
  const url = billingUrl(deps);
  const deadlines = subscriptionDeadlines(row.periodEnd, deps.lifecycle);
  const t = at.getTime();
  switch (row.status) {
    case 'trial':
    case 'active': {
      const days = dueRenewalReminder({
        status: row.status,
        periodEnd: row.periodEnd,
        now: at,
        reminderDays: deps.lifecycle.reminderDays,
        sentDays: await sentDays(ctx, row, 'renewal_reminder'),
      });
      if (days === null) return;
      const plan = await selectPlan(ctx.db, planIdAtPeriodEnd(row));
      const autoRenew = row.billing === 'auto_renew' && row.autoRenewMonths !== null;
      await sendNotice(
        ctx,
        deps,
        row,
        {
          kind: 'renewal_reminder',
          daysBefore: days,
          template: 'renewal_reminder',
          params: {
            planName: plan.name,
            periodEnd: row.periodEnd.toISOString(),
            daysBefore: days,
            autoRenew,
            renewalAmountSatang: autoRenew
              ? renewalAmountSatang(plan, row.autoRenewMonths as AutoRenewMonths)
              : null,
            billingUrl: url,
          },
        },
        at,
        result,
      );
      return;
    }
    case 'grace':
      if (t >= deadlines.expiresAt.getTime()) return;
      await sendNotice(
        ctx,
        deps,
        row,
        {
          kind: 'grace_started',
          daysBefore: 0,
          template: 'grace_started',
          params: { graceEndsAt: deadlines.expiresAt.toISOString(), billingUrl: url },
        },
        at,
        result,
      );
      return;
    case 'expired': {
      if (t >= deadlines.purgeAt.getTime()) return;
      const purgeAt = deadlines.purgeAt.toISOString();
      await sendNotice(
        ctx,
        deps,
        row,
        {
          kind: 'expired',
          daysBefore: 0,
          template: 'subscription_expired',
          params: { purgeAt, billingUrl: url },
        },
        at,
        result,
      );
      const warned = await sentDays(ctx, row, 'purge_warning');
      const due = purgeWarningDue({
        status: row.status,
        periodEnd: row.periodEnd,
        now: at,
        days: deps.lifecycle,
        alreadySent: warned.has(deps.lifecycle.purgeWarningDays),
      });
      if (!due) return;
      await sendNotice(
        ctx,
        deps,
        row,
        {
          kind: 'purge_warning',
          daysBefore: deps.lifecycle.purgeWarningDays,
          template: 'purge_warning',
          params: { purgeAt, billingUrl: url },
        },
        at,
        result,
      );
      return;
    }
    case 'purged':
      return;
  }
}

/**
 * Safety net before an account purge: the photographer must have had the purge warning for
 * SUBSCRIPTION_PURGE_WARNING_DAYS. When no warning was logged for this period (the job did not
 * run in the warning window, or the subscription was already long expired when billing went
 * live), it is sent now with the postponed date, and the purge waits until the warning is old
 * enough. Photographers without an email address can't be warned and are purged on time. This
 * only ever delays a purge (the shared deadline stays the earliest date).
 */
export async function purgeWarnedLongEnough(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  at: Date,
  result: SubscriptionRunResult,
): Promise<boolean> {
  if ((await photographerEmail(ctx.db, row.photographerId)) === null) return true;
  const warningMs = deps.lifecycle.purgeWarningDays * 86_400_000;
  const [warned] = await ctx.db
    .select({ sentAt: subscriptionNotices.sentAt })
    .from(subscriptionNotices)
    .where(
      and(
        eq(subscriptionNotices.subscriptionId, row.id),
        eq(subscriptionNotices.kind, 'purge_warning'),
        eq(subscriptionNotices.periodEnd, row.periodEnd),
        eq(subscriptionNotices.daysBefore, deps.lifecycle.purgeWarningDays),
      ),
    );
  if (warned !== undefined) return warned.sentAt.getTime() + warningMs <= at.getTime();
  ctx.log.warn('purge postponed: the purge warning was not sent in time', {
    subscriptionId: row.id,
  });
  await sendNotice(
    ctx,
    deps,
    row,
    {
      kind: 'purge_warning',
      daysBefore: deps.lifecycle.purgeWarningDays,
      template: 'purge_warning',
      params: {
        purgeAt: new Date(at.getTime() + warningMs).toISOString(),
        billingUrl: billingUrl(deps),
      },
    },
    at,
    result,
  );
  return false;
}

/**
 * Receipts (payment_receipt), once per paid payment: claimed by setting `receipt_sent_at` with a
 * guarded UPDATE (`WHERE receipt_sent_at IS NULL`), sent, and released again on a send failure.
 * Any other sender (e.g. the api right after a webhook) using the same claim can never double
 * send. Covers checkout and renewal payments only (rows from before migration 0004 have
 * neither and are skipped), and never payments that could not be applied (failed checkout or a
 * `payment_unapplied` event: those are refunded).
 */
export async function sendDueReceipts(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  result: SubscriptionRunResult,
): Promise<void> {
  const url = billingUrl(deps);
  let cursor = '00000000-0000-0000-0000-000000000000';
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({
        id: payments.id,
        photographerId: payments.photographerId,
        amountSatang: payments.amountSatang,
        vatSatang: payments.vatSatang,
        method: payments.method,
        paidAt: payments.paidAt,
        changeType: checkoutSessions.changeType,
        checkoutPlanId: checkoutSessions.planId,
        subscriptionPlanId: subscriptions.planId,
        periodEnd: subscriptions.periodEnd,
      })
      .from(payments)
      .innerJoin(subscriptions, eq(subscriptions.id, payments.subscriptionId))
      .leftJoin(checkoutSessions, eq(checkoutSessions.id, payments.checkoutId))
      .where(
        and(
          gt(payments.id, cursor),
          eq(payments.status, 'paid'),
          isNull(payments.receiptSentAt),
          or(isNotNull(payments.checkoutId), isNotNull(payments.renewalPeriodEnd)),
          sql`${checkoutSessions.status} IS DISTINCT FROM 'failed'`,
          sql`NOT EXISTS (SELECT 1 FROM ${subscriptionEvents} WHERE ${subscriptionEvents.paymentId} = ${payments.id} AND ${subscriptionEvents.type} = 'payment_unapplied')`,
        ),
      )
      .orderBy(asc(payments.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) return;
    cursor = batch.at(-1)!.id;
    for (const payment of batch) {
      if (!mayContinue(ctx)) return;
      if (payment.paidAt === null) continue;
      const to = await photographerEmail(ctx.db, payment.photographerId);
      if (to === null) continue;
      const claimed = await ctx.db
        .update(payments)
        .set({ receiptSentAt: sql`now()` })
        .where(and(eq(payments.id, payment.id), isNull(payments.receiptSentAt)))
        .returning({ id: payments.id });
      if (claimed.length === 0) continue;
      const [plan] = await ctx.db
        .select({ name: plans.name })
        .from(plans)
        .where(eq(plans.id, payment.checkoutPlanId ?? payment.subscriptionPlanId));
      try {
        await deps.email.send({
          to,
          template: 'payment_receipt',
          locale: 'th',
          params: {
            paymentId: payment.id,
            planName: plan?.name ?? '-',
            changeType: payment.changeType,
            method: payment.method,
            totalSatang: payment.amountSatang,
            vatSatang: payment.vatSatang,
            netSatang: payment.amountSatang - payment.vatSatang,
            paidAt: payment.paidAt.toISOString(),
            periodEnd: payment.periodEnd.toISOString(),
            billingUrl: url,
          },
          idempotencyKey: `receipt:${payment.id}`,
        });
        result.receiptsSent++;
      } catch (error) {
        ctx.log.warn('receipt email failed; the next run retries', {
          ...errorFields(error),
          paymentId: payment.id,
        });
        await ctx.db
          .update(payments)
          .set({ receiptSentAt: null })
          .where(eq(payments.id, payment.id));
        result.receiptFailures++;
      }
    }
  }
}
