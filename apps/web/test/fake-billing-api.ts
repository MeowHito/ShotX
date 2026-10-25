import {
  addDays,
  addMonthsBangkok,
  AUTO_RENEW_MONTHS,
  BILLING_ROUTES,
  type BillingMode,
  type CheckoutChangeType,
  type CheckoutPaymentBody,
  type CheckoutResponse,
  type CreateCheckoutBody,
  type CurrentSubscription,
  downgradeQuotaNotice,
  type PaymentView,
  periodPriceSatang,
  planCheckoutCharge,
  type RouteContract,
  splitVat,
  type SubscriptionResponse,
  type SubscriptionStatus,
  type SubscriptionView,
  validateCheckout,
} from '@shotx/shared';
import { type FakeApi, Fail, NOW } from './fake-api';
import { NOT_HANDLED } from './fake-share-api';

/**
 * Billing routes of the fake API (Phase 4). It reuses the shared billing rules
 * (validateCheckout, planCheckoutCharge, periodPriceSatang, splitVat) so the UI is tested against
 * the same decisions the API makes. Payments settle after `pollsUntilFinal` polls of
 * GET /billing/payments/:id with `outcome`; a card checkout returns a redirect to a fake hosted
 * page (never a real gateway).
 */

const GiB = 1024 ** 3;
const VAT = 700;
const PREPAID_MONTHS = [1, 3, 6, 12];
const MIN_CHARGE = 2000;

export interface FakePlan {
  code: string;
  name: string;
  quotaBytes: number;
  priceMonthSatang: number;
  priceYearSatang: number;
}

/** The seed plans (prices include VAT). */
export const FAKE_PLANS: FakePlan[] = [
  {
    code: 'starter',
    name: 'Starter',
    quotaBytes: 10 * GiB,
    priceMonthSatang: 14_900,
    priceYearSatang: 149_000,
  },
  {
    code: 'standard',
    name: 'Standard',
    quotaBytes: 50 * GiB,
    priceMonthSatang: 39_000,
    priceYearSatang: 390_000,
  },
  {
    code: 'pro',
    name: 'Pro',
    quotaBytes: 200 * GiB,
    priceMonthSatang: 99_000,
    priceYearSatang: 990_000,
  },
  {
    code: 'studio',
    name: 'Studio',
    quotaBytes: 500 * GiB,
    priceMonthSatang: 229_000,
    priceYearSatang: 2_290_000,
  },
];

const TRIAL_PLAN: FakePlan = {
  code: 'trial',
  name: 'Trial',
  quotaBytes: 2 * GiB,
  priceMonthSatang: 0,
  priceYearSatang: 0,
};

export interface FakeSubscription {
  status: SubscriptionStatus;
  planCode: string;
  billing: BillingMode;
  autoRenewMonths: 1 | 12 | null;
  periodStart: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
  pendingChange: { planCode: string; effectiveAt: string } | null;
}

interface FakePayment {
  view: PaymentView;
  polls: number;
  apply: () => void;
}

export interface FakeBillingOptions {
  /** Polls of GET /billing/payments/:id before the payment is final. */
  pollsUntilFinal: number;
  outcome: 'paid' | 'expired' | 'failed';
  /** The gateway returns a QR image in the checkout response (else the page draws it). */
  qrImage: boolean;
}

export class FakeBilling {
  plans: FakePlan[] = FAKE_PLANS.map((p) => ({ ...p }));
  subscription: FakeSubscription | null = {
    status: 'active',
    planCode: 'standard',
    billing: 'prepaid',
    autoRenewMonths: null,
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-12-01T00:00:00.000Z',
    cancelAtPeriodEnd: false,
    pendingChange: null,
  };
  payments = new Map<string, FakePayment>();
  checkoutKeys = new Map<string, { body: string; response: CheckoutResponse }>();
  options: FakeBillingOptions = { pollsUntilFinal: 2, outcome: 'paid', qrImage: false };
  /** POST /billing/subscription/cancel calls. */
  cancelCalls = 0;

  plan(code: string): FakePlan | undefined {
    return code === TRIAL_PLAN.code ? TRIAL_PLAN : this.plans.find((p) => p.code === code);
  }
}

function summary(plan: FakePlan) {
  return { code: plan.code, name: plan.name, quotaBytes: plan.quotaBytes };
}

function subscriptionView(billing: FakeBilling): SubscriptionView | null {
  const sub = billing.subscription;
  if (sub === null) return null;
  const plan = billing.plan(sub.planCode) ?? TRIAL_PLAN;
  const periodEnd = new Date(sub.periodEnd);
  const expiresAt = addDays(periodEnd, 14);
  const pending = sub.pendingChange === null ? undefined : billing.plan(sub.pendingChange.planCode);
  const renewPlan = pending ?? plan;
  return {
    id: '0195f3a2-8d2f-7e5b-8c3a-000000000001',
    status: sub.status,
    plan: summary(plan),
    billing: sub.billing,
    autoRenewMonths: sub.autoRenewMonths,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    pendingChange:
      sub.pendingChange === null || pending === undefined
        ? null
        : { plan: summary(pending), effectiveAt: sub.pendingChange.effectiveAt },
    nextRenewal:
      sub.billing === 'auto_renew' && sub.autoRenewMonths !== null
        ? {
            at: sub.periodEnd,
            plan: summary(renewPlan),
            months: sub.autoRenewMonths,
            amount: splitVat(periodPriceSatang(renewPlan, sub.autoRenewMonths), VAT),
          }
        : null,
    expiresAt: expiresAt.toISOString(),
    purgeAt: addDays(expiresAt, 45).toISOString(),
  };
}

