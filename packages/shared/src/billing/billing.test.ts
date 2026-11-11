import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonthsBangkok,
  applyCheckout,
  applyRenewalPayment,
  bangkokDate,
  BILLING_ROUTES,
  cancelAutoRenewValues,
  checkoutResponseSchema,
  classifyCheckout,
  createCheckoutBodySchema,
  type CurrentSubscription,
  downgradeQuotaNotice,
  DROPPED_EMAIL_MESSAGE_ID,
  type DroppedEmailLogEntry,
  droppedEmailLogEntry,
  dueLifecycleSteps,
  dueRenewalReminder,
  type EmailMessage,
  EMAIL_PROVIDERS,
  EMAIL_TEMPLATE_NAMES,
  EMAIL_TEMPLATE_PARAMS,
  EMAIL_TEMPLATES,
  ERROR_HTTP_STATUS,
  FAKE_WEBHOOK_SIGNATURE_HEADER,
  fakeWebhookBodySchema,
  fakeWebhookSignatureHeader,
  isEgressAnomalous,
  loadEmailConfig,
  loadPaymentGatewayConfig,
  loadSesClientConfig,
  OffEmailProvider,
  loadBillingModeConfig,
  BILLING_OPERATING_MODES,
  normalizedPaymentEventSchema,
  PAYMENT_GATEWAY_SECRET_ENV,
  periodPriceSatang,
  planCheckoutCharge,
  plansResponseSchema,
  prorateUpgrade,
  purgeWarningDue,
  renewalChargeDue,
  splitVat,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_TRANSITION_EVENTS,
  SUBSCRIPTION_TRANSITIONS,
  subscriptionDeadlines,
  subscriptionTransition,
  type SubscriptionValues,
  type TargetPlan,
  validateCheckout,
  vatFromInclusive,
  verifyFakeWebhookSignature,
} from '../index';

const thb = (baht: number) => baht * 100;
const GB = 1024 ** 3;
const plan = (id: string, quotaGb: number, month: number, year: number): TargetPlan => ({
  id,
  quotaBytes: quotaGb * GB,
  priceMonthSatang: thb(month),
  priceYearSatang: thb(year),
});
const starter = plan('starter', 10, 149, 1_490);
const standard = plan('standard', 50, 390, 3_900);
const pro = plan('pro', 200, 990, 9_900);
const days = { graceDays: 14, purgeAfterExpiryDays: 45, purgeWarningDays: 7 };

const subscription = (
  status: CurrentSubscription['status'],
  over: Partial<CurrentSubscription> = {},
): CurrentSubscription => ({
  status,
  planId: standard.id,
  quotaBytes: standard.quotaBytes,
  priceMonthSatang: standard.priceMonthSatang,
  billing: 'prepaid',
  cancelAtPeriodEnd: false,
  periodStart: new Date('2026-10-01T00:00:00Z'),
  periodEnd: new Date('2026-11-01T00:00:00Z'),
  pendingPlanId: null,
  ...over,
});

const values = (over: Partial<SubscriptionValues> = {}): SubscriptionValues => ({
  status: 'active',
  planId: standard.id,
  billing: 'prepaid',
  periodStart: new Date('2026-10-01T00:00:00Z'),
  periodEnd: new Date('2026-11-01T00:00:00Z'),
  cancelAtPeriodEnd: false,
  autoRenewMonths: null,
  paymentMethodGateway: null,
  paymentMethodRef: null,
  pendingPlanId: null,
  pendingPlanEffectiveAt: null,
  ...over,
});

describe('VAT and prices (integer satang)', () => {
  it('splits VAT from VAT-inclusive totals, rounding half up', () => {
    expect(splitVat(thb(149), 700)).toEqual({
      totalSatang: 14_900,
      vatSatang: 975,
      netSatang: 13_925,
      vatRateBasisPoints: 700,
    });
    expect(vatFromInclusive(thb(990), 700)).toBe(6_477);
    expect(vatFromInclusive(107, 700)).toBe(7);
    expect(vatFromInclusive(0, 700)).toBe(0);
    expect(vatFromInclusive(1_000, 0)).toBe(0);
    // An exact half rounds up: 15 × 700 / 10700 = 0.98…, 107 × 700 / 10700 = 7.
    for (let total = 0; total < 5_000; total += 37) {
      const { vatSatang, netSatang } = splitVat(total, 700);
      expect(vatSatang + netSatang).toBe(total);
      expect(Math.abs(vatSatang - (total * 700) / 10_700)).toBeLessThanOrEqual(0.5);
    }
    expect(() => vatFromInclusive(1.5, 700)).toThrow(RangeError);
    expect(() => vatFromInclusive(-1, 700)).toThrow(RangeError);
  });

  it('prices periods from the monthly and yearly prices', () => {
    expect(periodPriceSatang(starter, 1)).toBe(thb(149));
    expect(periodPriceSatang(starter, 3)).toBe(thb(447));
    expect(periodPriceSatang(starter, 6)).toBe(thb(894));
    expect(periodPriceSatang(starter, 12)).toBe(thb(1_490));
    expect(periodPriceSatang(starter, 13)).toBe(thb(1_639));
    expect(() => periodPriceSatang(starter, 0)).toThrow(RangeError);
  });

  it('prorates an upgrade by started days left', () => {
    const now = new Date('2026-10-21T00:00:00Z');
    expect(
      prorateUpgrade({
        fromPriceMonthSatang: standard.priceMonthSatang,
        toPriceMonthSatang: pro.priceMonthSatang,
        periodEnd: new Date('2026-11-01T00:00:00Z'),
        now,
        daysPerMonth: 30,
      }),
    ).toEqual({ remainingDays: 11, amountSatang: 22_000 });
    // 10.5 days left count as 11; (99000 - 39000) × 11 / 30 = 22000 exactly.
    expect(
      prorateUpgrade({
        fromPriceMonthSatang: starter.priceMonthSatang,
        toPriceMonthSatang: standard.priceMonthSatang,
        periodEnd: new Date('2026-10-31T12:00:00Z'),
        now,
        daysPerMonth: 30,
      }),
    ).toEqual({ remainingDays: 11, amountSatang: 8_837 }); // 24100 × 11 / 30 = 8836.67
    expect(
      prorateUpgrade({
        fromPriceMonthSatang: 100,
        toPriceMonthSatang: 200,
        periodEnd: now,
        now,
        daysPerMonth: 30,
      }),
    ).toEqual({ remainingDays: 0, amountSatang: 0 });
  });
});

