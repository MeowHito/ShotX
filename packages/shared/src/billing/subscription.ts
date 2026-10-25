import type {
  AutoRenewMonths,
  BillingMode,
  CheckoutChangeType,
  PlanChangeInvalidReason,
  SubscriptionEventType,
  SubscriptionStatus,
} from '../domain';
import { availableBytes, type QuotaState } from '../drive/quota';
import { periodPriceSatang, type PlanPrices, prorateUpgrade } from './money';
import { addDays, addMonthsBangkok } from './period';

/*
 * Subscription lifecycle (spec "Plans, quota and billing"). Pure rules only: the api applies
 * checkouts and webhooks, the worker's `subscriptions.transition.daily` job applies time-driven
 * steps, both inside one transaction per subscription.
 *
 *   trial ──new──────────────▶ active ◀──renew/upgrade/downgrade (stays active)
 *     │                         │  ▲
 *     │ period_end              │  │ renew (from period_end) / new (other plan, from now)
 *     ▼                         ▼  │
 *   grace (period_end + SUBSCRIPTION_GRACE_DAYS: uploads blocked, shares work)
 *     │ grace over                 ▲ renew (from now) / new
 *     ▼                            │
 *   expired (shares "ลิงก์นี้หมดอายุ"; owner can log in, renew, download) ─┘
 *     │ SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS later
 *     ▼
 *   purged (S3 objects and the Rekognition collection deleted; billing rows kept). Terminal: a
 *          `new` checkout afterwards inserts a new subscription row.
 *
 * Assumption: a trial that runs out goes to grace like a paid period (its shares keep working for
 * the grace days, uploads stop), then expired and purged on the same clock.
 *
 * Transaction patterns (money and quota change in one transaction; READ COMMITTED is enough
 * because every step locks the rows it changes):
 *
 * Checkout (POST /billing/checkout), idempotent by (photographer, Idempotency-Key):
 *   BEGIN;
 *   INSERT INTO checkout_sessions (photographer_id, idempotency_key, request_sha256, ...)
 *     VALUES (...) ON CONFLICT (photographer_id, idempotency_key) DO NOTHING RETURNING id;
 *     -- no row: SELECT the existing one; same request_sha256 -> replay its response (or
 *     -- CHECKOUT_EXPIRED when it expired); other hash -> IDEMPOTENCY_KEY_REUSED
 *     -- checkout_sessions_one_pending_per_photographer violated -> CHECKOUT_PENDING
 *   SELECT ... FROM subscriptions WHERE photographer_id = $p ORDER BY created_at DESC LIMIT 1
 *     FOR UPDATE;   -- classifyCheckout + planCheckoutCharge against the locked state
 *   COMMIT;
 *   createCheckout at the gateway with idempotency key = checkout id (outside the transaction:
 *   never hold row locks across a network call);
 *   INSERT INTO payments (photographer_id, subscription_id, checkout_id, gateway, gateway_ref,
 *     amount_satang, vat_satang, method, status 'pending') ON CONFLICT DO NOTHING;
 *     -- payments_checkout_unique: one payment per checkout; then SELECT it
 *   UPDATE checkout_sessions SET qr_payload = ..., redirect_url = ... WHERE id = $c;
 *   A crash between the steps is healed by the client's retry with the same key: the checkout
 *   exists without a payment, so createCheckout is called again with the same gateway key.
 *   Before the first INSERT the API expires stale checkouts:
 *   UPDATE checkout_sessions SET status = 'expired', finished_at = now()
 *     WHERE photographer_id = $p AND status = 'pending' AND expires_at <= now();
 *   (their payments stay `pending`: a late `paid` webhook is still applied if valid).
 *   A charge of 0 (waived upgrade, card downgrade) applies the change in the first transaction and
 *   marks the checkout `completed` without a payment.
 *
 * Webhook (POST /billing/webhooks/:gateway), idempotent by (gateway, event_ref) and by
 * (gateway, gateway_ref) on payments:
 *   verifyWebhook(raw body)            -- invalid: WEBHOOK_SIGNATURE_INVALID, nothing stored
 *   BEGIN;
 *   INSERT INTO payment_webhook_events (gateway, event_ref, gateway_ref, type, amount_satang,
 *     payload_sha256, verified_at) VALUES (...) ON CONFLICT (gateway, event_ref) DO NOTHING
 *     RETURNING id;                    -- no row and processed_at set: duplicate, COMMIT, 200
 *   SELECT ... FROM payments WHERE gateway = $g AND gateway_ref = $ref FOR UPDATE;
 *     -- none: leave processed_at null with error_code 'unknown_payment' (alert), COMMIT, 200
 *   paid:     UPDATE payments SET status = 'paid', paid_at = $t, payment_method_ref = ...
 *               WHERE id = $id AND status = 'pending';      -- no row: already final, skip
 *             amount must equal payments.amount_satang, else error_code 'amount_mismatch' (alert)
 *             SELECT subscription FOR UPDATE; applyCheckout (or applyRenewalPayment);
 *             UPDATE subscriptions ...; INSERT subscription_events ...;
 *             UPDATE checkout_sessions SET status = 'completed', finished_at = now()
 *               WHERE id = $c AND status IN ('pending', 'expired');   -- late payments count
 *             if the change is no longer valid: checkout 'failed' (PLAN_CHANGE_INVALID) and a
 *             'payment_unapplied' event; the money stays recorded for an admin refund
 *   failed/expired: UPDATE payments SET status = $type WHERE status = 'pending';
 *             UPDATE checkout_sessions SET status = 'failed' | 'expired' WHERE status = 'pending'
 *   refunded: UPDATE payments SET status = 'refunded', refunded_at = $t WHERE status = 'paid';
 *             INSERT subscription_events 'payment_refunded' (no automatic subscription change)
 *   UPDATE payment_webhook_events SET processed_at = now() WHERE id = $e;
 *   COMMIT;  -- then 2xx. Any error before COMMIT: 500, the gateway retries.
 *
 * Quota: the plan's `quota_bytes` is read with the subscription row locked `FOR SHARE` in the
 * upload reservation transaction (drive/quota), so a plan change and a reservation serialise.
 * Plan changes never touch `storage_usage`: an upgrade raises the limit at once, an applied
 * downgrade lowers it, and uploads stay blocked (QUOTA_EXCEEDED at init, uploadsBlockedBy) until
 * used + reserved fits. Files are never deleted because of a downgrade.
 */

