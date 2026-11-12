import { createHash } from 'node:crypto';
import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import { checkoutSessions, paymentWebhookEvents, payments, plans, users } from '@shotx/db';
import {
  applyCheckout,
  applyRenewalPayment,
  BILLING_PAGE_PATH,
  type CheckoutPayment,
  type EmailProvider,
  type NormalizedPaymentEvent,
  type PaymentGateway,
  type PaymentGatewayAdapter,
  validateCheckout,
} from '@shotx/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import type { Db, Tx } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import type { EventLog } from '../infra/events';
import {
  API_CONFIG,
  API_LOGGER,
  CLOCK,
  type Clock,
  DATABASE,
  EMAIL_PROVIDER,
  EVENT_LOG,
  PAYMENT_GATEWAY,
} from '../tokens';
import {
  currentOf,
  latestSubscription,
  planById,
  recordSubscriptionEvent,
  type SubscriptionRow,
  targetPlan,
  valuesOf,
  writeChange,
} from './subscription-store';

type PaymentRow = typeof payments.$inferSelect;
type CheckoutRow = typeof checkoutSessions.$inferSelect;

/** Structured log events of the webhook path (codes and ids only; never the payload). */
export const BILLING_WEBHOOK_ALERT_EVENT = 'billing.webhook.alert';

/** What processing decided, for the event row and the alert. */
type Outcome =
  | { kind: 'processed'; paymentId: string | null; receipt: boolean }
  | { kind: 'alert'; errorCode: string; paymentId: string | null; processed: boolean };

const STALE_CHECKOUT = ['pending', 'expired'] as const;

/**
 * POST /billing/webhooks/:gateway. Verify the signature over the raw bytes (nothing is stored for
 * an invalid one), then in ONE transaction: upsert the event by (gateway, event_ref), lock the
 * payment by (gateway, gateway_ref) FOR UPDATE, run the guarded status UPDATE (`WHERE status =
 * 'pending'`), check the amount, lock the subscription FOR UPDATE, apply the change, write
 * subscription_events, complete the checkout, set processed_at. Replays and concurrent deliveries
 * find the event processed (or the payment no longer pending) and change nothing. 2xx once
 * verified and stored; 500 only when the transaction fails, so the gateway retries. Payloads are
 * never logged or stored raw (a SHA-256 only): they can hold personal data.
 */