describe('periods in Asia/Bangkok', () => {
  it('adds months on the Bangkok calendar with month-end clamping', () => {
    // 2026-01-31 00:00 Bangkok is 2026-01-30T17:00Z.
    const jan31 = new Date('2026-01-30T17:00:00Z');
    expect(addMonthsBangkok(jan31, 1).toISOString()).toBe('2026-02-27T17:00:00.000Z'); // Feb 28
    expect(addMonthsBangkok(jan31, 13).toISOString()).toBe('2027-02-27T17:00:00.000Z');
    expect(addMonthsBangkok(new Date('2028-01-30T17:00:00Z'), 1).toISOString()).toBe(
      '2028-02-28T17:00:00.000Z', // Feb 29 in a leap year
    );
    expect(addMonthsBangkok(new Date('2026-03-30T17:00:00Z'), 1).toISOString()).toBe(
      '2026-04-29T17:00:00.000Z', // Mar 31 -> Apr 30
    );
    // 2026-10-31T20:00Z is already Nov 1, 03:00 in Bangkok: + 1 month is Dec 1 03:00.
    expect(addMonthsBangkok(new Date('2026-10-31T20:00:00Z'), 1).toISOString()).toBe(
      '2026-11-30T20:00:00.000Z',
    );
    expect(addMonthsBangkok(new Date('2026-12-15T05:00:00Z'), 12).toISOString()).toBe(
      '2027-12-15T05:00:00.000Z',
    );
    expect(() => addMonthsBangkok(jan31, -1)).toThrow(RangeError);
  });

  it('dates instants in Bangkok', () => {
    expect(bangkokDate(new Date('2026-10-31T17:00:00Z'))).toBe('2026-11-01');
    expect(bangkokDate(new Date('2026-10-31T16:59:59Z'))).toBe('2026-10-31');
    expect(addDays(new Date('2026-10-01T00:00:00Z'), 14).toISOString()).toBe(
      '2026-10-15T00:00:00.000Z',
    );
  });
});