function subscriptionResponse(api: FakeApi): SubscriptionResponse {
  const view = subscriptionView(api.billing);
  const pending = api.billing.subscription?.pendingChange;
  const pendingPlan = pending ? api.billing.plan(pending.planCode) : undefined;
  const notice =
    pendingPlan === undefined
      ? null
      : downgradeQuotaNotice(
          { usedBytes: api.options.usedBytes, reservedBytes: 0 },
          pendingPlan.quotaBytes,
        );
  return { subscription: view, notices: notice === null ? [] : [notice] };
}

function current(billing: FakeBilling): CurrentSubscription | null {
  const sub = billing.subscription;
  if (sub === null) return null;
  const plan = billing.plan(sub.planCode) ?? TRIAL_PLAN;
  return {
    status: sub.status,
    planId: plan.code,
    quotaBytes: plan.quotaBytes,
    priceMonthSatang: plan.priceMonthSatang,
    billing: sub.billing,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodStart: new Date(sub.periodStart),
    periodEnd: new Date(sub.periodEnd),
    pendingPlanId: sub.pendingChange?.planCode ?? null,
  };
}

function applyChange(
  billing: FakeBilling,
  plan: FakePlan,
  changeType: CheckoutChangeType,
  payment: { method: 'promptpay' | 'card'; months: number | null },
) {
  const now = new Date(NOW);
  const sub = billing.subscription;
  const card = payment.method === 'card';
  const billingValues = card
    ? {
        billing: 'auto_renew' as const,
        autoRenewMonths: payment.months as 1 | 12,
        cancelAtPeriodEnd: false,
      }
    : {};
  const months = payment.months ?? 0;
  if (changeType === 'upgrade' && sub !== null) {
    billing.subscription = { ...sub, planCode: plan.code, ...billingValues };
  } else if (changeType === 'downgrade' && sub !== null) {
    billing.subscription = {
      ...sub,
      ...billingValues,
      periodEnd: card
        ? sub.periodEnd
        : addMonthsBangkok(new Date(sub.periodEnd), months).toISOString(),
      pendingChange: { planCode: plan.code, effectiveAt: sub.periodEnd },
    };
  } else if (changeType === 'renew' && sub !== null) {
    const from = sub.status === 'expired' ? now : new Date(sub.periodEnd);
    billing.subscription = {
      ...sub,
      ...billingValues,
      status: 'active',
      periodEnd: addMonthsBangkok(from, months).toISOString(),
    };
  } else {
    billing.subscription = {
      status: 'active',
      planCode: plan.code,
      billing: 'prepaid',
      autoRenewMonths: null,
      cancelAtPeriodEnd: false,
      pendingChange: null,
      periodStart: NOW,
      periodEnd: addMonthsBangkok(now, months).toISOString(),
      ...billingValues,
    };
  }
}

