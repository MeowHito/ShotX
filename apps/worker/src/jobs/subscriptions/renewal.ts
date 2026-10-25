import { payments } from '@shotx/db';
import {
  applyRenewalPayment,
  type AutoRenewMonths,
  type ChargeSavedMethodResult,
  renewalAmountSatang,
  renewalChargeDue,
  splitVat,
} from '@shotx/shared';
import { and, eq, sql } from 'drizzle-orm';
import { type Db, rows } from '../../db';
import { errorFields } from '../../logger';
import type { JobContext } from '../context';
import {
  insertEvent,
  planIdAtPeriodEnd,
  selectPlan,
  selectSubscription,
  type SubscriptionJobDeps,
  type SubscriptionRow,
  type SubscriptionRunResult,
  valuesOf,
  writeValues,
} from './common';

interface RenewalAttempts {
  failed: number;
  openOrPaid: boolean;
}

async function attemptsFor(db: Db, row: SubscriptionRow): Promise<RenewalAttempts> {
  const [counts] = await rows<{ failed: number | string; open: boolean | null }>(
    db,
    sql`SELECT count(*) FILTER (WHERE ${payments.status} = 'failed') AS failed,
               bool_or(${payments.status} IN ('pending', 'paid')) AS open
          FROM ${payments}
         WHERE ${payments.subscriptionId} = ${row.id}
           AND ${payments.renewalPeriodEnd} = ${row.periodEnd.toISOString()}::timestamptz`,
  );
  return { failed: Number(counts?.failed ?? 0), openOrPaid: counts?.open === true };
}

/** `renewal:{subscriptionId}:{periodEnd ISO}:{attempt}` (PaymentGatewayAdapter contract). */
export function renewalIdempotencyKey(row: SubscriptionRow, attempt: number): string {
  return `renewal:${row.id}:${row.periodEnd.toISOString()}:${attempt}`;
}

/**
 * Auto-renew: charges the saved card when renewalChargeDue says so, for the plan in force at
 * period_end (renewalAmountSatang), then records the result in one transaction:
 * - the payment row (`renewal_period_end` = the period it extends), inserted ON CONFLICT DO
 *   NOTHING: (gateway, gateway_ref) makes a retry of the same idempotency key a no-op, and
 *   `payments_one_open_renewal` stops a second open charge for the period;
 * - paid: applyRenewalPayment (period_end + auto_renew_months, grace back to active) and a
 *   `renewed` event; if the subscription changed meanwhile (cancelled, renewed otherwise) a
 *   `payment_unapplied` event instead, for an admin refund;
 * - failed: a `renewal_failed` event; the subscription runs into grace at period_end (grace email)
 *   and the next runs retry up to BILLING_RENEWAL_MAX_ATTEMPTS;
 * - pending: nothing more; the api's webhook applies it.
 *
 * The gateway call happens outside any transaction (never hold locks across the network). A
 * crash after the charge and before the insert is healed by the next run: no failed row was
 * added, so it uses the same attempt number and idempotency key and gets the same charge back.
 * A thrown call (gateway unreachable) records nothing and is not counted as an attempt.
 */
export async function chargeRenewalIfDue(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  at: Date,
  result: SubscriptionRunResult,
): Promise<void> {
  if (row.billing !== 'auto_renew' || row.autoRenewMonths === null) return;
  const attempts = await attemptsFor(ctx.db, row);
  const due = renewalChargeDue({
    current: row,
    now: at,
    leadSeconds: deps.billing.renewal.leadSeconds,
    maxAttempts: deps.billing.renewal.maxAttempts,
    graceDays: deps.lifecycle.graceDays,
    failedAttemptsForPeriod: attempts.failed,
    openOrPaidForPeriod: attempts.openOrPaid,
  });
  if (!due) return;
  const log = ctx.log.child({ subscriptionId: row.id });
  if (row.paymentMethodRef === null || row.paymentMethodGateway !== deps.gateway.name) {
    log.warn('saved payment method belongs to another gateway; renewal not charged', {
      methodGateway: row.paymentMethodGateway,
      gateway: deps.gateway.name,
    });
    result.renewalErrors++;
    return;
  }

  const plan = await selectPlan(ctx.db, planIdAtPeriodEnd(row));
  const months = row.autoRenewMonths as AutoRenewMonths;
  const amountSatang = renewalAmountSatang(plan, months);
  const attempt = attempts.failed + 1;
  let charge: ChargeSavedMethodResult;
  try {
    charge = await deps.gateway.chargeSavedMethod({
      idempotencyKey: renewalIdempotencyKey(row, attempt),
      paymentMethodRef: row.paymentMethodRef,
      amountSatang,
      currency: 'THB',
      description: `ShotX ${plan.code} ${months} month${months === 1 ? '' : 's'} renewal`,
    });
  } catch (error) {
    log.warn('auto-renew charge failed to reach the gateway; retrying next run', {
      ...errorFields(error),
      attempt,
    });
    result.renewalErrors++;
    return;
  }
  result.renewalsCharged++;
  const outcome = await recordCharge(ctx, deps, row, at, { charge, amountSatang, attempt });
  if (outcome === 'paid') result.renewalsPaid++;
  else if (outcome === 'failed') result.renewalsFailed++;
  else if (outcome === 'pending') result.renewalsPending++;
  log.info('auto-renew charge recorded', { outcome, attempt, amountSatang });
}