describe('subscription state machine', () => {
  const allowed: Record<string, string> = {
    'trial checkout_new': 'active',
    'trial period_ended': 'grace',
    'active checkout_renew': 'active',
    'active checkout_upgrade': 'active',
    'active checkout_downgrade': 'active',
    'active auto_renew_canceled': 'active',
    'active period_ended': 'grace',
    'grace checkout_renew': 'active',
    'grace checkout_new': 'active',
    'grace grace_ended': 'expired',
    'expired checkout_renew': 'active',
    'expired checkout_new': 'active',
    'expired purge_due': 'purged',
  };

  it('allows exactly the listed transitions and forbids every other one', () => {
    expect(SUBSCRIPTION_TRANSITIONS).toHaveLength(Object.keys(allowed).length);
    for (const from of SUBSCRIPTION_STATUSES) {
      for (const event of SUBSCRIPTION_TRANSITION_EVENTS) {
        expect(subscriptionTransition(from, event), `${from} ${event}`).toBe(
          allowed[`${from} ${event}`] ?? null,
        );
      }
    }
    // Explicitly forbidden examples.
    expect(subscriptionTransition('purged', 'checkout_new')).toBeNull();
    expect(subscriptionTransition('grace', 'checkout_upgrade')).toBeNull();
    expect(subscriptionTransition('expired', 'grace_ended')).toBeNull();
    expect(subscriptionTransition('trial', 'checkout_renew')).toBeNull();
  });

  it('derives every deadline from period_end', () => {
    const d = subscriptionDeadlines(new Date('2026-11-01T00:00:00Z'), days);
    expect(d.expiresAt.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(d.purgeAt.toISOString()).toBe('2026-12-30T00:00:00.000Z');
    expect(d.purgeWarningAt.toISOString()).toBe('2026-12-23T00:00:00.000Z');
  });

  it('steps through grace, expired and purged, catching up after missed runs', () => {
    const current = values();
    const at = (iso: string) => dueLifecycleSteps(current, new Date(iso), days);
    expect(at('2026-10-31T23:59:59Z')).toEqual([]);
    expect(at('2026-11-01T00:00:00Z')).toEqual([{ type: 'grace_started' }]);
    expect(at('2026-11-20T00:00:00Z')).toEqual([{ type: 'grace_started' }, { type: 'expired' }]);
    expect(at('2027-01-01T00:00:00Z')).toEqual([
      { type: 'grace_started' },
      { type: 'expired' },
      { type: 'purged' },
    ]);
    expect(
      dueLifecycleSteps(values({ status: 'purged' }), new Date('2030-01-01T00:00:00Z'), days),
    ).toEqual([]);
  });

  it('applies a pending downgrade at its effective date, before the period check', () => {
    const current = values({
      pendingPlanId: starter.id,
      pendingPlanEffectiveAt: new Date('2026-11-01T00:00:00Z'),
      periodEnd: new Date('2026-12-01T00:00:00Z'),
    });
    expect(dueLifecycleSteps(current, new Date('2026-10-31T00:00:00Z'), days)).toEqual([]);
    expect(dueLifecycleSteps(current, new Date('2026-11-01T00:00:00Z'), days)).toEqual([
      { type: 'downgrade_applied', planId: starter.id },
    ]);
  });
});

describe('checkout rules', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  const base = { prepaidMonths: [1, 3, 6, 12] };

  it('classifies the change from the state and the plans', () => {
    expect(classifyCheckout(null, pro)).toBe('new');
    expect(classifyCheckout(subscription('trial'), standard)).toBe('new');
    expect(classifyCheckout(subscription('purged'), standard)).toBe('new');
    expect(classifyCheckout(subscription('active'), standard)).toBe('renew');
    expect(classifyCheckout(subscription('active'), pro)).toBe('upgrade');
    expect(classifyCheckout(subscription('active'), starter)).toBe('downgrade');
    expect(classifyCheckout(subscription('grace'), standard)).toBe('renew');
    expect(classifyCheckout(subscription('grace'), pro)).toBe('new');
    expect(classifyCheckout(subscription('expired'), standard)).toBe('renew');
    expect(classifyCheckout(subscription('expired'), starter)).toBe('new');
  });

  it('rejects mismatched or impossible checkouts with a reason', () => {
    const check = (
      current: CurrentSubscription | null,
      target: TargetPlan,
      declared: 'new' | 'renew' | 'upgrade' | 'downgrade',
      payment: Parameters<typeof validateCheckout>[0]['payment'],
    ) => validateCheckout({ ...base, current, target, declared, payment });
    expect(check(subscription('active'), pro, 'renew', { method: 'promptpay', months: 1 })).toEqual(
      { ok: false, reason: 'change_type_mismatch', expected: 'upgrade' },
    );
    expect(
      check(subscription('active'), pro, 'upgrade', { method: 'promptpay', months: null }),
    ).toEqual({ ok: true, changeType: 'upgrade' });
    expect(
      check(subscription('active'), pro, 'upgrade', { method: 'promptpay', months: 1 }),
    ).toMatchObject({ reason: 'months_not_allowed' });
    expect(
      check(subscription('active'), standard, 'renew', { method: 'promptpay', months: null }),
    ).toMatchObject({ reason: 'months_required' });
    expect(
      check(subscription('active'), standard, 'renew', { method: 'promptpay', months: 2 }),
    ).toMatchObject({ reason: 'months_not_offered' });
    expect(
      check(subscription('active', { billing: 'auto_renew' }), standard, 'renew', {
        method: 'card',
        months: 1,
      }),
    ).toMatchObject({ reason: 'auto_renew_active' });
    expect(
      check(subscription('active'), starter, 'downgrade', { method: 'card', months: 1 }),
    ).toMatchObject({ reason: 'card_downgrade_needs_auto_renew' });
    expect(
      check(subscription('active', { pendingPlanId: starter.id }), pro, 'upgrade', {
        method: 'promptpay',
        months: null,
      }),
    ).toMatchObject({ reason: 'pending_change_exists' });
  });

  it('charges period prices, prorated upgrades and nothing for card downgrades', () => {
    const charge = (
      changeType: 'new' | 'renew' | 'upgrade' | 'downgrade',
      current: CurrentSubscription | null,
      target: TargetPlan,
      payment: Parameters<typeof planCheckoutCharge>[0]['payment'],
      minChargeSatang = 2_000,
    ) =>
      planCheckoutCharge({
        changeType,
        current,
        target,
        payment,
        now,
        daysPerMonth: 30,
        minChargeSatang,
      });
    expect(charge('new', null, pro, { method: 'promptpay', months: 12 })).toEqual({
      amountSatang: thb(9_900),
      months: 12,
      proration: null,
    });
    expect(
      charge('upgrade', subscription('active'), pro, { method: 'promptpay', months: null }),
    ).toEqual({
      amountSatang: 22_000,
      months: null,
      proration: { remainingDays: 11, amountSatang: 22_000 },
    });
    const lastDay = { periodEnd: new Date('2026-10-22T00:00:00Z') };
    // 60000 × 1 / 30 = 2000: exactly the minimum, so it is charged.
    expect(
      charge('upgrade', subscription('active', lastDay), pro, { method: 'promptpay', months: null })
        .amountSatang,
    ).toBe(2_000);
    // Starter to standard on the last day: 24100 / 30 = 803 < 2000, waived (applied for free).
    expect(
      charge(
        'upgrade',
        subscription('active', {
          ...lastDay,
          planId: starter.id,
          quotaBytes: starter.quotaBytes,
          priceMonthSatang: starter.priceMonthSatang,
        }),
        standard,
        { method: 'promptpay', months: null },
      ),
    ).toEqual({
      amountSatang: 0,
      months: null,
      proration: { remainingDays: 1, amountSatang: 803 },
    });
    expect(
      charge('downgrade', subscription('active', { billing: 'auto_renew' }), starter, {
        method: 'card',
        months: 1,
      }).amountSatang,
    ).toBe(0);
    expect(
      charge('downgrade', subscription('active'), starter, { method: 'promptpay', months: 3 })
        .amountSatang,
    ).toBe(thb(447));
  });
});

