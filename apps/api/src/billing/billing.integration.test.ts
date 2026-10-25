import { randomUUID } from 'node:crypto';
import {
  checkoutSessions,
  paymentWebhookEvents,
  payments,
  plans,
  storageUsage,
  subscriptionEvents,
  subscriptions,
} from '@shotx/db';
import {
  addMonthsBangkok,
  apiPath,
  BILLING_ROUTES as B,
  checkoutResponseSchema,
  DRIVE_ROUTES,
  type FakeWebhookBody,
  paymentViewSchema,
  plansResponseSchema,
  subscriptionResponseSchema,
  UPLOAD_ROUTES,
} from '@shotx/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_WEBHOOK_ALERT_EVENT } from './webhook.service';
import { DATABASE_BACKENDS, type TestDatabase } from '../testing/database';
import { TestApi } from '../testing/harness';

const GB = 1024 ** 3;
const DAY = 86_400_000;
const CHECKOUT = apiPath(B.checkout);
const SUBSCRIPTION = apiPath(B.subscription);
const CANCEL = apiPath(B.cancelSubscription);
const payment = (id: string) => apiPath(B.payment, { id });

type Who = { id: string; token: string };

for (const backend of DATABASE_BACKENDS) {
  describe.skipIf(!backend.enabled)(`billing on ${backend.name}`, () => {
    let database: TestDatabase;
    let api: TestApi;

    beforeAll(async () => {
      database = await backend.open();
      api = await TestApi.start(database.db);
    }, 120_000);
    afterAll(async () => {
      await api?.close();
      await database?.close();
    });

    function checkout(who: Who, body: unknown, key: string | null = randomUUID()) {
      return api.request('POST', CHECKOUT, {
        token: who.token,
        body,
        headers: key === null ? {} : { 'idempotency-key': key },
      });
    }

    async function created(who: Who, body: unknown, key = randomUUID()) {
      const res = await checkout(who, body, key);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return checkoutResponseSchema.parse(res.body);
    }

    async function paymentRow(id: string) {
      const [row] = await api.db.select().from(payments).where(eq(payments.id, id));
      if (row === undefined) throw new Error('no payment');
      return row;
    }

    async function subscriptionOf(photographerId: string) {
      const res = await api.request('GET', SUBSCRIPTION, {
        token: (await tokenOf(photographerId)) ?? '',
      });
      return subscriptionResponseSchema.parse(res.body);
    }

    const tokens = new Map<string, string>();
    async function photographer(...args: Parameters<TestApi['photographerOn']>) {
      const p = await api.photographerOn(...args);
      tokens.set(p.id, p.token);
      return p;
    }
    function tokenOf(id: string): Promise<string | undefined> {
      return Promise.resolve(tokens.get(id));
    }

    function paidEvent(
      row: { gatewayRef: string; amountSatang: number },
      extra: Partial<FakeWebhookBody> = {},
    ): FakeWebhookBody {
      return {
        id: `evt_${randomUUID()}`,
        chargeId: row.gatewayRef,
        type: 'paid',
        amountSatang: row.amountSatang,
        currency: 'THB',
        occurredAt: api.clock.now().toISOString(),
        ...extra,
      };
    }

    async function pay(paymentId: string, extra: Partial<FakeWebhookBody> = {}) {
      const res = await api.webhook(paidEvent(await paymentRow(paymentId), extra));
      expect(res, JSON.stringify(res.body)).toMatchObject({
        status: 200,
        body: { received: true },
      });
      return res;
    }

    async function eventsOf(photographerId: string) {
      return api.db
        .select()
        .from(subscriptionEvents)
        .where(eq(subscriptionEvents.photographerId, photographerId))
        .orderBy(asc(subscriptionEvents.createdAt), asc(subscriptionEvents.id));
    }

    async function usage(who: Who) {
      return (await api.request('GET', apiPath(DRIVE_ROUTES.usage), { token: who.token })).body as {
        quotaBytes: number;
        uploadsBlockedBy: string | null;
      };
    }

    describe('GET /plans', () => {
      it('lists purchasable plans by quota with VAT split prices, publicly', async () => {
        const res = await api.request('GET', apiPath(B.plans));
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('public, max-age=60');
        const body = plansResponseSchema.parse(res.body);
        expect(body.plans.map((p) => p.code)).toEqual(['starter', 'standard', 'pro', 'studio']);
        expect(body).toMatchObject({
          currency: 'THB',
          vatRateBasisPoints: 700,
          prepaidMonths: [1, 3, 6, 12],
          autoRenewMonths: [1, 12],
        });
        const starter = body.plans[0];
        expect(starter?.month).toEqual({
          totalSatang: 14_900,
          vatSatang: 975,
          netSatang: 13_925,
          vatRateBasisPoints: 700,
        });
        expect(starter?.prepaid.map((p) => [p.months, p.amount.totalSatang])).toEqual([
          [1, 14_900],
          [3, 44_700],
          [6, 89_400],
          [12, 149_000],
        ]);
      });
    });

    describe('PromptPay', () => {
      it('runs checkout → paid webhook → active subscription, quota and receipt', async () => {
        const now = api.clock.now();
        const p = await photographer('trial', {
          status: 'trial',
          periodEnd: new Date(now.getTime() + 14 * DAY),
        });
        expect((await usage(p)).quotaBytes).toBe(2 * GB);
        const body = await created(p, {
          planCode: 'standard',
          changeType: 'new',
          payment: { method: 'promptpay', months: 3 },
        });
        expect(body).toMatchObject({
          changeType: 'new',
          status: 'pending',
          plan: { code: 'standard', quotaBytes: 50 * GB },
          amount: { totalSatang: 117_000, vatSatang: 7_654, netSatang: 109_346 },
          months: 3,
          proration: null,
          effectiveAt: now.toISOString(),
          notices: [],
        });
        expect(body.action).toMatchObject({ kind: 'promptpay', qrImageDataUrl: null });
        expect(body.action?.kind === 'promptpay' && body.action.qrPayload).toMatch(/^000201/);
        expect(body.paymentId).not.toBeNull();
        const paymentId = body.paymentId ?? '';

        const polled = paymentViewSchema.parse(
          (await api.request('GET', payment(paymentId), { token: p.token })).body,
        );
        expect(polled).toMatchObject({
          status: 'pending',
          method: 'promptpay',
          gateway: 'fake',
          kind: 'checkout',
          checkout: { status: 'pending', changeType: 'new', errorCode: null },
          action: { kind: 'promptpay' },
        });

        await pay(paymentId);
        const after = paymentViewSchema.parse(
          (await api.request('GET', payment(paymentId), { token: p.token })).body,
        );
        expect(after).toMatchObject({
          status: 'paid',
          paidAt: now.toISOString(),
          checkout: { status: 'completed' },
          action: null,
        });
        const sub = await subscriptionOf(p.id);
        expect(sub.subscription).toMatchObject({
          status: 'active',
          plan: { code: 'standard' },
          billing: 'prepaid',
          periodStart: now.toISOString(),
          periodEnd: addMonthsBangkok(now, 3).toISOString(),
          pendingChange: null,
          nextRenewal: null,
        });
        expect(await usage(p)).toMatchObject({ quotaBytes: 50 * GB, uploadsBlockedBy: null });
        expect((await eventsOf(p.id)).map((e) => [e.type, e.actor])).toEqual([
          ['activated', 'gateway'],
        ]);
        // Receipt: once, in Thai, with the VAT split.
        const receipts = api.email.sent.filter((m) => m.idempotencyKey === `receipt:${paymentId}`);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]?.template).toBe('payment_receipt');
        expect(receipts[0]?.subject).toContain('ใบเสร็จ');
        expect(receipts[0]?.text).toContain('1,170.00');
        expect(receipts[0]?.text).toContain('76.54');
        expect((await paymentRow(paymentId)).receiptSentAt).not.toBeNull();
      });

      it('applies a replayed or duplicated paid webhook once', async () => {
        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        });
        const row = await paymentRow(body.paymentId ?? '');
        const event = paidEvent(row);
        const before = (await subscriptionOf(p.id)).subscription?.periodEnd ?? '';
        for (let i = 0; i < 3; i++) {
          expect((await api.webhook(event)).status).toBe(200);
        }
        // Another event id for the same charge: the payment is no longer pending.
        expect((await api.webhook(paidEvent(row))).status).toBe(200);
        const after = (await subscriptionOf(p.id)).subscription?.periodEnd ?? '';
        expect(after).toBe(addMonthsBangkok(new Date(before), 1).toISOString());
        expect((await eventsOf(p.id)).map((e) => e.type)).toEqual(['renewed']);
        const stored = await api.db
          .select()
          .from(paymentWebhookEvents)
          .where(eq(paymentWebhookEvents.gatewayRef, row.gatewayRef));
        expect(stored).toHaveLength(2);
        expect(stored.every((e) => e.processedAt !== null && e.paymentId === row.id)).toBe(true);
        expect(stored.every((e) => /^[0-9a-f]{64}$/.test(e.payloadSha256))).toBe(true);
        expect(api.email.sent.filter((m) => m.idempotencyKey === `receipt:${row.id}`)).toHaveLength(
          1,
        );
      });

      it('survives concurrent deliveries without a double apply', async () => {
        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 3 },
        });
        const row = await paymentRow(body.paymentId ?? '');
        const before = (await subscriptionOf(p.id)).subscription?.periodEnd ?? '';
        const same = paidEvent(row);
        const results = await Promise.all([
          ...Array.from({ length: 5 }, () => api.webhook(same)),
          ...Array.from({ length: 3 }, () => api.webhook(paidEvent(row))),
        ]);
        expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
        expect((await subscriptionOf(p.id)).subscription?.periodEnd).toBe(
          addMonthsBangkok(new Date(before), 3).toISOString(),
        );
        expect((await eventsOf(p.id)).map((e) => e.type)).toEqual(['renewed']);
        expect((await paymentRow(row.id)).status).toBe('paid');
      });

      it('refuses bad signatures and stores nothing', async () => {
        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        });
        const row = await paymentRow(body.paymentId ?? '');
        const event = paidEvent(row);
        const invalid = { status: 401, body: { code: 'WEBHOOK_SIGNATURE_INVALID' } };
        expect(
          await api.webhook(event, { secret: 'another-secret-0123456789abcdef' }),
        ).toMatchObject(invalid);
        expect(
          await api.webhook(event, { signedAt: new Date(api.clock.now().getTime() - 600_000) }),
        ).toMatchObject(invalid);
        expect(await api.webhook(event, { header: 't=1,v1=00' })).toMatchObject(invalid);
        // Signed body A, sent body B.
        const header = (await api.webhook(event, { header: 'x' })).status;
        expect(header).toBe(401);
        const res = await api.request('POST', '/api/billing/webhooks/fake', {
          rawBody: JSON.stringify(event),
        });
        expect(res).toMatchObject(invalid);
        expect(
          await api.db
            .select()
            .from(paymentWebhookEvents)
            .where(eq(paymentWebhookEvents.eventRef, event.id)),
        ).toEqual([]);
        expect((await paymentRow(row.id)).status).toBe('pending');
        // Other gateways: NOT_FOUND (not configured) or VALIDATION_FAILED (unknown).
        expect(
          (await api.request('POST', '/api/billing/webhooks/omise', { rawBody: '{}' })).status,
        ).toBe(404);
        expect(
          (await api.request('POST', '/api/billing/webhooks/stripe', { rawBody: '{}' })).status,
        ).toBe(400);
        // A valid signature over a tampered body fails too.
        const signedFor = JSON.stringify(event);
        const okHeader = await (async () => {
          const { fakeWebhookSignatureHeader } = await import('@shotx/shared');
          return fakeWebhookSignatureHeader(
            'test-fake-webhook-secret-0123456789',
            Math.floor(api.clock.now().getTime() / 1000),
            new TextEncoder().encode(signedFor),
          );
        })();
        const tampered = await api.webhook(event, {
          raw: signedFor.replace(String(row.amountSatang), '1'),
          header: okHeader,
        });
        expect(tampered).toMatchObject(invalid);
      });

      it('stores unparseable, unknown and mismatched events with an alert, answering 200', async () => {
        const unparseable = await api.webhook({} as FakeWebhookBody, { raw: 'not json' });
        expect(unparseable.status).toBe(200);
        expect(api.events.of(BILLING_WEBHOOK_ALERT_EVENT).at(-1)).toMatchObject({
          errorCode: 'unparseable',
        });
        const unknown = paidEvent({ gatewayRef: 'chrg_nobody', amountSatang: 100 });
        expect((await api.webhook(unknown)).status).toBe(200);
        const [stored] = await api.db
          .select()
          .from(paymentWebhookEvents)
          .where(eq(paymentWebhookEvents.eventRef, unknown.id));
        expect(stored).toMatchObject({ errorCode: 'unknown_payment', processedAt: null });

        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        });
        const row = await paymentRow(body.paymentId ?? '');
        expect((await api.webhook(paidEvent(row, { amountSatang: 1 }))).status).toBe(200);
        expect((await paymentRow(row.id)).status).toBe('pending');
        expect(api.events.of(BILLING_WEBHOOK_ALERT_EVENT).at(-1)).toMatchObject({
          errorCode: 'amount_mismatch',
          paymentId: row.id,
        });
        // The webhook payload never reaches the logs.
        const text = `${api.logger.text()}${JSON.stringify(api.events.entries)}`;
        expect(text).not.toContain(row.gatewayRef);
        expect(text).not.toContain('not json');
      });

      it('replays the same Idempotency-Key, refuses reuse and a second pending checkout', async () => {
        const p = await photographer('starter');
        const request = {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 6 },
        };
        const key = randomUUID();
        const calls = api.gateway.calls.length;
        const first = await created(p, request, key);
        const replay = await created(p, request, key);
        expect(replay.checkoutId).toBe(first.checkoutId);
        expect(replay.paymentId).toBe(first.paymentId);
        expect(replay.action?.kind).toBe('promptpay');
        expect(api.gateway.calls.length).toBe(calls + 1);
        expect(
          await checkout(p, { ...request, payment: { method: 'promptpay', months: 3 } }, key),
        ).toMatchObject({ status: 422, body: { code: 'IDEMPOTENCY_KEY_REUSED' } });
        expect(await checkout(p, request)).toMatchObject({
          status: 409,
          body: {
            code: 'CHECKOUT_PENDING',
            details: { paymentId: first.paymentId },
          },
        });
        expect(await checkout(p, request, null)).toMatchObject({
          status: 400,
          body: { code: 'VALIDATION_FAILED' },
        });
        expect(await checkout(p, { ...request, planCode: 'trial' })).toMatchObject({
          status: 404,
          body: { code: 'PLAN_NOT_FOUND' },
        });
        expect(await checkout(p, { ...request, changeType: 'new' })).toMatchObject({
          status: 409,
          body: {
            code: 'PLAN_CHANGE_INVALID',
            details: { reason: 'change_type_mismatch', expectedChangeType: 'renew' },
          },
        });
        expect(
          await checkout(p, { ...request, payment: { method: 'promptpay', months: 5 } }),
        ).toMatchObject({ body: { details: { reason: 'months_not_offered' } } });
      });

      it('expires checkouts: CHECKOUT_EXPIRED for the key, a new key works, late payment applies', async () => {
        const p = await photographer('starter');
        const request = {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        };
        const key = randomUUID();
        const first = await created(p, request, key);
        api.clock.advance((api.config.billing.checkoutExpirySeconds + 1) * 1000);
        try {
          expect(
            paymentViewSchema.parse(
              (await api.request('GET', payment(first.paymentId ?? ''), { token: p.token })).body,
            ).action,
          ).toBeNull();
          expect(await checkout(p, request, key)).toMatchObject({
            status: 410,
            body: { code: 'CHECKOUT_EXPIRED' },
          });
          const before = (await subscriptionOf(p.id)).subscription?.periodEnd ?? '';
          // The QR was paid just before it expired; the webhook comes late: still applied.
          await pay(first.paymentId ?? '');
          const [session] = await api.db
            .select()
            .from(checkoutSessions)
            .where(eq(checkoutSessions.id, first.checkoutId));
          expect(session?.status).toBe('completed');
          expect((await subscriptionOf(p.id)).subscription?.periodEnd).toBe(
            addMonthsBangkok(new Date(before), 1).toISOString(),
          );
          expect((await checkout(p, request)).status).toBe(201);
        } finally {
          api.clock.advance(-(api.config.billing.checkoutExpirySeconds + 1) * 1000);
        }
      });

      it('records a late payment it can no longer apply for an admin refund', async () => {
        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        });
        // Meanwhile the account was purged: a renew no longer fits (it would be `new`).
        await api.db
          .update(subscriptions)
          .set({ status: 'purged' })
          .where(eq(subscriptions.photographerId, p.id));
        await pay(body.paymentId ?? '');
        expect((await paymentRow(body.paymentId ?? '')).status).toBe('paid');
        const view = paymentViewSchema.parse(
          (await api.request('GET', payment(body.paymentId ?? ''), { token: p.token })).body,
        );
        expect(view.checkout).toMatchObject({ status: 'failed', errorCode: 'PLAN_CHANGE_INVALID' });
        expect((await eventsOf(p.id)).map((e) => e.type)).toEqual(['payment_unapplied']);
        expect(api.events.of(BILLING_WEBHOOK_ALERT_EVENT).at(-1)).toMatchObject({
          errorCode: 'payment_unapplied',
        });
        expect((await subscriptionOf(p.id)).subscription?.status).toBe('purged');
      });

      it('starts a new subscription row after purge', async () => {
        const p = await photographer('starter', { status: 'purged' });
        const body = await created(p, {
          planCode: 'pro',
          changeType: 'new',
          payment: { method: 'promptpay', months: 12 },
        });
        expect(body.amount.totalSatang).toBe(990_000);
        await pay(body.paymentId ?? '');
        const rows = await api.db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.photographerId, p.id));
        expect(rows.map((r) => r.status).sort()).toEqual(['active', 'purged']);
        expect((await eventsOf(p.id)).map((e) => e.type)).toEqual(['created']);
        expect((await usage(p)).quotaBytes).toBe(200 * GB);
      });

      it('marks failed and expired payments, then allows a new checkout', async () => {
        const p = await photographer('starter');
        const request = {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        };
        const first = await created(p, request);
        const row = await paymentRow(first.paymentId ?? '');
        expect(
          (await api.webhook(paidEvent(row, { type: 'failed', failureCode: 'declined' }))).status,
        ).toBe(200);
        expect(await paymentRow(row.id)).toMatchObject({
          status: 'failed',
          failureCode: 'declined',
        });
        const view = paymentViewSchema.parse(
          (await api.request('GET', payment(row.id), { token: p.token })).body,
        );
        expect(view.checkout).toMatchObject({
          status: 'failed',
          errorCode: 'PAYMENT_GATEWAY_ERROR',
        });
        const second = await created(p, request);
        const row2 = await paymentRow(second.paymentId ?? '');
        await api.webhook(paidEvent(row2, { type: 'expired' }));
        expect((await paymentRow(row2.id)).status).toBe('expired');
        expect((await checkout(p, request)).status).toBe(201);
        expect(await eventsOf(p.id)).toEqual([]);
      });

      it('records refunds without changing the subscription', async () => {
        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        });
        await pay(body.paymentId ?? '');
        const before = await subscriptionOf(p.id);
        const row = await paymentRow(body.paymentId ?? '');
        await api.webhook(paidEvent(row, { type: 'refunded' }));
        expect((await paymentRow(row.id)).status).toBe('refunded');
        expect(await subscriptionOf(p.id)).toEqual(before);
        expect((await eventsOf(p.id)).map((e) => e.type)).toEqual(['renewed', 'payment_refunded']);
      });

      it('answers PAYMENT_GATEWAY_ERROR when the gateway fails, and heals on retry', async () => {
        const p = await photographer('starter');
        const request = {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        };
        const key = randomUUID();
        api.gateway.failNext('createCheckout');
        expect(await checkout(p, request, key)).toMatchObject({
          status: 502,
          body: { code: 'PAYMENT_GATEWAY_ERROR' },
        });
        expect(await checkout(p, request)).toMatchObject({
          status: 409,
          body: { code: 'CHECKOUT_PENDING', details: { paymentId: null } },
        });
        const healed = await created(p, request, key);
        expect(healed.paymentId).not.toBeNull();
        expect(healed.action?.kind).toBe('promptpay');
      });

      it('keeps the webhook 200 when the receipt cannot be sent', async () => {
        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        });
        api.email.failNext = true;
        await pay(body.paymentId ?? '');
        expect((await paymentRow(body.paymentId ?? '')).receiptSentAt).toBeNull();
        expect(api.logger.text()).toContain('payment receipt not sent');
      });
    });

    describe('plan changes', () => {
      it('prorates an upgrade and raises the quota at once when paid', async () => {
        const now = api.clock.now();
        const periodEnd = new Date(now.getTime() + 15 * DAY);
        const p = await photographer('starter', { periodEnd });
        const body = await created(p, {
          planCode: 'pro',
          changeType: 'upgrade',
          payment: { method: 'promptpay', months: null },
        });
        // (990 − 149) THB × 15 / 30 days.
        expect(body).toMatchObject({
          changeType: 'upgrade',
          status: 'pending',
          months: null,
          proration: { remainingDays: 15, amountSatang: 42_050 },
          amount: { totalSatang: 42_050 },
          effectiveAt: now.toISOString(),
        });
        expect((await usage(p)).quotaBytes).toBe(10 * GB);
        await pay(body.paymentId ?? '');
        expect((await usage(p)).quotaBytes).toBe(200 * GB);
        const sub = await subscriptionOf(p.id);
        expect(sub.subscription).toMatchObject({
          plan: { code: 'pro' },
          periodEnd: periodEnd.toISOString(),
        });
        expect((await eventsOf(p.id)).map((e) => e.type)).toEqual(['upgraded']);
      });

      it('waives a tiny proration and applies the upgrade without a payment', async () => {
        const p = await photographer('starter', {
          periodEnd: new Date(api.clock.now().getTime() + DAY / 2),
        });
        const calls = api.gateway.calls.length;
        const body = await created(p, {
          planCode: 'standard',
          changeType: 'upgrade',
          payment: { method: 'promptpay', months: null },
        });
        expect(body).toMatchObject({
          status: 'completed',
          proration: { remainingDays: 1, amountSatang: 803 },
          amount: { totalSatang: 0, vatSatang: 0, netSatang: 0 },
          paymentId: null,
          action: null,
        });
        expect(api.gateway.calls.length).toBe(calls);
        expect((await usage(p)).quotaBytes).toBe(50 * GB);
        expect((await eventsOf(p.id)).map((e) => [e.type, e.actor, e.actorUserId])).toEqual([
          ['upgraded', 'photographer', p.id],
        ]);
      });

      it('schedules a downgrade at period end, with the over-quota notice; uploads blocked later', async () => {
        const now = api.clock.now();
        const periodEnd = new Date(now.getTime() + 20 * DAY);
        const p = await photographer('pro', { periodEnd });
        await api.db
          .insert(storageUsage)
          .values({ photographerId: p.id, usedBytes: 60 * GB, reservedBytes: 0 });
        const body = await created(p, {
          planCode: 'standard',
          changeType: 'downgrade',
          payment: { method: 'promptpay', months: 1 },
        });
        expect(body).toMatchObject({
          amount: { totalSatang: 39_000 },
          effectiveAt: periodEnd.toISOString(),
          notices: [
            {
              code: 'DOWNGRADE_EXCEEDS_QUOTA',
              details: { quotaBytes: 50 * GB, usedBytes: 60 * GB, overBytes: 10 * GB },
            },
          ],
        });
        await pay(body.paymentId ?? '');
        const sub = await subscriptionOf(p.id);
        expect(sub.subscription).toMatchObject({
          plan: { code: 'pro' },
          periodEnd: addMonthsBangkok(periodEnd, 1).toISOString(),
          pendingChange: { plan: { code: 'standard' }, effectiveAt: periodEnd.toISOString() },
        });
        expect(sub.notices).toHaveLength(1);
        // Until the period ends the bigger quota applies.
        expect(await usage(p)).toMatchObject({ quotaBytes: 200 * GB, uploadsBlockedBy: null });
        // No other change while a downgrade is pending.
        expect(
          await checkout(p, {
            planCode: 'studio',
            changeType: 'upgrade',
            payment: { method: 'promptpay', months: null },
          }),
        ).toMatchObject({ body: { details: { reason: 'pending_change_exists' } } });
        const [event] = await eventsOf(p.id);
        expect(event).toMatchObject({ type: 'downgrade_scheduled' });
        // The daily job applies it (worker); files stay, uploads are blocked until they fit.
        const [standard] = await api.db.select().from(plans).where(eq(plans.code, 'standard'));
        await api.db
          .update(subscriptions)
          .set({ planId: standard?.id ?? '', pendingPlanId: null, pendingPlanEffectiveAt: null })
          .where(eq(subscriptions.photographerId, p.id));
        expect(await usage(p)).toMatchObject({
          quotaBytes: 50 * GB,
          uploadsBlockedBy: 'QUOTA_EXCEEDED',
        });
        const init = await api.request('POST', apiPath(UPLOAD_ROUTES.init), {
          token: p.token,
          body: { folderId: null, name: 'a.jpg', mime: 'image/jpeg', size: 1000 },
        });
        expect(init.body).toMatchObject({ code: 'QUOTA_EXCEEDED' });
      });
    });

    describe('cards', () => {
      it('collects a card on the hosted page, then auto-renews with the saved method', async () => {
        const p = await photographer('trial', { status: 'trial' });
        const body = await created(p, {
          planCode: 'standard',
          changeType: 'new',
          payment: { method: 'card', months: 1 },
        });
        expect(body.action).toMatchObject({ kind: 'card_redirect' });
        const url = new URL(body.action?.kind === 'card_redirect' ? body.action.redirectUrl : '');
        expect(url.protocol).toBe('https:');
        expect(url.searchParams.get('return')).toContain('/studio/billing/return');
        // A paid card event without the saved method can't set up auto-renew: alert, not applied.
        const row = await paymentRow(body.paymentId ?? '');
        await api.webhook(paidEvent(row));
        expect(api.events.of(BILLING_WEBHOOK_ALERT_EVENT).at(-1)).toMatchObject({
          errorCode: 'missing_payment_method',
        });
        expect((await paymentRow(row.id)).status).toBe('pending');
        await pay(row.id, { paymentMethodRef: 'card_tok_123' });
        const sub = await subscriptionOf(p.id);
        expect(sub.subscription).toMatchObject({
          status: 'active',
          billing: 'auto_renew',
          autoRenewMonths: 1,
          nextRenewal: { plan: { code: 'standard' }, months: 1, amount: { totalSatang: 39_000 } },
        });
        const [stored] = await api.db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.photographerId, p.id));
        expect(stored).toMatchObject({
          paymentMethodGateway: 'fake',
          paymentMethodRef: 'card_tok_123',
        });
        expect((await eventsOf(p.id)).map((e) => e.type)).toEqual([
          'activated',
          'auto_renew_enabled',
        ]);
        // A card renew while auto-renew is on is refused.
        expect(
          await checkout(p, {
            planCode: 'standard',
            changeType: 'renew',
            payment: { method: 'card', months: 1 },
          }),
        ).toMatchObject({ body: { details: { reason: 'auto_renew_active' } } });
      });

      it('downgrades an auto-renew subscription for free at period end', async () => {
        const periodEnd = new Date(api.clock.now().getTime() + 10 * DAY);
        const p = await photographer('pro', { periodEnd, card: { ref: 'card_x', months: 12 } });
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'downgrade',
          payment: { method: 'card', months: 1 },
        });
        expect(body).toMatchObject({
          status: 'completed',
          paymentId: null,
          amount: { totalSatang: 0 },
          effectiveAt: periodEnd.toISOString(),
        });
        const sub = await subscriptionOf(p.id);
        expect(sub.subscription).toMatchObject({
          plan: { code: 'pro' },
          periodEnd: periodEnd.toISOString(),
          autoRenewMonths: 1,
          pendingChange: { plan: { code: 'starter' } },
          // The next charge is the smaller plan.
          nextRenewal: { plan: { code: 'starter' }, amount: { totalSatang: 14_900 } },
        });
        // A card downgrade of a prepaid subscription is refused.
        const prepaid = await photographer('pro');
        expect(
          await checkout(prepaid, {
            planCode: 'starter',
            changeType: 'downgrade',
            payment: { method: 'card', months: 1 },
          }),
        ).toMatchObject({ body: { details: { reason: 'card_downgrade_needs_auto_renew' } } });
      });

      it('cancels auto-renew at the gateway, idempotently', async () => {
        const p = await photographer('standard', { card: { ref: 'card_cancel_me', months: 1 } });
        api.gateway.failNext('cancelAutoRenew');
        expect(await api.request('POST', CANCEL, { token: p.token })).toMatchObject({
          status: 502,
          body: { code: 'PAYMENT_GATEWAY_ERROR' },
        });
        expect((await subscriptionOf(p.id)).subscription?.billing).toBe('auto_renew');
        const res = await api.request('POST', CANCEL, { token: p.token });
        expect(res.status).toBe(200);
        expect(subscriptionResponseSchema.parse(res.body).subscription).toMatchObject({
          billing: 'prepaid',
          autoRenewMonths: null,
          cancelAtPeriodEnd: true,
          nextRenewal: null,
          status: 'active',
        });
        expect(api.gateway.canceled).toContain('card_cancel_me');
        const calls = api.gateway.calls.length;
        expect((await api.request('POST', CANCEL, { token: p.token })).status).toBe(200);
        expect(api.gateway.calls.length).toBe(calls);
        expect((await eventsOf(p.id)).map((e) => [e.type, e.actor])).toEqual([
          ['auto_renew_canceled', 'photographer'],
        ]);
        const [row] = await api.db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.photographerId, p.id));
        expect(row).toMatchObject({ paymentMethodRef: null, paymentMethodGateway: null });
        const none = await photographer('starter', { noSubscription: true });
        expect((await api.request('POST', CANCEL, { token: none.token })).status).toBe(404);
      });
    });

    describe('ownership and auth', () => {
      it('hides other photographers’ payments and needs a photographer token', async () => {
        const p = await photographer('starter');
        const body = await created(p, {
          planCode: 'starter',
          changeType: 'renew',
          payment: { method: 'promptpay', months: 1 },
        });
        const other = await photographer('starter');
        expect(
          (await api.request('GET', payment(body.paymentId ?? ''), { token: other.token })).status,
        ).toBe(404);
        expect((await api.request('GET', payment(body.paymentId ?? ''))).status).toBe(401);
        expect((await api.request('GET', SUBSCRIPTION)).status).toBe(401);
        const viewer = await api.viewer();
        expect(
          (
            await api.request('POST', CHECKOUT, {
              token: viewer.token,
              body: {},
              headers: { 'idempotency-key': 'k' },
            })
          ).status,
        ).toBe(403);
        const none = await photographer('starter', { noSubscription: true });
        expect(
          subscriptionResponseSchema.parse(
            (await api.request('GET', SUBSCRIPTION, { token: none.token })).body,
          ),
        ).toEqual({ subscription: null, notices: [] });
        // A checkout row is never visible across photographers either.
        expect(
          await api.db
            .select()
            .from(checkoutSessions)
            .where(
              and(
                eq(checkoutSessions.id, body.checkoutId),
                eq(checkoutSessions.photographerId, other.id),
              ),
            ),
        ).toEqual([]);
      });
    });
  });
}