/** Everything that changes a subscription's status. */
export const SUBSCRIPTION_TRANSITION_EVENTS = [
  'checkout_new',
  'checkout_renew',
  'checkout_upgrade',
  'checkout_downgrade',
  'period_ended',
  'grace_ended',
  'purge_due',
  'auto_renew_canceled',
] as const;
export type SubscriptionTransitionEvent = (typeof SUBSCRIPTION_TRANSITION_EVENTS)[number];

export interface SubscriptionTransition {
  from: SubscriptionStatus;
  event: SubscriptionTransitionEvent;
  to: SubscriptionStatus;
}

/**
 * Every allowed transition. Anything not listed is forbidden (subscriptionTransition returns
 * null), e.g. upgrading in grace, any checkout on a purged row, or going back from expired to
 * grace.
 */
export const SUBSCRIPTION_TRANSITIONS: readonly SubscriptionTransition[] = [
  { from: 'trial', event: 'checkout_new', to: 'active' },
  { from: 'trial', event: 'period_ended', to: 'grace' },
  { from: 'active', event: 'checkout_renew', to: 'active' },
  { from: 'active', event: 'checkout_upgrade', to: 'active' },
  { from: 'active', event: 'checkout_downgrade', to: 'active' },
  { from: 'active', event: 'auto_renew_canceled', to: 'active' },
  { from: 'active', event: 'period_ended', to: 'grace' },
  { from: 'grace', event: 'checkout_renew', to: 'active' },
  { from: 'grace', event: 'checkout_new', to: 'active' },
  { from: 'grace', event: 'grace_ended', to: 'expired' },
  { from: 'expired', event: 'checkout_renew', to: 'active' },
  { from: 'expired', event: 'checkout_new', to: 'active' },
  { from: 'expired', event: 'purge_due', to: 'purged' },
];

/** The status after `event`, or null when the transition is forbidden. */
export function subscriptionTransition(
  from: SubscriptionStatus,
  event: SubscriptionTransitionEvent,
): SubscriptionStatus | null {
  return SUBSCRIPTION_TRANSITIONS.find((t) => t.from === from && t.event === event)?.to ?? null;
}

export const CHECKOUT_TRANSITION_EVENT = {
  new: 'checkout_new',
  renew: 'checkout_renew',
  upgrade: 'checkout_upgrade',
  downgrade: 'checkout_downgrade',
} as const satisfies Record<CheckoutChangeType, SubscriptionTransitionEvent>;