describe('applying checkouts and renewals', () => {
  const now = new Date('2026-10-21T00:00:00Z');

  it('starts a new paid period now, from trial or without a subscription', () => {
    const fromTrial = applyCheckout(
      values({ status: 'trial' }),
      {
        changeType: 'new',
        targetPlanId: pro.id,
        payment: { method: 'promptpay', months: 3 },
        paymentMethod: null,
      },
      now,
    );
    expect(fromTrial.events).toEqual(['activated']);
    expect(fromTrial.values).toMatchObject({
      status: 'active',
      planId: pro.id,
      billing: 'prepaid',
      periodStart: now,
      periodEnd: new Date('2027-01-21T00:00:00Z'),
    });
    const first = applyCheckout(
      null,
      {
        changeType: 'new',
        targetPlanId: pro.id,
        payment: { method: 'card', months: 1 },
        paymentMethod: { gateway: 'fake', ref: 'card_1' },
      },
      now,
    );
    expect(first.events).toEqual(['created', 'auto_renew_enabled']);
    expect(first.values).toMatchObject({
      billing: 'auto_renew',
      autoRenewMonths: 1,
      paymentMethodRef: 'card_1',
    });
    expect(() =>
      applyCheckout(
        values({ status: 'purged' }),
        {
          changeType: 'new',
          targetPlanId: pro.id,
          payment: { method: 'promptpay', months: 1 },
          paymentMethod: null,
        },
        now,
      ),
    ).toThrow(/purged/);
  });

  it('renews from period_end in active and grace, from now when expired', () => {
    const renew = (status: SubscriptionValues['status']) =>
      applyCheckout(
        values({ status }),
        {
          changeType: 'renew',
          targetPlanId: standard.id,
          payment: { method: 'promptpay', months: 1 },
          paymentMethod: null,
        },
        now,
      ).values;
    expect(renew('active').periodEnd.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(renew('grace')).toMatchObject({
      status: 'active',
      periodEnd: new Date('2026-12-01T00:00:00Z'),
    });
    expect(renew('expired')).toMatchObject({
      status: 'active',
      periodStart: now,
      periodEnd: new Date('2026-11-21T00:00:00Z'),
    });
  });

  it('upgrades at once and schedules downgrades for period_end', () => {
    const up = applyCheckout(
      values(),
      {
        changeType: 'upgrade',
        targetPlanId: pro.id,
        payment: { method: 'promptpay', months: null },
        paymentMethod: null,
      },
      now,
    );
    expect(up.values).toMatchObject({
      planId: pro.id,
      periodEnd: new Date('2026-11-01T00:00:00Z'),
    });
    const down = applyCheckout(
      values(),
      {
        changeType: 'downgrade',
        targetPlanId: starter.id,
        payment: { method: 'promptpay', months: 1 },
        paymentMethod: null,
      },
      now,
    );
    expect(down.events).toEqual(['downgrade_scheduled']);
    expect(down.values).toMatchObject({
      planId: standard.id,
      pendingPlanId: starter.id,
      pendingPlanEffectiveAt: new Date('2026-11-01T00:00:00Z'),
      periodEnd: new Date('2026-12-01T00:00:00Z'),
    });
    expect(() =>
      applyCheckout(
        values({ status: 'grace' }),
        {
          changeType: 'upgrade',
          targetPlanId: pro.id,
          payment: { method: 'promptpay', months: null },
          paymentMethod: null,
        },
        now,
      ),
    ).toThrow(RangeError);
  });

  it('renews auto-renew subscriptions and cancels auto-renew idempotently', () => {
    const auto = values({
      billing: 'auto_renew',
      autoRenewMonths: 12,
      paymentMethodGateway: 'fake',
      paymentMethodRef: 'card_1',
    });
    expect(applyRenewalPayment(auto, now).values.periodEnd.toISOString()).toBe(
      '2027-11-01T00:00:00.000Z',
    );
    const canceled = cancelAutoRenewValues(auto);
    expect(canceled.events).toEqual(['auto_renew_canceled']);
    expect(canceled.values).toMatchObject({
      billing: 'prepaid',
      cancelAtPeriodEnd: true,
      paymentMethodRef: null,
      autoRenewMonths: null,
    });
    expect(cancelAutoRenewValues(canceled.values).events).toEqual([]);
  });

  it('charges renewals from the lead time until grace ends, within the attempt budget', () => {
    const due = (iso: string, over: Partial<Parameters<typeof renewalChargeDue>[0]> = {}) =>
      renewalChargeDue({
        current: { status: 'active', billing: 'auto_renew', periodEnd: new Date('2026-11-01Z') },
        now: new Date(iso),
        leadSeconds: 86_400,
        maxAttempts: 3,
        graceDays: 14,
        failedAttemptsForPeriod: 0,
        openOrPaidForPeriod: false,
        ...over,
      });
    expect(due('2026-10-30T23:59:59Z')).toBe(false);
    expect(due('2026-10-31T00:00:00Z')).toBe(true);
    expect(due('2026-11-14T23:59:59Z')).toBe(true);
    expect(due('2026-11-15T00:00:00Z')).toBe(false);
    expect(due('2026-10-31T00:00:00Z', { failedAttemptsForPeriod: 3 })).toBe(false);
    expect(due('2026-10-31T00:00:00Z', { openOrPaidForPeriod: true })).toBe(false);
  });
});

describe('quota effects', () => {
  it('flags a downgrade below current usage and never asks to delete', () => {
    expect(downgradeQuotaNotice({ usedBytes: 12 * GB, reservedBytes: 0 }, 10 * GB)).toEqual({
      code: 'DOWNGRADE_EXCEEDS_QUOTA',
      details: { quotaBytes: 10 * GB, usedBytes: 12 * GB, reservedBytes: 0, overBytes: 2 * GB },
    });
    expect(downgradeQuotaNotice({ usedBytes: 10 * GB, reservedBytes: 0 }, 10 * GB)).toBeNull();
  });
});

describe('reminders and alerts', () => {
  const periodEnd = new Date('2026-11-15T00:00:00Z');
  const reminder = (iso: string, sent: number[] = [], status: 'active' | 'grace' = 'active') =>
    dueRenewalReminder({
      status,
      periodEnd,
      now: new Date(iso),
      reminderDays: [14, 7, 1],
      sentDays: new Set(sent),
    });

  it('sends T-14, T-7 and T-1 once each, most urgent first', () => {
    expect(reminder('2026-10-31T23:59:59Z')).toBeNull();
    expect(reminder('2026-11-01T00:00:00Z')).toBe(14);
    expect(reminder('2026-11-02T00:00:00Z', [14])).toBeNull();
    expect(reminder('2026-11-08T00:00:00Z', [14])).toBe(7);
    // A missed week: only the most urgent one goes out.
    expect(reminder('2026-11-14T00:00:00Z')).toBe(1);
    expect(reminder('2026-11-15T00:00:00Z')).toBeNull();
    expect(reminder('2026-11-14T00:00:00Z', [], 'grace')).toBeNull();
  });

  it('warns before the purge, once', () => {
    const warn = (iso: string, alreadySent = false) =>
      purgeWarningDue({
        status: 'expired',
        periodEnd: new Date('2026-11-01T00:00:00Z'),
        now: new Date(iso),
        days,
        alreadySent,
      });
    expect(warn('2026-12-22T23:59:59Z')).toBe(false);
    expect(warn('2026-12-23T00:00:00Z')).toBe(true);
    expect(warn('2026-12-23T00:00:00Z', true)).toBe(false);
    expect(warn('2026-12-30T00:00:00Z')).toBe(false);
  });

  it('flags monthly egress above 20 × stored bytes past the floor', () => {
    const rule = { multiplier: 20, minBytes: 10 * GB };
    expect(isEgressAnomalous({ monthlyEgressBytes: 201 * GB, storedBytes: 10 * GB }, rule)).toBe(
      true,
    );
    expect(isEgressAnomalous({ monthlyEgressBytes: 200 * GB, storedBytes: 10 * GB }, rule)).toBe(
      false,
    );
    expect(isEgressAnomalous({ monthlyEgressBytes: 5 * GB, storedBytes: 0 }, rule)).toBe(false);
    expect(isEgressAnomalous({ monthlyEgressBytes: 11 * GB, storedBytes: 0 }, rule)).toBe(true);
  });
});

describe('fake gateway webhooks', () => {
  const secret = 'test-secret-0123456789';
  const body = new TextEncoder().encode(
    JSON.stringify({
      id: 'evt_1',
      chargeId: 'chrg_1',
      type: 'paid',
      amountSatang: 39_000,
      currency: 'THB',
      occurredAt: '2026-10-26T01:00:00Z',
    }),
  );
  const now = new Date('2026-10-26T01:00:10Z');
  const t = Math.floor(new Date('2026-10-26T01:00:00Z').getTime() / 1000);

  it('verifies HMAC-SHA256 over "<t>.<raw body>" within the tolerance', async () => {
    const header = await fakeWebhookSignatureHeader(secret, t, body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(FAKE_WEBHOOK_SIGNATURE_HEADER).toBe('x-fake-signature');
    const verify = (h: string | undefined, raw = body, at = now, key = secret) =>
      verifyFakeWebhookSignature({
        header: h,
        rawBody: raw,
        secret: key,
        now: at,
        toleranceSeconds: 300,
      });
    expect(await verify(header)).toBe(true);
    expect(await verify(header, new TextEncoder().encode('{}'))).toBe(false);
    expect(await verify(header, body, now, 'other-secret-0123456789')).toBe(false);
    expect(await verify(header, body, new Date(now.getTime() + 600_000))).toBe(false);
    expect(await verify(undefined)).toBe(false);
    expect(await verify('t=1,v1=zz')).toBe(false);
  });

  it('parses the fake body and the normalized event shape', () => {
    const parsed = fakeWebhookBodySchema.parse(JSON.parse(new TextDecoder().decode(body)));
    expect(parsed).toMatchObject({ paymentMethodRef: null, failureCode: null });
    expect(
      normalizedPaymentEventSchema.parse({
        gateway: 'fake',
        eventRef: parsed.id,
        gatewayRef: parsed.chargeId,
        type: parsed.type,
        amountSatang: parsed.amountSatang,
        currency: 'THB',
        occurredAt: new Date(parsed.occurredAt),
        paymentMethodRef: null,
        failureCode: null,
      }).type,
    ).toBe('paid');
    expect(
      normalizedPaymentEventSchema.safeParse({ gateway: 'stripe', amountSatang: 1.5 }).success,
    ).toBe(false);
  });
});

describe('billing config', () => {
  it('selects the gateway and requires only its secrets; refuses fake on the prod stage', () => {
    expect(
      loadPaymentGatewayConfig({
        BILLING_MODE: 'gateway',
        PAYMENT_FAKE_WEBHOOK_SECRET: 'x'.repeat(16),
      }),
    ).toEqual({
      gateway: 'fake',
      webhookToleranceSeconds: 300,
      secrets: { PAYMENT_FAKE_WEBHOOK_SECRET: 'x'.repeat(16) },
    });
    expect(() => loadPaymentGatewayConfig({ BILLING_MODE: 'gateway' })).toThrow(
      /PAYMENT_FAKE_WEBHOOK_SECRET/,
    );
    const fake = { PAYMENT_FAKE_WEBHOOK_SECRET: 'x'.repeat(16) };
    expect(() =>
      loadPaymentGatewayConfig({ BILLING_MODE: 'gateway', APP_STAGE: 'prod', ...fake }),
    ).toThrow(/APP_STAGE=prod/);
    expect(() =>
      loadPaymentGatewayConfig({
        BILLING_MODE: 'gateway',
        APP_STAGE: 'prod',
        NODE_ENV: 'development',
        ...fake,
      }),
    ).toThrow(/APP_STAGE=prod/);
    // Every ECS service runs with NODE_ENV=production; non-prod stages may use the fake gateway.
    for (const stage of ['staging', 'dev', 'local', undefined]) {
      expect(
        loadPaymentGatewayConfig({
          BILLING_MODE: 'gateway',
          APP_STAGE: stage,
          NODE_ENV: 'production',
          ...fake,
        })?.gateway,
      ).toBe('fake');
    }
    const omise = Object.fromEntries(
      PAYMENT_GATEWAY_SECRET_ENV.omise.map((k) => [k, 'y'.repeat(20)]),
    );
    expect(
      loadPaymentGatewayConfig({
        BILLING_MODE: 'gateway',
        APP_STAGE: 'prod',
        PAYMENT_GATEWAY: 'omise',
        ...omise,
      })?.gateway,
    ).toBe('omise');
    // Error messages never repeat secret values.
    try {
      loadPaymentGatewayConfig({
        BILLING_MODE: 'gateway',
        PAYMENT_FAKE_WEBHOOK_SECRET: 'short-secret',
      });
    } catch (error) {
      expect(String(error)).not.toContain('short-secret');
    }
  });

  it('needs no gateway setting or secret with BILLING_MODE=offline (the default, ADR 0010)', () => {
    expect(loadBillingModeConfig({})).toEqual({ mode: 'offline' });
    expect(loadBillingModeConfig({ BILLING_MODE: 'gateway' })).toEqual({ mode: 'gateway' });
    expect(() => loadBillingModeConfig({ BILLING_MODE: 'online' })).toThrow(/BILLING_MODE/);
    expect(BILLING_OPERATING_MODES).toEqual(['offline', 'gateway']);
    // No secrets, even on prod, even with a gateway named: nothing is read.
    expect(loadPaymentGatewayConfig({})).toBeNull();
    expect(loadPaymentGatewayConfig({ APP_STAGE: 'prod' })).toBeNull();
    expect(
      loadPaymentGatewayConfig({
        BILLING_MODE: 'offline',
        PAYMENT_GATEWAY: 'omise',
        APP_STAGE: 'prod',
      }),
    ).toBeNull();
    expect(() =>
      loadPaymentGatewayConfig({ BILLING_MODE: 'gateway', PAYMENT_GATEWAY: 'omise' }),
    ).toThrow(/PAYMENT_OMISE_WEBHOOK_SECRET/);
  });

  it('reads the email sender and refuses the fake provider on the prod stage', () => {
    expect(loadEmailConfig({ EMAIL_FROM_ADDRESS: 'no-reply@photos.example.com' })).toEqual({
      provider: 'fake',
      from: { address: 'no-reply@photos.example.com', name: 'ShotX' },
    });
    expect(() => loadEmailConfig({})).toThrow(/EMAIL_FROM_ADDRESS/);
    const from = { EMAIL_FROM_ADDRESS: 'a@b.co' };
    expect(() => loadEmailConfig({ APP_STAGE: 'prod', ...from })).toThrow(/APP_STAGE=prod/);
    for (const stage of ['staging', 'local', undefined]) {
      expect(loadEmailConfig({ APP_STAGE: stage, NODE_ENV: 'production', ...from }).provider).toBe(
        'fake',
      );
    }
    expect(loadEmailConfig({ APP_STAGE: 'prod', EMAIL_PROVIDER: 'ses', ...from }).provider).toBe(
      'ses',
    );
  });

  describe('EMAIL_PROVIDER=off (launch decision 2026-11-11)', () => {
    const prodVps = {
      APP_STAGE: 'prod',
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'shotx',
      STORAGE_ENDPOINT_URL: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
    };

    it('loads on prod with no SES_* setting and no EMAIL_FROM_ADDRESS', () => {
      expect(EMAIL_PROVIDERS).toEqual(['ses', 'fake', 'off']);
      expect(loadEmailConfig({ ...prodVps, EMAIL_PROVIDER: 'off' })).toEqual({
        provider: 'off',
        from: null,
      });
      expect(loadSesClientConfig({ ...prodVps, EMAIL_PROVIDER: 'off' })).toBeNull();
      for (const stage of ['staging', 'local', undefined]) {
        expect(loadEmailConfig({ APP_STAGE: stage, EMAIL_PROVIDER: 'off' }).provider).toBe('off');
      }
    });

    it('reads no SES_* value at all, not even leftovers or REPLACE_ME placeholders', () => {
      const leftovers = {
        SES_REGION: 'not a region',
        SES_ENDPOINT_URL: 'nope',
        SES_ACCESS_KEY_ID: 'REPLACE_ME',
        AWS_ENDPOINT_URL: 'http://localhost:4566',
      };
      const env = { ...prodVps, EMAIL_PROVIDER: 'off', ...leftovers };
      expect(loadEmailConfig(env)).toEqual({ provider: 'off', from: null });
      expect(loadSesClientConfig(env)).toBeNull();
    });

    it('still validates EMAIL_FROM_ADDRESS when it is set', () => {
      expect(() =>
        loadEmailConfig({ ...prodVps, EMAIL_PROVIDER: 'off', EMAIL_FROM_ADDRESS: 'nope' }),
      ).toThrow(/EMAIL_FROM_ADDRESS/);
      expect(
        loadEmailConfig({ ...prodVps, EMAIL_PROVIDER: 'off', EMAIL_FROM_ADDRESS: 'a@b.co' }),
      ).toEqual({ provider: 'off', from: null });
    });

    it('keeps fake refused on prod and EMAIL_FROM_ADDRESS required for ses and fake', () => {
      expect(() =>
        loadEmailConfig({ ...prodVps, EMAIL_PROVIDER: 'fake', EMAIL_FROM_ADDRESS: 'a@b.co' }),
      ).toThrow(/EMAIL_PROVIDER=fake on APP_STAGE=prod/);
      // Unset EMAIL_PROVIDER is `fake`, so prod must choose `ses` or `off` explicitly.
      expect(() => loadEmailConfig({ ...prodVps, EMAIL_FROM_ADDRESS: 'a@b.co' })).toThrow(
        /APP_STAGE=prod/,
      );
      for (const provider of ['ses', 'fake']) {
        expect(() => loadEmailConfig({ APP_STAGE: 'staging', EMAIL_PROVIDER: provider })).toThrow(
          /EMAIL_FROM_ADDRESS/,
        );
      }
    });
  });
});

describe('OffEmailProvider', () => {
  const message: EmailMessage<'grace_started'> = {
    to: 'photographer@example.com',
    template: 'grace_started',
    locale: 'th',
    params: { graceEndsAt: '2026-12-01T00:00:00Z', billingUrl: 'https://p.example.com/b' },
    idempotencyKey: 'notice:0190f0a0-0000-7000-8000-000000000001:grace',
  };

  it('drops the message and logs only its template', async () => {
    const logged: DroppedEmailLogEntry[] = [];
    const provider = new OffEmailProvider((entry) => logged.push(entry));
    await expect(provider.send(message)).resolves.toEqual({
      messageId: DROPPED_EMAIL_MESSAGE_ID,
      dropped: true,
    });
    expect(logged).toEqual([
      { event: 'email.dropped', provider: 'off', template: 'grace_started' },
    ]);
    const text = JSON.stringify(logged);
    for (const secret of [message.to, message.idempotencyKey, message.params.billingUrl]) {
      expect(text).not.toContain(secret);
    }
    expect(droppedEmailLogEntry(message)).toEqual(logged[0]);
  });

  it('never rejects, even when the logger throws', async () => {
    const provider = new OffEmailProvider(() => {
      throw new Error('logger down');
    });
    await expect(provider.send(message)).resolves.toMatchObject({ dropped: true });
  });
});

describe('email templates', () => {
  it('has Thai subject and body keys and a param schema for every template', () => {
    expect([...EMAIL_TEMPLATE_NAMES].sort()).toEqual(Object.keys(EMAIL_TEMPLATES).sort());
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(EMAIL_TEMPLATES[name].subjectKey).toMatch(/^email\.[a-zA-Z]+\.subject$/);
      expect(EMAIL_TEMPLATES[name].bodyKey).toMatch(/^email\.[a-zA-Z]+\.body$/);
    }
    expect(
      EMAIL_TEMPLATE_PARAMS.renewal_reminder.safeParse({
        planName: 'Standard',
        periodEnd: '2026-11-15T00:00:00Z',
        daysBefore: 7,
        autoRenew: false,
        renewalAmountSatang: null,
        billingUrl: 'https://photos.example.com/studio/billing',
        cardNumber: '4242',
      }).success,
    ).toBe(false);
  });
});

describe('billing routes and schemas', () => {
  it('requires an Idempotency-Key for checkout and verifies webhooks raw', () => {
    expect(BILLING_ROUTES.checkout.headers.safeParse({}).success).toBe(false);
    expect(BILLING_ROUTES.webhook).toMatchObject({ auth: 'webhook', rawBody: true, status: 200 });
    expect(BILLING_ROUTES.webhook.errors).toContain('WEBHOOK_SIGNATURE_INVALID');
    expect(BILLING_ROUTES.plans.auth).toBe('public');
    expect(ERROR_HTTP_STATUS).toMatchObject({
      PLAN_NOT_FOUND: 404,
      PLAN_CHANGE_INVALID: 409,
      CHECKOUT_PENDING: 409,
      CHECKOUT_EXPIRED: 410,
      WEBHOOK_SIGNATURE_INVALID: 401,
      PAYMENT_GATEWAY_ERROR: 502,
    });
  });

  it('validates checkout bodies', () => {
    expect(
      createCheckoutBodySchema.parse({
        planCode: 'pro',
        changeType: 'upgrade',
        payment: { method: 'promptpay' },
      }),
    ).toEqual({
      planCode: 'pro',
      changeType: 'upgrade',
      payment: { method: 'promptpay', months: null },
    });
    expect(
      createCheckoutBodySchema.safeParse({
        planCode: 'pro',
        changeType: 'new',
        payment: { method: 'card', months: 3 },
      }).success,
    ).toBe(false);
    expect(
      createCheckoutBodySchema.safeParse({
        planCode: 'pro',
        changeType: 'new',
        payment: { method: 'card', months: 1, cardNumber: '4242424242424242' },
      }).success,
    ).toBe(false);
  });

  it('describes checkout responses and plans', () => {
    const amount = splitVat(thb(390), 700);
    const response = {
      checkoutId: '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b',
      changeType: 'renew',
      plan: { code: 'standard', name: 'Standard', quotaBytes: 50 * GB },
      status: 'pending',
      amount,
      months: 1,
      proration: null,
      effectiveAt: '2026-10-26T00:00:00.000Z',
      paymentId: '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8c',
      action: {
        kind: 'promptpay',
        qrPayload: '00020101021229370016A000000677010111',
        qrImageDataUrl: null,
        expiresAt: '2026-10-26T00:15:00.000Z',
      },
      notices: [],
    };
    expect(checkoutResponseSchema.parse(response)).toEqual(response);
    expect(
      checkoutResponseSchema.safeParse({
        ...response,
        action: {
          kind: 'card_redirect',
          redirectUrl: 'http://x.example',
          expiresAt: response.effectiveAt,
        },
      }).success,
    ).toBe(false);
    expect(
      plansResponseSchema.parse({
        plans: [
          {
            code: 'starter',
            name: 'Starter',
            quotaBytes: 10 * GB,
            month: splitVat(thb(149), 700),
            year: splitVat(thb(1_490), 700),
            prepaid: [{ months: 1, amount: splitVat(thb(149), 700) }],
          },
        ],
        currency: 'THB',
        vatRateBasisPoints: 700,
        prepaidMonths: [1, 3, 6, 12],
        autoRenewMonths: [1, 12],
      }).plans,
    ).toHaveLength(1);
  });
});