function checkout(
  api: FakeApi,
  body: CreateCheckoutBody & { payment: CheckoutPaymentBody },
  key: string,
): CheckoutResponse {
  const billing = api.billing;
  const replay = billing.checkoutKeys.get(key);
  const canonical = JSON.stringify(body);
  if (replay !== undefined) {
    if (replay.body !== canonical) throw new Fail('IDEMPOTENCY_KEY_REUSED');
    return replay.response;
  }
  for (const p of billing.payments.values()) {
    if (p.view.status === 'pending' && p.view.kind === 'checkout') {
      throw new Fail('CHECKOUT_PENDING', {
        paymentId: p.view.id,
        expiresAt: p.view.checkout?.expiresAt ?? NOW,
      });
    }
  }
  const plan = billing.plans.find((p) => p.code === body.planCode);
  if (plan === undefined) throw new Fail('PLAN_NOT_FOUND');
  const payment =
    body.payment.method === 'card'
      ? { method: 'card' as const, months: body.payment.months }
      : { method: 'promptpay' as const, months: body.payment.months ?? null };
  const cur = current(billing);
  const target = { id: plan.code, ...plan };
  const valid = validateCheckout({
    current: cur,
    target,
    declared: body.changeType,
    payment,
    prepaidMonths: PREPAID_MONTHS,
  });
  if (!valid.ok) {
    throw new Fail('PLAN_CHANGE_INVALID', {
      reason: valid.reason,
      expectedChangeType: valid.expected,
    });
  }
  const charge = planCheckoutCharge({
    changeType: valid.changeType,
    current: cur,
    target,
    payment,
    now: new Date(NOW),
    daysPerMonth: 30,
    minChargeSatang: MIN_CHARGE,
  });
  const effectiveAt =
    valid.changeType === 'downgrade' && billing.subscription !== null
      ? billing.subscription.periodEnd
      : NOW;
  const notice =
    valid.changeType === 'downgrade'
      ? downgradeQuotaNotice(
          { usedBytes: api.options.usedBytes, reservedBytes: 0 },
          plan.quotaBytes,
        )
      : null;
  const checkoutId = crypto.randomUUID();
  const apply = () => applyChange(billing, plan, valid.changeType, payment);
  const base = {
    checkoutId,
    changeType: valid.changeType,
    plan: summary(plan),
    amount: splitVat(charge.amountSatang, VAT),
    months: charge.months,
    proration: charge.proration,
    effectiveAt,
    notices: notice === null ? [] : [notice],
  };
  let response: CheckoutResponse;
  if (charge.amountSatang === 0) {
    apply();
    response = { ...base, status: 'completed', paymentId: null, action: null };
  } else {
    const paymentId = crypto.randomUUID();
    const expiresAt = '2026-10-25T05:15:00.000Z';
    const action: NonNullable<CheckoutResponse['action']> =
      payment.method === 'promptpay'
        ? {
            kind: 'promptpay',
            qrPayload: `00020101021230570016A000000677010112011501055360068532702${paymentId.slice(0, 8)}5303764540${charge.amountSatang}5802TH6304ABCD`,
            qrImageDataUrl: billing.options.qrImage ? 'data:image/png;base64,iVBORw0KGgo=' : null,
            expiresAt,
          }
        : {
            kind: 'card_redirect',
            redirectUrl: `https://pay.fake-gateway.test/card/${paymentId}`,
            expiresAt,
          };
    billing.payments.set(paymentId, {
      polls: 0,
      apply,
      view: {
        id: paymentId,
        status: 'pending',
        method: payment.method,
        gateway: 'fake',
        amount: base.amount,
        createdAt: NOW,
        paidAt: null,
        kind: 'checkout',
        checkout: {
          id: checkoutId,
          changeType: valid.changeType,
          plan: summary(plan),
          status: 'pending',
          expiresAt,
          errorCode: null,
        },
        // Polled payments never carry the gateway's image.
        action: action.kind === 'promptpay' ? { ...action, qrImageDataUrl: null } : action,
      },
    });
    response = { ...base, status: 'pending', paymentId, action };
  }
  billing.checkoutKeys.set(key, { body: canonical, response });
  return response;
}

function pollPayment(api: FakeApi, id: string): PaymentView {
  const payment = api.billing.payments.get(id);
  if (payment === undefined) throw new Fail('NOT_FOUND');
  if (payment.view.status !== 'pending') return payment.view;
  payment.polls++;
  if (payment.polls >= api.billing.options.pollsUntilFinal) {
    const outcome = api.billing.options.outcome;
    if (outcome === 'paid') payment.apply();
    const checkoutStatus = outcome === 'paid' ? 'completed' : outcome;
    payment.view = {
      ...payment.view,
      status: outcome,
      paidAt: outcome === 'paid' ? NOW : null,
      action: null,
      checkout:
        payment.view.checkout === null
          ? null
          : { ...payment.view.checkout, status: checkoutStatus },
    };
  }
  return payment.view;
}

export function handleBilling(
  api: FakeApi,
  route: RouteContract,
  params: Record<string, string>,
  body: unknown,
  headers: Record<string, string | undefined>,
): unknown {
  const billing = api.billing;
  switch (route) {
    case BILLING_ROUTES.plans:
      return {
        plans: billing.plans.map((p) => ({
          ...summary(p),
          month: splitVat(p.priceMonthSatang, VAT),
          year: splitVat(p.priceYearSatang, VAT),
          prepaid: PREPAID_MONTHS.map((months) => ({
            months,
            amount: splitVat(periodPriceSatang(p, months), VAT),
          })),
        })),
        currency: 'THB',
        vatRateBasisPoints: VAT,
        prepaidMonths: PREPAID_MONTHS,
        autoRenewMonths: [...AUTO_RENEW_MONTHS],
      };
    case BILLING_ROUTES.subscription:
      return subscriptionResponse(api);
    case BILLING_ROUTES.cancelSubscription: {
      const sub = billing.subscription;
      if (sub === null) throw new Fail('NOT_FOUND');
      billing.cancelCalls++;
      if (sub.billing === 'auto_renew') {
        billing.subscription = {
          ...sub,
          billing: 'prepaid',
          autoRenewMonths: null,
          cancelAtPeriodEnd: true,
        };
      }
      return subscriptionResponse(api);
    }
    case BILLING_ROUTES.checkout:
      return checkout(
        api,
        body as CreateCheckoutBody & { payment: CheckoutPaymentBody },
        headers['idempotency-key'] ?? '',
      );
    case BILLING_ROUTES.payment:
      return pollPayment(api, params.id ?? '');
    default:
      return NOT_HANDLED;
  }
}
