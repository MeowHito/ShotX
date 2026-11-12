import { createHash } from 'node:crypto';
import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { checkoutSessions, payments, users } from '@shotx/db';
import {
  AUTO_RENEW_MONTHS,
  applyCheckout,
  BILLING_CARD_RETURN_PATH,
  type BillingNotice,
  cancelAutoRenewValues,
  type CheckoutPayment,
  type CheckoutResponse,
  type CreateCheckoutResult,
  downgradeQuotaNotice,
  ERROR_CODES,
  type ErrorCode,
  type PaymentAction,
  type PaymentGatewayAdapter,
  type PaymentView,
  periodPriceSatang,
  planCheckoutCharge,
  type PlansResponse,
  renewalAmountSatang,
  splitVat,
  subscriptionDeadlines,
  type SubscriptionResponse,
  validateCheckout,
} from '@shotx/shared';
import { and, eq, lte } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import { type Db, isUniqueViolation, type Queryable, type Tx } from '../db/db';
import { storageCounters } from '../drive/account';
import { ApiError, notFound } from '../http/api-error';
import { API_CONFIG, API_LOGGER, CLOCK, type Clock, DATABASE, PAYMENT_GATEWAY } from '../tokens';
import {
  currentOf,
  latestSubscription,
  planById,
  type PlanRow,
  planSummary,
  purchasablePlan,
  purchasablePlans,
  type SubscriptionRow,
  targetPlan,
  valuesOf,
  writeChange,
} from './subscription-store';

type CheckoutRow = typeof checkoutSessions.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

export interface CheckoutRequest {
  planCode: string;
  changeType: CheckoutResponse['changeType'];
  payment: CheckoutPayment;
}

/** Hex SHA-256 of the canonical request (fixed key order), stored as `request_sha256`. */
export function checkoutRequestSha256(body: CheckoutRequest): string {
  const canonical = JSON.stringify({
    planCode: body.planCode,
    changeType: body.changeType,
    payment: { method: body.payment.method, months: body.payment.months },
  });
  return createHash('sha256').update(canonical).digest('hex');
}

const gatewayError = () =>
  new ApiError('PAYMENT_GATEWAY_ERROR', 'The payment gateway did not answer; try again');

function asErrorCode(value: string | null): ErrorCode | null {
  if (value === null) return null;
  return (ERROR_CODES as readonly string[]).includes(value)
    ? (value as ErrorCode)
    : 'INTERNAL_ERROR';
}

/**
 * Billing routes (BILLING_ROUTES) except the webhook: plans, checkout, payment polling, the
 * subscription and cancelling auto-renew. Every money or quota change runs in one DB transaction
 * that locks the subscription row FOR UPDATE (patterns in @shotx/shared billing/subscription);
 * gateway calls happen outside transactions. Ownership: every query filters by the photographer
 * the guard resolved; ids from the client only ever narrow that.
 */