type RecordOutcome = 'paid' | 'failed' | 'pending' | 'already-recorded' | 'unrecorded';

async function recordCharge(
  ctx: JobContext,
  deps: SubscriptionJobDeps,
  row: SubscriptionRow,
  at: Date,
  input: { charge: ChargeSavedMethodResult; amountSatang: number; attempt: number },
): Promise<RecordOutcome> {
  const { charge, amountSatang, attempt } = input;
  const gateway = deps.gateway.name;
  return ctx.db.transaction(async (tx) => {
    const locked = await selectSubscription(tx, row.id, 'update');
    if (locked === undefined) throw new Error('subscription vanished');
    const inserted = await tx
      .insert(payments)
      .values({
        photographerId: row.photographerId,
        subscriptionId: row.id,
        renewalPeriodEnd: row.periodEnd,
        amountSatang,
        vatSatang: splitVat(amountSatang, deps.billing.vatRateBasisPoints).vatSatang,
        method: 'card',
        gateway,
        gatewayRef: charge.gatewayRef,
        status: charge.status,
        failureCode: charge.status === 'failed' ? charge.failureCode : null,
        paidAt: charge.status === 'paid' ? at : null,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: payments.id });

    let paymentId: string;
    let final: 'paid' | 'failed' | null;
    if (inserted[0] !== undefined) {
      paymentId = inserted[0].id;
      final = charge.status === 'pending' ? null : charge.status;
    } else {
      const [existing] = await tx
        .select({ id: payments.id, status: payments.status })
        .from(payments)
        .where(and(eq(payments.gateway, gateway), eq(payments.gatewayRef, charge.gatewayRef)))
        .for('update');
      if (existing === undefined) {
        // Another open renewal for this period holds payments_one_open_renewal (two runs raced).
        ctx.log.error('auto-renew charge could not be recorded; check the gateway for a refund', {
          subscriptionId: row.id,
          gatewayRef: charge.gatewayRef,
        });
        return 'unrecorded';
      }
      paymentId = existing.id;
      if (existing.status !== 'pending' || charge.status === 'pending') return 'already-recorded';
      const updated = await tx
        .update(payments)
        .set({
          status: charge.status,
          paidAt: charge.status === 'paid' ? at : null,
          failureCode: charge.status === 'failed' ? charge.failureCode : null,
          updatedAt: at,
        })
        .where(and(eq(payments.id, existing.id), eq(payments.status, 'pending')))
        .returning({ id: payments.id });
      if (updated.length === 0) return 'already-recorded';
      final = charge.status;
    }

    if (final === null) return 'pending';
    if (final === 'failed') {
      await insertEvent(tx, locked, {
        type: 'renewal_failed',
        fromStatus: locked.status,
        toStatus: locked.status,
        fromPlanId: locked.planId,
        toPlanId: locked.planId,
        periodEndBefore: locked.periodEnd,
        periodEndAfter: locked.periodEnd,
        paymentId,
        meta: {
          attempt,
          ...(charge.failureCode === null ? {} : { failureCode: charge.failureCode }),
        },
      });
      return 'failed';
    }

    const applicable =
      (locked.status === 'active' || locked.status === 'grace') &&
      locked.billing === 'auto_renew' &&
      locked.periodEnd.getTime() === row.periodEnd.getTime();
    if (!applicable) {
      ctx.log.error('auto-renew payment could not be applied; an admin must refund it', {
        subscriptionId: row.id,
        paymentId,
      });
      await insertEvent(tx, locked, {
        type: 'payment_unapplied',
        fromStatus: locked.status,
        toStatus: locked.status,
        fromPlanId: locked.planId,
        toPlanId: locked.planId,
        periodEndBefore: locked.periodEnd,
        periodEndAfter: locked.periodEnd,
        paymentId,
      });
      return 'paid';
    }
    const change = applyRenewalPayment(valuesOf(locked), at);
    await writeValues(tx, locked.id, change.values, at);
    for (const type of change.events) {
      await insertEvent(tx, locked, {
        type,
        fromStatus: locked.status,
        toStatus: change.values.status,
        fromPlanId: locked.planId,
        toPlanId: change.values.planId,
        periodEndBefore: locked.periodEnd,
        periodEndAfter: change.values.periodEnd,
        paymentId,
        meta: { months: change.values.autoRenewMonths ?? 0 },
      });
    }
    return 'paid';
  });
}