// --- Deadlines -------------------------------------------------------------------------------------

export interface LifecycleDays {
  /** SUBSCRIPTION_GRACE_DAYS (14). */
  graceDays: number;
  /** SUBSCRIPTION_PURGE_AFTER_EXPIRY_DAYS (45, 30–60). */
  purgeAfterExpiryDays: number;
  /** SUBSCRIPTION_PURGE_WARNING_DAYS (7). */
  purgeWarningDays: number;
}

export interface SubscriptionDeadlines {
  /** `period_end`: trial/active become grace. */
  graceStartsAt: Date;
  /** `period_end + graceDays`: grace becomes expired. */
  expiresAt: Date;
  /** `expiresAt + purgeAfterExpiryDays`: expired becomes purged. */
  purgeAt: Date;
  /** `purgeAt - purgeWarningDays`: the purge warning email. */
  purgeWarningAt: Date;
}

/** Every time-driven deadline derives from `period_end` and the configured days. */
export function subscriptionDeadlines(periodEnd: Date, days: LifecycleDays): SubscriptionDeadlines {
  const expiresAt = addDays(periodEnd, days.graceDays);
  const purgeAt = addDays(expiresAt, days.purgeAfterExpiryDays);
  return {
    graceStartsAt: periodEnd,
    expiresAt,
    purgeAt,
    purgeWarningAt: addDays(purgeAt, -days.purgeWarningDays),
  };
}

// --- Checkout classification ---------------------------------------------------------------------

/** The current subscription as checkout rules need it (null: none yet). */
export interface CurrentSubscription {
  status: SubscriptionStatus;
  planId: string;
  /** The current plan's quota and monthly price. */
  quotaBytes: number;
  priceMonthSatang: number;
  billing: BillingMode;
  cancelAtPeriodEnd: boolean;
  periodStart: Date;
  periodEnd: Date;
  /** A scheduled downgrade (`pending_plan_id`), or null. */
  pendingPlanId: string | null;
}

/** A purchasable plan: active and not the trial (the API's lookup answers PLAN_NOT_FOUND else). */
export interface TargetPlan extends PlanPrices {
  id: string;
  quotaBytes: number;
}

/**
 * The change a checkout of `target` makes, from the current state:
 * - none, purged or trial: `new`;
 * - expired or grace: `renew` for the same plan, else `new`;
 * - active: `renew` for the same plan; else bigger (quota, then monthly price) is `upgrade`,
 *   anything else `downgrade`.
 */
export function classifyCheckout(
  current: CurrentSubscription | null,
  target: TargetPlan,
): CheckoutChangeType {
  if (current === null || current.status === 'purged' || current.status === 'trial') return 'new';
  if (current.planId === target.id) return 'renew';
  if (current.status !== 'active') return 'new';
  const bigger =
    target.quotaBytes > current.quotaBytes ||
    (target.quotaBytes === current.quotaBytes &&
      target.priceMonthSatang > current.priceMonthSatang);
  return bigger ? 'upgrade' : 'downgrade';
}

/** How the checkout is paid (POST /billing/checkout `payment`). */
export type CheckoutPayment =
  { method: 'promptpay'; months: number | null } | { method: 'card'; months: AutoRenewMonths };

export type CheckoutValidation =
  | { ok: true; changeType: CheckoutChangeType }
  | { ok: false; reason: PlanChangeInvalidReason; expected: CheckoutChangeType };

/** Checks a checkout request against the state (in the transaction that locks it). */
export function validateCheckout(input: {
  current: CurrentSubscription | null;
  target: TargetPlan;
  declared: CheckoutChangeType;
  payment: CheckoutPayment;
  prepaidMonths: readonly number[];
}): CheckoutValidation {
  const { current, payment } = input;
  const expected = classifyCheckout(current, input.target);
  const fail = (reason: PlanChangeInvalidReason): CheckoutValidation => ({
    ok: false,
    reason,
    expected,
  });
  if (input.declared !== expected) return fail('change_type_mismatch');
  if (current?.pendingPlanId != null && current.status === 'active') {
    return fail('pending_change_exists');
  }
  if (payment.method === 'promptpay') {
    if (expected === 'upgrade') {
      if (payment.months !== null) return fail('months_not_allowed');
    } else {
      if (payment.months === null) return fail('months_required');
      if (!input.prepaidMonths.includes(payment.months)) return fail('months_not_offered');
    }
  } else {
    const autoRenewOn = current?.billing === 'auto_renew';
    if (expected === 'renew' && autoRenewOn && current?.status === 'active') {
      return fail('auto_renew_active');
    }
    if (expected === 'downgrade' && !autoRenewOn) return fail('card_downgrade_needs_auto_renew');
  }
  return { ok: true, changeType: expected };
}