@Injectable()
export class BillingService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly paymentGateway: PaymentGatewayAdapter | null,
    @Inject(API_LOGGER) private readonly logger: LoggerService,
  ) {}

  /** The gateway; NOT_FOUND with BILLING_MODE=offline (none is built). */
  private get gateway(): PaymentGatewayAdapter {
    if (this.paymentGateway === null) throw notFound('Route');
    return this.paymentGateway;
  }

  private split(totalSatang: number, vatSatang?: number) {
    const rate = this.config.billing.vatRateBasisPoints;
    if (vatSatang === undefined) return splitVat(totalSatang, rate);
    return { totalSatang, vatSatang, netSatang: totalSatang - vatSatang, vatRateBasisPoints: rate };
  }

  // --- GET /plans ------------------------------------------------------------------------------------

  async plans(): Promise<PlansResponse> {
    const rows = await purchasablePlans(this.db);
    const { prepaidMonths } = this.config.billing;
    return {
      plans: rows.map((plan) => ({
        ...planSummary(plan),
        month: this.split(plan.priceMonthSatang),
        year: this.split(plan.priceYearSatang),
        prepaid: prepaidMonths.map((months) => ({
          months,
          amount: this.split(periodPriceSatang(plan, months)),
        })),
      })),
      currency: 'THB',
      vatRateBasisPoints: this.config.billing.vatRateBasisPoints,
      prepaidMonths: [...prepaidMonths],
      autoRenewMonths: [...AUTO_RENEW_MONTHS],
    };
  }

  // --- POST /billing/checkout --------------------------------------------------------------------------

  /**
   * Starts a purchase, idempotent per (photographer, Idempotency-Key):
   * 1. one transaction: expire stale pending checkouts; replay an existing checkout of this key
   *    (same request) or refuse it (IDEMPOTENCY_KEY_REUSED, CHECKOUT_EXPIRED); lock the
   *    subscription FOR UPDATE; classify and validate (PLAN_CHANGE_INVALID); price it (VAT split,
   *    upgrade proration); insert the checkout (CHECKOUT_PENDING while another is pending). A
   *    charge of 0 (waived upgrade, card downgrade) is applied here and completed at once;
   * 2. the gateway's checkout (PromptPay QR or hosted card page), outside any transaction, with the
   *    checkout id as its idempotency key;
   * 3. the payment row (one per checkout, ON CONFLICT DO NOTHING) and the stored action.
   * A crash between 1 and 3 is healed by the client's retry with the same key.
   */
  async checkout(
    photographerId: string,
    idempotencyKey: string,
    body: CheckoutRequest,
  ): Promise<CheckoutResponse> {
    const requestSha256 = checkoutRequestSha256(body);
    const now = this.clock.now();
    const created = await this.db.transaction(async (tx) => {
      await tx
        .update(checkoutSessions)
        .set({ status: 'expired', finishedAt: now })
        .where(
          and(
            eq(checkoutSessions.photographerId, photographerId),
            eq(checkoutSessions.status, 'pending'),
            lte(checkoutSessions.expiresAt, now),
          ),
        );
      const existing = await this.sessionByKey(tx, photographerId, idempotencyKey);
      if (existing !== null) return this.replayable(existing, requestSha256);

      const plan = await purchasablePlan(tx, body.planCode);
      if (plan === null) throw new ApiError('PLAN_NOT_FOUND', 'No such plan');
      const latest = await latestSubscription(tx, photographerId, { forUpdate: true });
      const current = currentOf(latest);
      const target = targetPlan(plan);
      const validation = validateCheckout({
        current,
        target,
        declared: body.changeType,
        payment: body.payment,
        prepaidMonths: this.config.billing.prepaidMonths,
      });
      if (!validation.ok) {
        throw new ApiError('PLAN_CHANGE_INVALID', 'This plan change is not possible now', {
          reason: validation.reason,
          expectedChangeType: validation.expected,
        });
      }
      const changeType = validation.changeType;
      const charge = planCheckoutCharge({
        changeType,
        current,
        target,
        payment: body.payment,
        now,
        daysPerMonth: this.config.billing.prorationDaysPerMonth,
        minChargeSatang: this.config.billing.minChargeSatang,
      });
      const free = charge.amountSatang === 0;
      const vat = this.split(charge.amountSatang);
      // A purged row is history: the checkout (and its payment) creates a new subscription.
      const reusable = latest !== null && latest.row.status !== 'purged' ? latest.row : null;
      const values = {
        photographerId,
        subscriptionId: reusable?.id ?? null,
        changeType,
        planId: plan.id,
        fromPlanId: reusable?.planId ?? null,
        method: body.payment.method,
        months: charge.months,
        amountSatang: charge.amountSatang,
        vatSatang: vat.vatSatang,
        prorationSatang: charge.proration?.amountSatang ?? null,
        prorationDays: charge.proration?.remainingDays ?? null,
        gateway: free ? null : this.gateway.name,
        status: free ? ('completed' as const) : ('pending' as const),
        idempotencyKey,
        requestSha256,
        expiresAt: new Date(now.getTime() + this.config.billing.checkoutExpirySeconds * 1000),
        finishedAt: free ? now : null,
        createdAt: now,
      };
      let session: CheckoutRow | undefined;
      try {
        [session] = await tx.transaction((sp) =>
          sp
            .insert(checkoutSessions)
            .values(values)
            .onConflictDoNothing({
              target: [checkoutSessions.photographerId, checkoutSessions.idempotencyKey],
            })
            .returning(),
        );
      } catch (error) {
        if (!isUniqueViolation(error, 'checkout_sessions_one_pending_per_photographer'))
          throw error;
        throw await this.pendingError(tx, photographerId);
      }
      if (session === undefined) {
        // A concurrent request with the same key won the insert.
        const raced = await this.sessionByKey(tx, photographerId, idempotencyKey);
        if (raced === null) throw new Error('checkout vanished after a key conflict');
        return this.replayable(raced, requestSha256);
      }
      if (free) {
        await this.applyFree(tx, session, latest, plan, body.payment, now);
      }
      return { session, fresh: true as const };
    });

    let session = created.session;
    let result: CreateCheckoutResult | null = null;
    if (session.status === 'pending' && session.amountSatang > 0) {
      const payment = await this.paymentOfCheckout(this.db, session.id);
      if (payment === null) {
        result = await this.startGatewayCheckout(photographerId, session);
        session = await this.recordPayment(photographerId, session, result);
      }
    }
    return this.checkoutView(photographerId, session, result);
  }

  /** The existing checkout of a key, or the error a replay of it answers. */
  private replayable(existing: CheckoutRow, requestSha256: string) {
    if (existing.requestSha256 !== requestSha256) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used before for another checkout',
      );
    }
    if (existing.status === 'expired') {
      throw new ApiError('CHECKOUT_EXPIRED', 'This checkout expired; start again with a new key');
    }
    return { session: existing, fresh: false as const };
  }

  private async sessionByKey(
    q: Queryable,
    photographerId: string,
    key: string,
  ): Promise<CheckoutRow | null> {
    const [row] = await q
      .select()
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.photographerId, photographerId),
          eq(checkoutSessions.idempotencyKey, key),
        ),
      );
    return row ?? null;
  }

  private async pendingError(q: Queryable, photographerId: string): Promise<ApiError> {
    const [pending] = await q
      .select({ id: checkoutSessions.id, expiresAt: checkoutSessions.expiresAt })
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.photographerId, photographerId),
          eq(checkoutSessions.status, 'pending'),
        ),
      );
    const payment = pending === undefined ? null : await this.paymentOfCheckout(q, pending.id);
    return new ApiError('CHECKOUT_PENDING', 'Another checkout is waiting for payment', {
      paymentId: payment?.id ?? null,
      expiresAt: (pending?.expiresAt ?? this.clock.now()).toISOString(),
    });
  }

  private async paymentOfCheckout(q: Queryable, checkoutId: string): Promise<PaymentRow | null> {
    const [row] = await q.select().from(payments).where(eq(payments.checkoutId, checkoutId));
    return row ?? null;
  }

  /**
   * A checkout that charges nothing, applied in the checkout transaction: a waived upgrade or a
   * card downgrade of an auto-renew subscription. The saved card (if any) stays the method; a
   * waived card upgrade of a prepaid subscription stays prepaid (no card was collected).
   */
  private async applyFree(
    tx: Tx,
    session: CheckoutRow,
    latest: { row: SubscriptionRow; plan: PlanRow } | null,
    plan: PlanRow,
    payment: CheckoutPayment,
    now: Date,
  ): Promise<void> {
    if (latest === null) throw new Error('a free checkout needs a subscription');
    const row = latest.row;
    const saved =
      row.billing === 'auto_renew' &&
      row.paymentMethodRef !== null &&
      row.paymentMethodGateway !== null
        ? { gateway: row.paymentMethodGateway, ref: row.paymentMethodRef }
        : null;
    const effective: CheckoutPayment =
      payment.method === 'card' && saved === null ? { method: 'promptpay', months: null } : payment;
    const applied = applyCheckout(
      valuesOf(row),
      {
        changeType: session.changeType,
        targetPlanId: plan.id,
        payment: effective,
        paymentMethod: effective.method === 'card' ? saved : null,
      },
      now,
    );
    await writeChange(tx, row, applied, {
      photographerId: session.photographerId,
      actor: 'photographer',
      actorUserId: session.photographerId,
      paymentId: null,
      checkoutId: session.id,
      now,
      meta: { free: true },
    });
  }

  private async startGatewayCheckout(
    photographerId: string,
    session: CheckoutRow,
  ): Promise<CreateCheckoutResult> {
    const plan = await planById(this.db, session.planId);
    const [user] = await this.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, photographerId));
    const returnUrl = new URL(BILLING_CARD_RETURN_PATH, this.config.app.publicBaseUrl);
    returnUrl.searchParams.set('checkout', session.id);
    try {
      return await this.gateway.createCheckout({
        idempotencyKey: session.id,
        method: session.method,
        amountSatang: session.amountSatang,
        currency: 'THB',
        description: `Snap ${plan.code} ${session.changeType}${
          session.months === null ? '' : ` ${session.months}m`
        }`,
        expiresAt: session.expiresAt,
        returnUrl: session.method === 'card' ? returnUrl.toString() : null,
        saveCard: session.method === 'card',
        customerEmail: user?.email ?? null,
      });
    } catch (error) {
      this.logger.warn(
        `payment gateway createCheckout failed: ${error instanceof Error ? error.name : 'error'}`,
        'BillingService',
      );
      throw gatewayError();
    }
  }

  /** The payment of a checkout (once) and the stored action, so a reload shows it again. */
  private async recordPayment(
    photographerId: string,
    session: CheckoutRow,
    result: CreateCheckoutResult,
  ): Promise<CheckoutRow> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(payments)
        .values({
          photographerId,
          subscriptionId: session.subscriptionId,
          checkoutId: session.id,
          amountSatang: session.amountSatang,
          vatSatang: session.vatSatang,
          method: session.method,
          gateway: this.gateway.name,
          gatewayRef: result.gatewayRef,
          status: 'pending',
          createdAt: this.clock.now(),
        })
        .onConflictDoNothing();
      const [updated] = await tx
        .update(checkoutSessions)
        .set(
          result.method === 'promptpay'
            ? { qrPayload: result.qrPayload }
            : { redirectUrl: result.redirectUrl },
        )
        .where(
          and(
            eq(checkoutSessions.id, session.id),
            eq(checkoutSessions.photographerId, photographerId),
          ),
        )
        .returning();
      return updated ?? session;
    });
  }

  private action(session: CheckoutRow, result: CreateCheckoutResult | null): PaymentAction | null {
    if (session.status !== 'pending' || session.expiresAt <= this.clock.now()) return null;
    const expiresAt = session.expiresAt.toISOString();
    if (session.method === 'promptpay') {
      const qrPayload = result?.method === 'promptpay' ? result.qrPayload : session.qrPayload;
      if (qrPayload === null) return null;
      return {
        kind: 'promptpay',
        qrPayload,
        qrImageDataUrl: result?.method === 'promptpay' ? result.qrImageDataUrl : null,
        expiresAt,
      };
    }
    const redirectUrl = result?.method === 'card' ? result.redirectUrl : session.redirectUrl;
    return redirectUrl === null ? null : { kind: 'card_redirect', redirectUrl, expiresAt };
  }

  private async checkoutView(
    photographerId: string,
    session: CheckoutRow,
    result: CreateCheckoutResult | null,
  ): Promise<CheckoutResponse> {
    const plan = await planById(this.db, session.planId);
    const payment = await this.paymentOfCheckout(this.db, session.id);
    let effectiveAt = session.createdAt;
    const notices: BillingNotice[] = [];
    if (session.changeType === 'downgrade') {
      const latest = await latestSubscription(this.db, photographerId);
      if (latest !== null) {
        effectiveAt =
          latest.row.pendingPlanId === session.planId && latest.row.pendingPlanEffectiveAt !== null
            ? latest.row.pendingPlanEffectiveAt
            : latest.row.periodEnd;
      }
      const notice = downgradeQuotaNotice(
        await storageCounters(this.db, photographerId),
        plan.quotaBytes,
      );
      if (notice !== null) notices.push(notice);
    }
    return {
      checkoutId: session.id,
      changeType: session.changeType,
      plan: planSummary(plan),
      status: session.status,
      amount: this.split(session.amountSatang, session.vatSatang),
      months: session.months,
      proration:
        session.prorationSatang === null || session.prorationDays === null
          ? null
          : { remainingDays: session.prorationDays, amountSatang: session.prorationSatang },
      effectiveAt: effectiveAt.toISOString(),
      paymentId: payment?.id ?? null,
      action: payment === null ? null : this.action(session, result),
      notices,
    };
  }

  // --- GET /billing/payments/:id -------------------------------------------------------------------

  async payment(photographerId: string, id: string): Promise<PaymentView> {
    const [row] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.photographerId, photographerId)));
    if (row === undefined) throw notFound('Payment');
    let checkout: PaymentView['checkout'] = null;
    let action: PaymentAction | null = null;
    if (row.checkoutId !== null) {
      const [session] = await this.db
        .select()
        .from(checkoutSessions)
        .where(
          and(
            eq(checkoutSessions.id, row.checkoutId),
            eq(checkoutSessions.photographerId, photographerId),
          ),
        );
      if (session !== undefined) {
        const plan = await planById(this.db, session.planId);
        checkout = {
          id: session.id,
          changeType: session.changeType,
          plan: planSummary(plan),
          status: session.status,
          expiresAt: session.expiresAt.toISOString(),
          errorCode: asErrorCode(session.errorCode),
        };
        if (row.status === 'pending') action = this.action(session, null);
      }
    }
    return {
      id: row.id,
      status: row.status,
      method: row.method,
      gateway: row.gateway as PaymentView['gateway'],
      amount: this.split(row.amountSatang, row.vatSatang),
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      kind: row.checkoutId !== null ? 'checkout' : 'renewal',
      checkout,
      action,
    };
  }

  // --- GET /billing/subscription -------------------------------------------------------------------

  async subscription(
    photographerId: string,
    q: Queryable = this.db,
  ): Promise<SubscriptionResponse> {
    const latest = await latestSubscription(q, photographerId);
    if (latest === null) return { subscription: null, notices: [] };
    const { row, plan } = latest;
    const pendingPlan = row.pendingPlanId === null ? null : await planById(q, row.pendingPlanId);
    const notices: BillingNotice[] = [];
    if (pendingPlan !== null) {
      const notice = downgradeQuotaNotice(
        await storageCounters(q, photographerId),
        pendingPlan.quotaBytes,
      );
      if (notice !== null) notices.push(notice);
    }
    let nextRenewal: NonNullable<SubscriptionResponse['subscription']>['nextRenewal'] = null;
    if (row.billing === 'auto_renew' && (row.autoRenewMonths === 1 || row.autoRenewMonths === 12)) {
      const due =
        pendingPlan !== null &&
        row.pendingPlanEffectiveAt !== null &&
        row.pendingPlanEffectiveAt <= row.periodEnd
          ? pendingPlan
          : plan;
      nextRenewal = {
        at: new Date(
          row.periodEnd.getTime() - this.config.billing.renewal.leadSeconds * 1000,
        ).toISOString(),
        plan: planSummary(due),
        months: row.autoRenewMonths,
        amount: this.split(renewalAmountSatang(due, row.autoRenewMonths)),
      };
    }
    const deadlines = subscriptionDeadlines(row.periodEnd, this.config.retention.subscription);
    return {
      subscription: {
        id: row.id,
        status: row.status,
        plan: planSummary(plan),
        billing: row.billing,
        autoRenewMonths:
          row.autoRenewMonths === 1 || row.autoRenewMonths === 12 ? row.autoRenewMonths : null,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        pendingChange:
          pendingPlan === null || row.pendingPlanEffectiveAt === null
            ? null
            : {
                plan: planSummary(pendingPlan),
                effectiveAt: row.pendingPlanEffectiveAt.toISOString(),
              },
        nextRenewal,
        expiresAt: deadlines.expiresAt.toISOString(),
        purgeAt: deadlines.purgeAt.toISOString(),
      },
      notices,
    };
  }

  // --- POST /billing/subscription/cancel -----------------------------------------------------------

  /**
   * Auto-renew off at period end. The saved method is detached at the gateway first (outside any
   * transaction; a failure is PAYMENT_GATEWAY_ERROR and changes nothing), then, in one transaction
   * with the row locked FOR UPDATE, cancelAutoRenewValues and an `auto_renew_canceled` event.
   * Idempotent: a prepaid subscription comes back unchanged.
   */
  async cancel(photographerId: string): Promise<SubscriptionResponse> {
    const latest = await latestSubscription(this.db, photographerId);
    if (latest === null) throw notFound('Subscription');
    const ref = latest.row.paymentMethodRef;
    if (latest.row.billing === 'auto_renew' && ref !== null) {
      try {
        await this.gateway.cancelAutoRenew({ paymentMethodRef: ref });
      } catch (error) {
        this.logger.warn(
          `payment gateway cancelAutoRenew failed: ${error instanceof Error ? error.name : 'error'}`,
          'BillingService',
        );
        throw gatewayError();
      }
      await this.db.transaction(async (tx) => {
        const locked = await latestSubscription(tx, photographerId, { forUpdate: true });
        if (locked === null || locked.row.paymentMethodRef !== ref) return;
        const applied = cancelAutoRenewValues(valuesOf(locked.row));
        if (applied.events.length === 0) return;
        await writeChange(tx, locked.row, applied, {
          photographerId,
          actor: 'photographer',
          actorUserId: photographerId,
          paymentId: null,
          checkoutId: null,
          now: this.clock.now(),
        });
      });
    }
    return this.subscription(photographerId);
  }
}