@Injectable()
export class WebhookService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PAYMENT_GATEWAY) private readonly paymentGateway: PaymentGatewayAdapter | null,
    @Inject(EMAIL_PROVIDER) private readonly email: EmailProvider,
    @Inject(API_LOGGER) private readonly logger: LoggerService,
    @Inject(EVENT_LOG) private readonly events: EventLog,
  ) {}

  /** The gateway; NOT_FOUND with BILLING_MODE=offline (none is built). */
  private get gateway(): PaymentGatewayAdapter {
    if (this.paymentGateway === null) throw notFound('Route');
    return this.paymentGateway;
  }

  private alert(errorCode: string, fields: Record<string, string | null>): void {
    this.events.warn(BILLING_WEBHOOK_ALERT_EVENT, { ...fields, errorCode });
  }

  async receive(
    gateway: PaymentGateway,
    rawBody: Buffer,
    headers: Readonly<Record<string, string | undefined>>,
  ): Promise<void> {
    if (gateway !== this.gateway.name) throw notFound('Webhook');
    const request = { rawBody: new Uint8Array(rawBody), headers };
    if (!(await this.gateway.verifyWebhook(request))) {
      throw new ApiError('WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid');
    }
    const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
    const now = this.clock.now();

    let event: NormalizedPaymentEvent | null;
    try {
      event = this.gateway.parseWebhookEvent(request);
    } catch {
      await this.storeUnapplied(
        gateway,
        `sha256:${payloadSha256}`,
        payloadSha256,
        now,
        'unparseable',
      );
      this.alert('unparseable', { gateway });
      return;
    }
    if (event === null) {
      await this.storeUnapplied(gateway, `sha256:${payloadSha256}`, payloadSha256, now, null);
      return;
    }
    if (event.gateway !== gateway) {
      await this.storeUnapplied(gateway, event.eventRef, payloadSha256, now, 'gateway_mismatch');
      this.alert('gateway_mismatch', { gateway });
      return;
    }

    const parsed = event;
    const outcome = await this.db.transaction(async (tx): Promise<Outcome> => {
      await tx
        .insert(paymentWebhookEvents)
        .values({
          gateway,
          eventRef: parsed.eventRef,
          gatewayRef: parsed.gatewayRef,
          type: parsed.type,
          amountSatang: parsed.amountSatang,
          payloadSha256,
          receivedAt: now,
          verifiedAt: now,
        })
        .onConflictDoNothing({
          target: [paymentWebhookEvents.gateway, paymentWebhookEvents.eventRef],
        });
      const [stored] = await tx
        .select()
        .from(paymentWebhookEvents)
        .where(
          and(
            eq(paymentWebhookEvents.gateway, gateway),
            eq(paymentWebhookEvents.eventRef, parsed.eventRef),
          ),
        )
        .for('update');
      if (stored === undefined) throw new Error('webhook event vanished after insert');
      // A replay of an event that was applied (or deliberately ignored): nothing to do.
      if (stored.processedAt !== null) {
        return { kind: 'processed', paymentId: stored.paymentId, receipt: true };
      }
      const result = await this.apply(tx, parsed, now);
      await tx
        .update(paymentWebhookEvents)
        .set({
          paymentId: result.paymentId,
          processedAt: result.kind === 'processed' || result.processed ? now : null,
          errorCode: result.kind === 'alert' ? result.errorCode : null,
        })
        .where(eq(paymentWebhookEvents.id, stored.id));
      return result;
    });

    if (outcome.kind === 'alert') {
      this.alert(outcome.errorCode, { gateway, paymentId: outcome.paymentId });
    } else if (outcome.receipt && outcome.paymentId !== null) {
      await this.sendReceipt(outcome.paymentId);
    }
  }

  /** An event that is stored but never applied (unparseable, ignored kinds, mismatches). */
  private async storeUnapplied(
    gateway: PaymentGateway,
    eventRef: string,
    payloadSha256: string,
    now: Date,
    errorCode: string | null,
  ): Promise<void> {
    await this.db
      .insert(paymentWebhookEvents)
      .values({
        gateway,
        eventRef,
        payloadSha256,
        receivedAt: now,
        verifiedAt: now,
        processedAt: now,
        errorCode,
      })
      .onConflictDoNothing({
        target: [paymentWebhookEvents.gateway, paymentWebhookEvents.eventRef],
      });
  }

  private async apply(tx: Tx, event: NormalizedPaymentEvent, now: Date): Promise<Outcome> {
    const [payment] = await tx
      .select()
      .from(payments)
      .where(and(eq(payments.gateway, event.gateway), eq(payments.gatewayRef, event.gatewayRef)))
      .for('update');
    // The charge isn't ours (yet): left unprocessed, so a redelivery after the checkout recorded
    // its payment applies it.
    if (payment === undefined) {
      return { kind: 'alert', errorCode: 'unknown_payment', paymentId: null, processed: false };
    }
    switch (event.type) {
      case 'paid':
        return this.paid(tx, payment, event, now);
      case 'failed':
      case 'expired':
        return this.unpaid(tx, payment, event, now);
      case 'refunded':
        return this.refunded(tx, payment, now);
    }
  }

  private async paid(
    tx: Tx,
    payment: PaymentRow,
    event: NormalizedPaymentEvent,
    now: Date,
  ): Promise<Outcome> {
    const done = (receipt: boolean): Outcome => ({
      kind: 'processed',
      paymentId: payment.id,
      receipt,
    });
    const alert = (errorCode: string): Outcome => ({
      kind: 'alert',
      errorCode,
      paymentId: payment.id,
      processed: true,
    });
    // Another event already settled this charge (or it was refunded): nothing to apply.
    if (payment.status === 'paid' || payment.status === 'refunded') return done(true);
    if (payment.status !== 'pending') return alert('payment_not_pending');
    if (event.amountSatang !== payment.amountSatang) return alert('amount_mismatch');
    if (payment.method === 'card' && event.paymentMethodRef === null) {
      return alert('missing_payment_method');
    }

    const [marked] = await tx
      .update(payments)
      .set({ status: 'paid', paidAt: event.occurredAt, updatedAt: now })
      .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')))
      .returning();
    if (marked === undefined) return done(true);

    if (payment.checkoutId !== null) {
      return (await this.applyCheckoutPayment(tx, marked, event, now))
        ? done(true)
        : alert('payment_unapplied');
    }
    if (payment.renewalPeriodEnd !== null && payment.subscriptionId !== null) {
      return (await this.applyRenewal(tx, marked, now)) ? done(true) : alert('payment_unapplied');
    }
    return alert('payment_without_purpose');
  }

  /**
   * Applies a paid checkout if the change is still valid now (re-validated against the locked
   * subscription); otherwise the checkout fails with PLAN_CHANGE_INVALID and a
   * `payment_unapplied` event is written for an admin refund. Late payments of expired checkouts
   * still apply when valid.
   */
  private async applyCheckoutPayment(
    tx: Tx,
    payment: PaymentRow,
    event: NormalizedPaymentEvent,
    now: Date,
  ): Promise<boolean> {
    const [checkout] = await tx
      .select()
      .from(checkoutSessions)
      .where(
        and(
          eq(checkoutSessions.id, payment.checkoutId ?? ''),
          eq(checkoutSessions.photographerId, payment.photographerId),
        ),
      )
      .for('update');
    if (checkout === undefined) return false;
    const plan = await planById(tx, checkout.planId);
    const latest = await latestSubscription(tx, payment.photographerId, { forUpdate: true });
    const current = currentOf(latest);
    const checkoutPayment: CheckoutPayment =
      checkout.method === 'card'
        ? { method: 'card', months: checkout.months === 12 ? 12 : 1 }
        : { method: 'promptpay', months: checkout.months };
    const stillOpen = (STALE_CHECKOUT as readonly string[]).includes(checkout.status);
    const validation = validateCheckout({
      current,
      target: targetPlan(plan),
      declared: checkout.changeType,
      payment: checkoutPayment,
      // The months were offered when the checkout was created.
      prepaidMonths: checkout.months === null ? [] : [checkout.months],
    });
    if (!stillOpen || !validation.ok) {
      await this.failCheckout(tx, checkout, now, 'PLAN_CHANGE_INVALID');
      if (latest !== null) {
        await recordSubscriptionEvent(
          tx,
          latest.row,
          'payment_unapplied',
          {
            photographerId: payment.photographerId,
            actor: 'gateway',
            actorUserId: null,
            paymentId: payment.id,
            checkoutId: checkout.id,
            now,
            meta: { reason: validation.ok ? 'checkout_closed' : validation.reason },
          },
          {
            fromStatus: latest.row.status,
            fromPlanId: latest.row.planId,
            periodEndBefore: latest.row.periodEnd,
          },
        );
      }
      return false;
    }

    const reusable: SubscriptionRow | null =
      latest !== null && latest.row.status !== 'purged' ? latest.row : null;
    const applied = applyCheckout(
      reusable === null ? null : valuesOf(reusable),
      {
        changeType: checkout.changeType,
        targetPlanId: plan.id,
        payment: checkoutPayment,
        paymentMethod:
          checkout.method === 'card' && event.paymentMethodRef !== null
            ? { gateway: payment.gateway, ref: event.paymentMethodRef }
            : null,
      },
      now,
    );
    const row = await writeChange(tx, reusable, applied, {
      photographerId: payment.photographerId,
      actor: 'gateway',
      actorUserId: null,
      paymentId: payment.id,
      checkoutId: checkout.id,
      now,
    });
    if (payment.subscriptionId !== row.id) {
      await tx.update(payments).set({ subscriptionId: row.id }).where(eq(payments.id, payment.id));
    }
    await tx
      .update(checkoutSessions)
      .set({ status: 'completed', finishedAt: now, subscriptionId: row.id })
      .where(
        and(
          eq(checkoutSessions.id, checkout.id),
          inArray(checkoutSessions.status, [...STALE_CHECKOUT]),
        ),
      );
    return true;
  }

  private async applyRenewal(tx: Tx, payment: PaymentRow, now: Date): Promise<boolean> {
    const latest = await latestSubscription(tx, payment.photographerId, { forUpdate: true });
    const row = latest?.row;
    if (
      row === undefined ||
      row.id !== payment.subscriptionId ||
      row.billing !== 'auto_renew' ||
      payment.renewalPeriodEnd === null ||
      row.periodEnd.getTime() !== payment.renewalPeriodEnd.getTime() ||
      (row.status !== 'active' && row.status !== 'grace')
    ) {
      if (row !== undefined) {
        await recordSubscriptionEvent(
          tx,
          row,
          'payment_unapplied',
          {
            photographerId: payment.photographerId,
            actor: 'gateway',
            actorUserId: null,
            paymentId: payment.id,
            checkoutId: null,
            now,
            meta: { reason: 'renewal_period_changed' },
          },
          { fromStatus: row.status, fromPlanId: row.planId, periodEndBefore: row.periodEnd },
        );
      }
      return false;
    }
    await writeChange(tx, row, applyRenewalPayment(valuesOf(row), now), {
      photographerId: payment.photographerId,
      actor: 'gateway',
      actorUserId: null,
      paymentId: payment.id,
      checkoutId: null,
      now,
    });
    return true;
  }

  private async failCheckout(
    tx: Tx,
    checkout: CheckoutRow,
    now: Date,
    errorCode: string,
  ): Promise<void> {
    await tx
      .update(checkoutSessions)
      .set({ status: 'failed', errorCode, finishedAt: now })
      .where(
        and(
          eq(checkoutSessions.id, checkout.id),
          inArray(checkoutSessions.status, [...STALE_CHECKOUT]),
        ),
      );
  }

  private async unpaid(
    tx: Tx,
    payment: PaymentRow,
    event: NormalizedPaymentEvent,
    now: Date,
  ): Promise<Outcome> {
    const type = event.type === 'failed' ? 'failed' : 'expired';
    const [changed] = await tx
      .update(payments)
      .set({ status: type, failureCode: event.failureCode, updatedAt: now })
      .where(and(eq(payments.id, payment.id), eq(payments.status, 'pending')))
      .returning({ id: payments.id });
    if (changed !== undefined && payment.checkoutId !== null) {
      await tx
        .update(checkoutSessions)
        .set(
          type === 'failed'
            ? { status: 'failed', errorCode: 'PAYMENT_GATEWAY_ERROR', finishedAt: now }
            : { status: 'expired', finishedAt: now },
        )
        .where(
          and(eq(checkoutSessions.id, payment.checkoutId), eq(checkoutSessions.status, 'pending')),
        );
    }
    if (changed !== undefined && payment.renewalPeriodEnd !== null && type === 'failed') {
      const latest = await latestSubscription(tx, payment.photographerId, { forUpdate: true });
      if (latest !== null && latest.row.id === payment.subscriptionId) {
        await recordSubscriptionEvent(
          tx,
          latest.row,
          'renewal_failed',
          {
            photographerId: payment.photographerId,
            actor: 'gateway',
            actorUserId: null,
            paymentId: payment.id,
            checkoutId: null,
            now,
            meta: event.failureCode === null ? {} : { failureCode: event.failureCode },
          },
          {
            fromStatus: latest.row.status,
            fromPlanId: latest.row.planId,
            periodEndBefore: latest.row.periodEnd,
          },
        );
      }
    }
    return { kind: 'processed', paymentId: payment.id, receipt: false };
  }

  /** A refund is recorded; the subscription is not changed automatically (an admin decides). */
  private async refunded(tx: Tx, payment: PaymentRow, now: Date): Promise<Outcome> {
    const [changed] = await tx
      .update(payments)
      .set({ status: 'refunded', refundedAt: now, updatedAt: now })
      .where(and(eq(payments.id, payment.id), eq(payments.status, 'paid')))
      .returning({ id: payments.id });
    if (changed === undefined) {
      return payment.status === 'refunded'
        ? { kind: 'processed', paymentId: payment.id, receipt: false }
        : { kind: 'alert', errorCode: 'refund_not_paid', paymentId: payment.id, processed: true };
    }
    const latest = await latestSubscription(tx, payment.photographerId, { forUpdate: true });
    if (latest !== null) {
      await recordSubscriptionEvent(
        tx,
        latest.row,
        'payment_refunded',
        {
          photographerId: payment.photographerId,
          actor: 'gateway',
          actorUserId: null,
          paymentId: payment.id,
          checkoutId: payment.checkoutId,
          now,
        },
        {
          fromStatus: latest.row.status,
          fromPlanId: latest.row.planId,
          periodEndBefore: latest.row.periodEnd,
        },
      );
    }
    return { kind: 'processed', paymentId: payment.id, receipt: false };
  }

  /**
   * The payment_receipt email, at most once per payment: `receipt_sent_at` is claimed with a
   * guarded UPDATE before sending and released if the send fails (so a redelivery or a later job
   * retries). Never fails the webhook. No email address is ever logged.
   */
  async sendReceipt(paymentId: string): Promise<void> {
    const now = this.clock.now();
    const [claimed] = await this.db
      .update(payments)
      .set({ receiptSentAt: now })
      .where(
        and(
          eq(payments.id, paymentId),
          eq(payments.status, 'paid'),
          isNull(payments.receiptSentAt),
        ),
      )
      .returning();
    if (claimed === undefined) return;
    try {
      const [user] = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, claimed.photographerId));
      if (user?.email == null) {
        this.logger.warn('payment receipt skipped: photographer has no email', 'WebhookService');
        return;
      }
      const latest = await latestSubscription(this.db, claimed.photographerId);
      const [checkout] =
        claimed.checkoutId === null
          ? []
          : await this.db
              .select({ changeType: checkoutSessions.changeType, planId: checkoutSessions.planId })
              .from(checkoutSessions)
              .where(eq(checkoutSessions.id, claimed.checkoutId));
      const [plan] = await this.db
        .select({ name: plans.name })
        .from(plans)
        .where(eq(plans.id, checkout?.planId ?? latest?.row.planId ?? ''));
      await this.email.send({
        to: user.email,
        template: 'payment_receipt',
        locale: 'th',
        idempotencyKey: `receipt:${claimed.id}`,
        params: {
          paymentId: claimed.id,
          planName: plan?.name ?? 'Snap',
          changeType: checkout?.changeType ?? null,
          method: claimed.method,
          totalSatang: claimed.amountSatang,
          vatSatang: claimed.vatSatang,
          netSatang: claimed.amountSatang - claimed.vatSatang,
          paidAt: (claimed.paidAt ?? now).toISOString(),
          periodEnd: (latest?.row.periodEnd ?? now).toISOString(),
          billingUrl: new URL(BILLING_PAGE_PATH, this.config.app.publicBaseUrl).toString(),
        },
      });
    } catch (error) {
      await this.db
        .update(payments)
        .set({ receiptSentAt: null })
        .where(eq(payments.id, claimed.id));
      this.logger.warn(
        `payment receipt not sent: ${error instanceof Error ? error.name : 'error'}`,
        'WebhookService',
      );
    }
  }
}