export interface CheckoutCharge {
  /** VAT-inclusive amount to collect now; 0 means the change applies without a payment. */
  amountSatang: number;
  /** Months bought (prepaid) or the auto-renew interval (card); null for a PromptPay upgrade. */
  months: number | null;
  /** Upgrades only. */
  proration: { remainingDays: number; amountSatang: number } | null;
}

/**
 * What a validated checkout costs now:
 * - new, renew: periodPriceSatang(target, months);
 * - upgrade: prorateUpgrade, waived (0) when below `minChargeSatang`. A card upgrade charges the
 *   proration too and switches the subscription to auto-renew with that card and interval;
 * - downgrade with PromptPay: periodPriceSatang(target, months), for months that start at
 *   `period_end`; with card (auto-renew): 0, the next renewal charges the smaller plan.
 * Admins keep plan prices at or above BILLING_MIN_CHARGE_SATANG, so only proration is waived.
 */
export function planCheckoutCharge(input: {
  changeType: CheckoutChangeType;
  current: CurrentSubscription | null;
  target: TargetPlan;
  payment: CheckoutPayment;
  now: Date;
  daysPerMonth: number;
  minChargeSatang: number;
}): CheckoutCharge {
  const { changeType, current, target, payment } = input;
  if (changeType === 'upgrade') {
    if (current === null) throw new RangeError('an upgrade needs a current subscription');
    const proration = prorateUpgrade({
      fromPriceMonthSatang: current.priceMonthSatang,
      toPriceMonthSatang: target.priceMonthSatang,
      periodEnd: current.periodEnd,
      now: input.now,
      daysPerMonth: input.daysPerMonth,
    });
    const amountSatang =
      proration.amountSatang < input.minChargeSatang ? 0 : proration.amountSatang;
    return {
      amountSatang,
      months: payment.method === 'card' ? payment.months : null,
      proration,
    };
  }
  if (payment.months === null) throw new RangeError(`${changeType} needs months`);
  if (changeType === 'downgrade' && payment.method === 'card') {
    return { amountSatang: 0, months: payment.months, proration: null };
  }
  return {
    amountSatang: periodPriceSatang(target, payment.months),
    months: payment.months,
    proration: null,
  };
}

// --- Applying a paid (or free) checkout ----------------------------------------------------------

/** The subscription columns a change sets. */
export interface SubscriptionValues {
  status: SubscriptionStatus;
  planId: string;
  billing: BillingMode;
  periodStart: Date;
  periodEnd: Date;
  cancelAtPeriodEnd: boolean;
  /** Set exactly when billing is auto_renew. */
  autoRenewMonths: AutoRenewMonths | null;
  paymentMethodGateway: string | null;
  paymentMethodRef: string | null;
  pendingPlanId: string | null;
  pendingPlanEffectiveAt: Date | null;
}

export interface AppliedChange {
  values: SubscriptionValues;
  /** Rows to insert into subscription_events, in order. */
  events: SubscriptionEventType[];
}

export interface CheckoutToApply {
  changeType: CheckoutChangeType;
  targetPlanId: string;
  payment: CheckoutPayment;
  /** From the gateway's paid event when a card was saved; required for card payments. */
  paymentMethod: { gateway: string; ref: string } | null;
}

/**
 * The new subscription values after a checkout is paid (or applied free), at `now`. `current` is
 * null for a first subscription or after purge: the caller inserts a new row with these values.
 * Re-validate first (classifyCheckout must still give `changeType`): otherwise the payment is
 * unapplied (see the webhook pattern above).
 *
 * - new: active, target plan, period [now, now + months]; card sets auto-renew, PromptPay prepaid.
 * - renew: period_end + months from period_end (active, grace) or from now (expired, which also
 *   restarts period_start).
 * - upgrade: target plan now, period unchanged.
 * - downgrade: PromptPay: pending plan from the old period_end, period_end + months; card: pending
 *   plan from period_end, nothing else changes.
 * A card payment always (re)enables auto-renew with the saved method and clears
 * cancel_at_period_end.
 */
export function applyCheckout(
  current: SubscriptionValues | null,
  checkout: CheckoutToApply,
  now: Date,
): AppliedChange {
  const { changeType, payment } = checkout;
  const card = payment.method === 'card';
  if (card && checkout.paymentMethod === null) {
    throw new RangeError('a card checkout needs the saved payment method');
  }
  const billing = card
    ? {
        billing: 'auto_renew' as const,
        autoRenewMonths: payment.months,
        paymentMethodGateway: checkout.paymentMethod?.gateway ?? null,
        paymentMethodRef: checkout.paymentMethod?.ref ?? null,
        cancelAtPeriodEnd: false,
      }
    : null;
  const enabledAutoRenew: SubscriptionEventType[] =
    card && current?.billing !== 'auto_renew' ? ['auto_renew_enabled'] : [];
  const months = payment.months;

  if (changeType === 'new' || current === null) {
    if (months === null) throw new RangeError('new needs months');
    if (current !== null && subscriptionTransition(current.status, 'checkout_new') === null) {
      throw new RangeError(`new is not allowed from ${current.status} (purged: insert a new row)`);
    }
    return {
      values: {
        status: 'active',
        planId: checkout.targetPlanId,
        billing: 'prepaid',
        autoRenewMonths: null,
        paymentMethodGateway: null,
        paymentMethodRef: null,
        cancelAtPeriodEnd: false,
        ...billing,
        periodStart: now,
        periodEnd: addMonthsBangkok(now, months),
        pendingPlanId: null,
        pendingPlanEffectiveAt: null,
      },
      events: [current === null ? 'created' : 'activated', ...enabledAutoRenew],
    };
  }

  const next = subscriptionTransition(current.status, CHECKOUT_TRANSITION_EVENT[changeType]);
  if (next === null) {
    throw new RangeError(`${changeType} is not allowed from ${current.status}`);
  }
  const base: SubscriptionValues = { ...current, ...billing, status: next };
  switch (changeType) {
    case 'renew': {
      if (months === null) throw new RangeError('renew needs months');
      const fromNow = current.status === 'expired';
      return {
        values: {
          ...base,
          periodStart: fromNow ? now : current.periodStart,
          periodEnd: addMonthsBangkok(fromNow ? now : current.periodEnd, months),
        },
        events: ['renewed', ...enabledAutoRenew],
      };
    }
    case 'upgrade':
      return {
        values: { ...base, planId: checkout.targetPlanId },
        events: ['upgraded', ...enabledAutoRenew],
      };
    case 'downgrade':
      return {
        values: {
          ...base,
          pendingPlanId: checkout.targetPlanId,
          pendingPlanEffectiveAt: current.periodEnd,
          periodEnd:
            payment.method === 'promptpay' && months !== null
              ? addMonthsBangkok(current.periodEnd, months)
              : current.periodEnd,
        },
        events: ['downgrade_scheduled', ...enabledAutoRenew],
      };
  }
}

/** A paid auto-renew charge: `autoRenewMonths` more from period_end (active or grace). */
export function applyRenewalPayment(current: SubscriptionValues, now: Date): AppliedChange {
  if (current.billing !== 'auto_renew' || current.autoRenewMonths === null) {
    throw new RangeError('renewal payments need an auto-renew subscription');
  }
  const next = subscriptionTransition(current.status, 'checkout_renew');
  if (next === null) throw new RangeError(`renewal not allowed from ${current.status}`);
  const fromNow = current.status === 'expired';
  return {
    values: {
      ...current,
      status: next,
      periodStart: fromNow ? now : current.periodStart,
      periodEnd: addMonthsBangkok(fromNow ? now : current.periodEnd, current.autoRenewMonths),
    },
    events: ['renewed'],
  };
}

/**
 * POST /billing/subscription/cancel: auto-renew off at period end. The saved method is detached
 * at the gateway (cancelAutoRenew) and forgotten; the subscription stays active until period_end
 * and then runs out like a prepaid one. Idempotent: a prepaid subscription is returned unchanged.
 */
export function cancelAutoRenewValues(current: SubscriptionValues): AppliedChange {
  if (current.billing !== 'auto_renew') return { values: current, events: [] };
  return {
    values: {
      ...current,
      billing: 'prepaid',
      autoRenewMonths: null,
      paymentMethodGateway: null,
      paymentMethodRef: null,
      cancelAtPeriodEnd: true,
    },
    events: ['auto_renew_canceled'],
  };
}

// --- Daily job --------------------------------------------------------------------------------------

export type LifecycleStep =
  | { type: 'downgrade_applied'; planId: string }
  | { type: 'grace_started' }
  | { type: 'expired' }
  | { type: 'purged' };

/**
 * What `subscriptions.transition.daily` must do for one subscription at `now`, in order. A missed
 * run catches up: an active subscription long past its period can step to grace and expired in
 * one run (each step writes its own subscription_events row and notice). A pending downgrade
 * applies first, when `pending_plan_effective_at <= now`.
 */
export function dueLifecycleSteps(
  current: Pick<
    SubscriptionValues,
    'status' | 'periodEnd' | 'pendingPlanId' | 'pendingPlanEffectiveAt'
  >,
  now: Date,
  days: LifecycleDays,
): LifecycleStep[] {
  const steps: LifecycleStep[] = [];
  const t = now.getTime();
  if (
    current.pendingPlanId !== null &&
    current.pendingPlanEffectiveAt !== null &&
    current.pendingPlanEffectiveAt.getTime() <= t &&
    (current.status === 'active' || current.status === 'grace')
  ) {
    steps.push({ type: 'downgrade_applied', planId: current.pendingPlanId });
  }
  const deadlines = subscriptionDeadlines(current.periodEnd, days);
  let status = current.status;
  if ((status === 'trial' || status === 'active') && t >= deadlines.graceStartsAt.getTime()) {
    steps.push({ type: 'grace_started' });
    status = 'grace';
  }
  if (status === 'grace' && t >= deadlines.expiresAt.getTime()) {
    steps.push({ type: 'expired' });
    status = 'expired';
  }
  if (status === 'expired' && t >= deadlines.purgeAt.getTime()) {
    steps.push({ type: 'purged' });
  }
  return steps;
}

/**
 * Whether the daily job charges an auto-renew subscription now: auto-renew on, active or grace,
 * `period_end - leadSeconds <= now` and still before the grace deadline, fewer than `maxAttempts`
 * failed charges for this period_end and no pending or paid one (the partial unique index
 * `payments_one_open_renewal` backs this up).
 */
export function renewalChargeDue(input: {
  current: Pick<SubscriptionValues, 'status' | 'billing' | 'periodEnd'>;
  now: Date;
  leadSeconds: number;
  maxAttempts: number;
  graceDays: number;
  failedAttemptsForPeriod: number;
  openOrPaidForPeriod: boolean;
}): boolean {
  const { current, now } = input;
  if (current.billing !== 'auto_renew') return false;
  if (current.status !== 'active' && current.status !== 'grace') return false;
  if (input.openOrPaidForPeriod || input.failedAttemptsForPeriod >= input.maxAttempts) return false;
  const t = now.getTime();
  return (
    t >= current.periodEnd.getTime() - input.leadSeconds * 1000 &&
    t < addDays(current.periodEnd, input.graceDays).getTime()
  );
}

/**
 * Amount of the next auto-renew charge: `autoRenewMonths` of the plan that applies at period_end
 * (the pending downgrade's plan when it takes effect by then, else the current plan).
 */
export function renewalAmountSatang(plan: PlanPrices, autoRenewMonths: AutoRenewMonths): number {
  return periodPriceSatang(plan, autoRenewMonths);
}

// --- Quota effects ----------------------------------------------------------------------------------

/**
 * Informational notice (BILLING_NOTICE_CODES) of a downgrade whose plan is smaller than what the
 * photographer stores: uploads will be blocked from the effective date until used + reserved fits
 * the new quota. Nothing is deleted. Null when it fits.
 */
export function downgradeQuotaNotice(
  usage: Pick<QuotaState, 'usedBytes' | 'reservedBytes'>,
  newQuotaBytes: number,
): {
  code: 'DOWNGRADE_EXCEEDS_QUOTA';
  details: { quotaBytes: number; usedBytes: number; reservedBytes: number; overBytes: number };
} | null {
  const state = { ...usage, quotaBytes: newQuotaBytes };
  const over = usage.usedBytes + usage.reservedBytes - newQuotaBytes;
  if (over <= 0) return null;
  availableBytes(state); // validates the counters
  return {
    code: 'DOWNGRADE_EXCEEDS_QUOTA',
    details: {
      quotaBytes: newQuotaBytes,
      usedBytes: usage.usedBytes,
      reservedBytes: usage.reservedBytes,
      overBytes: over,
    },
  };
}
