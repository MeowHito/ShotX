import { TEST_DESTINATIONS, testJobQueues } from '../../testing/jobs';
import { randomUUID } from 'node:crypto';
import {
  consents,
  faces,
  files,
  folders,
  payments,
  shares,
  storageUsage,
  subscriptionEvents,
  subscriptionNotices,
  subscriptions,
} from '@shotx/db';
import { faceCollectionId } from '@shotx/face';
import { FakeFaceProvider, SyntheticWorld } from '@shotx/face/testing';
import {
  derivedKeys,
  derivedPrefix,
  ErrorCode,
  originalKey,
  originalsPrefix,
  splitVat,
  uploadsBlockedBy,
} from '@shotx/shared';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FakeEmailProvider } from '../../billing/email';
import type { FakeRenewalGateway } from '../../billing/gateway';
import type { Db } from '../../db';
import { memoryLogger, silentLogger } from '../../logger';
import type { MessageContext } from '../../sqs/consumer';
import {
  createBillingPhotographer,
  createPayment,
  createSubscription,
  type PlanCode,
  planIds,
  subscriptionById,
  testSubscriptionDeps,
} from '../../testing/billing';
import {
  createFileRow,
  createFolder,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../../testing/database';
import { MemoryObjectStore, MemoryQueueClient } from '../../testing/memory-aws';
import type { JobContext } from '../context';
import { createJobsHandler } from '../handler';
import { MemoryJobRunLedger } from '../ledger';
import { S3OrphanScanStore } from '../orphan-scans';
import type { SubscriptionJobDeps } from './common';
import { purgeAccount } from './purge';
import { runSubscriptionTransitions } from './run';

const DAY = 86_400_000;
const GB = 1024 ** 3;
/** A Bangkok wall-clock time (UTC+7) as an instant. */
const bkk = (y: number, mo: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, mo - 1, d, h - 7, mi));
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

interface Env {
  db: Db;
  store: MemoryObjectStore;
  provider: FakeFaceProvider;
  deps: SubscriptionJobDeps & { gateway: FakeRenewalGateway; email: FakeEmailProvider };
  plan: Record<PlanCode, string>;
}

function context(env: Env, overrides: Partial<JobContext> = {}): JobContext {
  return {
    db: env.db,
    store: env.store,
    queues: new MemoryQueueClient(),
    destinations: { ...TEST_DESTINATIONS },
    faces: env.provider,
    log: silentLogger,
    now: Date.now,
    batchSize: 2,
    deadline: Date.now() + 3_600_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function run(env: Env, at: Date, overrides: Partial<JobContext> = {}) {
  return runSubscriptionTransitions(context(env, overrides), env.deps, { at });
}

async function eventsOf(db: Db, subscriptionId: string) {
  return db
    .select()
    .from(subscriptionEvents)
    .where(eq(subscriptionEvents.subscriptionId, subscriptionId))
    .orderBy(asc(subscriptionEvents.createdAt));
}

async function noticesOf(db: Db, subscriptionId: string) {
  return db
    .select({
      kind: subscriptionNotices.kind,
      daysBefore: subscriptionNotices.daysBefore,
      periodEnd: subscriptionNotices.periodEnd,
    })
    .from(subscriptionNotices)
    .where(eq(subscriptionNotices.subscriptionId, subscriptionId));
}

async function paymentsOf(db: Db, subscriptionId: string) {
  return db
    .select()
    .from(payments)
    .where(eq(payments.subscriptionId, subscriptionId))
    .orderBy(asc(payments.createdAt));
}

describe('subscriptions.transition.daily', () => {
  let database: TestDatabase;
  let env: Env;

  beforeEach(async () => {
    database = await openTestDatabase();
    const deps = testSubscriptionDeps();
    env = {
      db: database.db,
      store: new MemoryObjectStore(),
      provider: new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] })),
      deps: { ...deps, faces: undefined as never },
      plan: await planIds(database.db),
    };
    env.deps.faces = env.provider;
  });
  afterEach(async () => {
    await database.close();
  });

  describe('transitions at the Bangkok clock edges', () => {
    it('trial → grace exactly at period_end (Bangkok midnight), with the grace email', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2026, 12, 1); // 2026-11-30T17:00:00Z
      expect(periodEnd.toISOString()).toBe('2026-11-30T17:00:00.000Z');
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.trial,
        status: 'trial',
        periodEnd,
      });

      await run(env, plus(periodEnd, -1));
      expect((await subscriptionById(env.db, id)).status).toBe('trial');
      expect(env.deps.email.of('grace_started')).toHaveLength(0);

      const result = await run(env, periodEnd);
      expect(result.graceStarted).toBe(1);
      const sub = await subscriptionById(env.db, id);
      expect(sub.status).toBe('grace');
      expect(sub.updatedAt.toISOString()).toBe(periodEnd.toISOString());
      const events = await eventsOf(env.db, id);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'grace_started',
          actor: 'system',
          fromStatus: 'trial',
          toStatus: 'grace',
          toPlanId: env.plan.trial,
        }),
      ]);
      const [grace] = env.deps.email.of('grace_started');
      expect(grace?.message.params).toEqual({
        graceEndsAt: plus(periodEnd, 14 * DAY).toISOString(),
        billingUrl: 'https://shotx.example/studio/billing',
      });
      expect(grace?.message.locale).toBe('th');
      expect(grace?.rendered.text).toContain('15 ธันวาคม 2569 เวลา 00:00 น.');
      // Uploads are blocked in grace; shares still serve (subscriptionServesShares).
      expect(
        uploadsBlockedBy('grace', { quotaBytes: 2 * GB, usedBytes: 0, reservedBytes: 0 }),
      ).toBe(ErrorCode.SUBSCRIPTION_INACTIVE);
    });

    it('active → grace → expired after SUBSCRIPTION_GRACE_DAYS, with the expired email', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 1, 15, 9, 30);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.standard,
        status: 'active',
        periodEnd,
      });
      await run(env, plus(periodEnd, 1));
      expect((await subscriptionById(env.db, id)).status).toBe('grace');

      const expiresAt = plus(periodEnd, 14 * DAY);
      await run(env, plus(expiresAt, -1));
      expect((await subscriptionById(env.db, id)).status).toBe('grace');
      const result = await run(env, expiresAt);
      expect(result.expired).toBe(1);
      expect((await subscriptionById(env.db, id)).status).toBe('expired');
      expect((await eventsOf(env.db, id)).map((e) => e.type)).toEqual(['grace_started', 'expired']);
      const [expired] = env.deps.email.of('subscription_expired');
      expect(expired?.message.params.purgeAt).toBe(plus(expiresAt, 45 * DAY).toISOString());
      // One email per notice, logged once each.
      expect((await noticesOf(env.db, id)).map((n) => n.kind).sort()).toEqual([
        'expired',
        'grace_started',
      ]);
    });

    it('catches up after missed runs: active long past period_end steps to expired in one run', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 3, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.starter,
        status: 'active',
        periodEnd,
      });
      const result = await run(env, plus(periodEnd, 20 * DAY));
      expect(result).toMatchObject({ graceStarted: 1, expired: 1 });
      const events = await eventsOf(env.db, id);
      expect(events.map((e) => [e.fromStatus, e.toStatus])).toEqual(
        expect.arrayContaining([
          ['active', 'grace'],
          ['grace', 'expired'],
        ]),
      );
      // Only the email of the state it ends in; the skipped grace email is not sent late.
      expect(env.deps.email.of('grace_started')).toHaveLength(0);
      expect(env.deps.email.of('subscription_expired')).toHaveLength(1);
    });

    it('sends the purge warning once from purge_at − SUBSCRIPTION_PURGE_WARNING_DAYS', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2026, 6, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.starter,
        status: 'expired',
        periodEnd,
      });
      const purgeAt = plus(periodEnd, (14 + 45) * DAY);
      const warnAt = plus(purgeAt, -7 * DAY);
      await run(env, plus(warnAt, -1));
      expect(env.deps.email.of('purge_warning')).toHaveLength(0);
      await run(env, warnAt);
      await run(env, plus(warnAt, DAY));
      expect(env.deps.email.of('purge_warning')).toHaveLength(1);
      expect(env.deps.email.of('purge_warning')[0]?.message.params.purgeAt).toBe(
        purgeAt.toISOString(),
      );
      expect(env.deps.email.duplicates).toHaveLength(0);
      expect((await subscriptionById(env.db, id)).status).toBe('expired');
    });

    it('keeps every other subscription untouched (nothing due)', async () => {
      const owner = await createBillingPhotographer(env.db);
      const at = bkk(2026, 11, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.pro,
        status: 'active',
        periodEnd: plus(at, 60 * DAY),
      });
      const result = await run(env, at);
      expect(result.examined).toBe(0);
      expect(await eventsOf(env.db, id)).toHaveLength(0);
    });
  });

  describe('renewal reminders', () => {
    it('T-14, T-7, T-1, each once across reruns; a missed one is never sent late', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 2, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.standard,
        status: 'active',
        periodEnd,
      });
      await run(env, plus(periodEnd, -14 * DAY - 1));
      expect(env.deps.email.of('renewal_reminder')).toHaveLength(0);
      await run(env, plus(periodEnd, -14 * DAY));
      await run(env, plus(periodEnd, -14 * DAY));
      await run(env, plus(periodEnd, -13 * DAY));
      expect(env.deps.email.of('renewal_reminder').map((s) => s.message.params.daysBefore)).toEqual(
        [14],
      );
      // T-7 missed (no run that week): the T-1 run sends only T-1.
      await run(env, plus(periodEnd, -1 * DAY));
      await run(env, plus(periodEnd, -1 * DAY + 3_600_000));
      const sent = env.deps.email.of('renewal_reminder');
      expect(sent.map((s) => s.message.params.daysBefore)).toEqual([14, 1]);
      expect(sent[1]?.message.params).toMatchObject({
        planName: 'Standard',
        autoRenew: false,
        renewalAmountSatang: null,
        periodEnd: periodEnd.toISOString(),
      });
      expect(sent[1]?.message.idempotencyKey).toBe(
        `notice:${id}:renewal_reminder:${periodEnd.toISOString()}:1`,
      );
      expect((await noticesOf(env.db, id)).map((n) => n.daysBefore).sort()).toEqual([1, 14]);
      expect(env.deps.email.duplicates).toHaveLength(0);
    });

    it('retries a failed send on the next run (the notice row is removed again)', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 2, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.trial,
        status: 'trial',
        periodEnd,
      });
      env.deps.email.failNext();
      const first = await run(env, plus(periodEnd, -7 * DAY));
      expect(first.noticeFailures).toBe(1);
      expect(await noticesOf(env.db, id)).toHaveLength(0);
      const second = await run(env, plus(periodEnd, -7 * DAY + 60_000));
      expect(second.noticesSent).toBe(1);
      expect(env.deps.email.of('renewal_reminder')).toHaveLength(1);
      expect(await noticesOf(env.db, id)).toHaveLength(1);
    });

    it('skips photographers without an email address and logs nothing for them', async () => {
      const owner = await createBillingPhotographer(env.db, { email: null });
      const periodEnd = bkk(2027, 2, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.starter,
        status: 'active',
        periodEnd,
      });
      const result = await run(env, plus(periodEnd, -DAY));
      expect(result.noticesSkippedNoEmail).toBe(1);
      expect(await noticesOf(env.db, id)).toHaveLength(0);
    });
  });

  describe('auto-renew', () => {
    it('charges the saved card in the lead window: new period, payment and event together, then one receipt', async () => {
      const owner = await createBillingPhotographer(env.db);
      // Jan 31 00:00 Bangkok + 1 month clamps to Feb 28 00:00 Bangkok (Bangkok wall clock).
      const periodEnd = bkk(2027, 1, 31);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.standard,
        status: 'active',
        periodEnd,
        autoRenew: { months: 1, ref: 'card_saved_1' },
      });
      const at = bkk(2027, 1, 30, 0, 30);
      const result = await run(env, at);
      expect(result).toMatchObject({ renewalsCharged: 1, renewalsPaid: 1, receiptsSent: 1 });

      expect(env.deps.gateway.calls).toEqual([
        {
          idempotencyKey: `renewal:${id}:${periodEnd.toISOString()}:1`,
          paymentMethodRef: 'card_saved_1',
          amountSatang: 39_000,
          currency: 'THB',
          description: 'Snap standard 1 month renewal',
        },
      ]);
      const sub = await subscriptionById(env.db, id);
      expect(sub.status).toBe('active');
      expect(sub.periodEnd.toISOString()).toBe(bkk(2027, 2, 28).toISOString());
      expect(sub.periodEnd.toISOString()).toBe('2027-02-27T17:00:00.000Z');

      const [payment] = await paymentsOf(env.db, id);
      expect(payment).toMatchObject({
        photographerId: owner,
        status: 'paid',
        method: 'card',
        gateway: 'fake',
        amountSatang: 39_000,
        vatSatang: splitVat(39_000, 700).vatSatang,
        checkoutId: null,
      });
      expect(payment?.renewalPeriodEnd?.toISOString()).toBe(periodEnd.toISOString());
      expect(payment?.paidAt?.toISOString()).toBe(at.toISOString());
      expect(payment?.receiptSentAt).not.toBeNull();
      const events = await eventsOf(env.db, id);
      expect(events).toEqual([
        expect.objectContaining({ type: 'renewed', paymentId: payment!.id, toStatus: 'active' }),
      ]);
      // The renewal moved period_end, so the T-1 reminder of the old period is not sent.
      expect(env.deps.email.of('renewal_reminder')).toHaveLength(0);
      const [receipt] = env.deps.email.of('payment_receipt');
      expect(receipt?.message.params).toMatchObject({
        paymentId: payment!.id,
        planName: 'Standard',
        changeType: null,
        method: 'card',
        totalSatang: 39_000,
        netSatang: 39_000 - splitVat(39_000, 700).vatSatang,
        periodEnd: '2027-02-27T17:00:00.000Z',
      });
      expect(receipt?.rendered.text).toContain('390.00 บาท');

      // Reruns charge nothing more and send no second receipt.
      await run(env, at);
      await run(env, plus(at, 3_600_000));
      expect(env.deps.gateway.calls).toHaveLength(1);
      expect(env.deps.email.of('payment_receipt')).toHaveLength(1);
      expect(await paymentsOf(env.db, id)).toHaveLength(1);
      expect(await eventsOf(env.db, id)).toHaveLength(1);
    });

    it('a failed charge leads to grace with an email, is retried during grace, and renews from period_end', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 4, 10);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.pro,
        status: 'active',
        periodEnd,
        autoRenew: { months: 12 },
      });
      env.deps.gateway.next(
        { status: 'failed', failureCode: 'insufficient_fund' },
        { status: 'failed' },
        { status: 'paid' },
      );

      // Day before: attempt 1 fails, still active.
      await run(env, plus(periodEnd, -DAY + 60_000));
      expect((await subscriptionById(env.db, id)).status).toBe('active');
      // Period end: attempt 2 fails → grace, grace email.
      await run(env, plus(periodEnd, 60_000));
      expect((await subscriptionById(env.db, id)).status).toBe('grace');
      expect(env.deps.email.of('grace_started')).toHaveLength(1);
      // Next day in grace: attempt 3 succeeds → active again, a year from the old period_end.
      await run(env, plus(periodEnd, DAY));
      const sub = await subscriptionById(env.db, id);
      expect(sub.status).toBe('active');
      expect(sub.periodEnd.toISOString()).toBe(bkk(2028, 4, 10).toISOString());

      expect(env.deps.gateway.calls.map((c) => c.idempotencyKey)).toEqual(
        [1, 2, 3].map((n) => `renewal:${id}:${periodEnd.toISOString()}:${n}`),
      );
      expect(env.deps.gateway.calls[0]?.amountSatang).toBe(990_000);
      const rows = await paymentsOf(env.db, id);
      expect(rows.map((p) => [p.status, p.failureCode])).toEqual([
        ['failed', 'insufficient_fund'],
        ['failed', 'insufficient_fund'],
        ['paid', null],
      ]);
      expect((await eventsOf(env.db, id)).map((e) => e.type)).toEqual([
        'renewal_failed',
        'renewal_failed',
        'grace_started',
        'renewed',
      ]);
      expect(env.deps.email.of('payment_receipt')).toHaveLength(1);
    });

    it('stops after BILLING_RENEWAL_MAX_ATTEMPTS failures and expires after grace', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 5, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.starter,
        status: 'active',
        periodEnd,
        autoRenew: { months: 1 },
      });
      env.deps.gateway.defaultStatus = 'failed';
      for (let day = 0; day <= 14; day++) await run(env, plus(periodEnd, day * DAY));
      expect(env.deps.gateway.calls).toHaveLength(3);
      expect((await subscriptionById(env.db, id)).status).toBe('expired');
      expect(env.deps.email.of('payment_receipt')).toHaveLength(0);
    });

    it('defers grace while a fresh charge is pending; the webhook decides, no second charge', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 6, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.standard,
        status: 'active',
        periodEnd,
        autoRenew: { months: 1 },
      });
      env.deps.gateway.defaultStatus = 'pending';
      const at = plus(periodEnd, 60_000);
      const result = await run(env, at);
      expect(result.renewalsPending).toBe(1);
      expect((await subscriptionById(env.db, id)).status).toBe('active');
      expect(env.deps.email.of('grace_started')).toHaveLength(0);
      // Still pending a day later: grace starts, and the open charge is not repeated.
      await run(env, plus(at, DAY));
      expect((await subscriptionById(env.db, id)).status).toBe('grace');
      expect(env.deps.gateway.calls).toHaveLength(1);
      expect((await paymentsOf(env.db, id)).map((p) => p.status)).toEqual(['pending']);
    });

    it('heals a lost gateway response: the retry reuses the idempotency key and records one payment', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 7, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.standard,
        status: 'active',
        periodEnd,
        autoRenew: { months: 1 },
      });
      env.deps.gateway.next({ lostResponse: 'paid' });
      const first = await run(env, plus(periodEnd, -3_600_000));
      expect(first.renewalErrors).toBe(1);
      expect(await paymentsOf(env.db, id)).toHaveLength(0);
      await run(env, plus(periodEnd, -1_800_000));
      expect(env.deps.gateway.charges.size).toBe(1);
      const key = `renewal:${id}:${periodEnd.toISOString()}:1`;
      expect(env.deps.gateway.calls.map((c) => c.idempotencyKey)).toEqual([key, key]);
      expect((await paymentsOf(env.db, id)).map((p) => p.status)).toEqual(['paid']);
      expect((await subscriptionById(env.db, id)).periodEnd.toISOString()).toBe(
        bkk(2027, 8, 1).toISOString(),
      );
    });

    it('charges the pending downgrade plan when it applies at period_end', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 8, 20);
      await createSubscription(env.db, owner, {
        planId: env.plan.pro,
        status: 'active',
        periodEnd,
        autoRenew: { months: 1 },
        pendingPlanId: env.plan.starter,
      });
      await run(env, plus(periodEnd, -DAY));
      expect(env.deps.gateway.calls[0]?.amountSatang).toBe(14_900);
    });

    it('skips a saved method of another gateway', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 9, 1);
      await createSubscription(env.db, owner, {
        planId: env.plan.pro,
        status: 'active',
        periodEnd,
        autoRenew: { months: 1, gateway: 'omise' },
      });
      const result = await run(env, plus(periodEnd, -DAY));
      expect(result.renewalErrors).toBe(1);
      expect(env.deps.gateway.calls).toHaveLength(0);
    });
  });

  describe('downgrades', () => {
    it('applies at period end over quota: plan changes, uploads blocked, nothing deleted', async () => {
      const owner = await createBillingPhotographer(env.db, { usedBytes: 60 * GB });
      const oldPeriodEnd = bkk(2027, 3, 1);
      // A PromptPay downgrade bought 3 months from the old period_end.
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.pro,
        status: 'active',
        periodEnd: bkk(2027, 6, 1),
        pendingPlanId: env.plan.standard,
        pendingPlanEffectiveAt: oldPeriodEnd,
      });
      const file = await createFileRow(env.db, owner, {
        status: 'ready',
        verifiedAt: new Date(),
        sizeBytes: 60 * GB,
      });
      env.store.seed(file.s3Key, new Uint8Array(4));

      await run(env, plus(oldPeriodEnd, -1));
      expect((await subscriptionById(env.db, id)).planId).toBe(env.plan.pro);

      const result = await run(env, oldPeriodEnd);
      expect(result.downgradesApplied).toBe(1);
      const sub = await subscriptionById(env.db, id);
      expect(sub).toMatchObject({
        status: 'active',
        planId: env.plan.standard,
        pendingPlanId: null,
        pendingPlanEffectiveAt: null,
      });
      const [event] = await eventsOf(env.db, id);
      expect(event).toMatchObject({
        type: 'downgrade_applied',
        fromPlanId: env.plan.pro,
        toPlanId: env.plan.standard,
        meta: { quotaBytes: 50 * GB, overBytes: 10 * GB },
      });
      // Nothing deleted, usage untouched, uploads blocked until it fits.
      expect(await usageOf(env.db, owner)).toEqual({ usedBytes: 60 * GB, reservedBytes: 0 });
      expect(await env.db.select().from(files).where(eq(files.ownerId, owner))).toHaveLength(1);
      expect(env.store.objects.has(file.s3Key)).toBe(true);
      expect(
        uploadsBlockedBy(sub.status, {
          quotaBytes: 50 * GB,
          usedBytes: 60 * GB,
          reservedBytes: 0,
        }),
      ).toBe(ErrorCode.QUOTA_EXCEEDED);

      await run(env, plus(oldPeriodEnd, DAY));
      expect(await eventsOf(env.db, id)).toHaveLength(1);
    });
  });

  describe('account purge', () => {
    async function seedAccount(owner: string) {
      await env.provider.createCollection(faceCollectionId(owner));
      const root = await createFolder(env.db, owner);
      const child = await createFolder(env.db, owner, { parent: root });
      const grandchild = await createFolder(env.db, owner, { parent: child });
      const ready = await createFileRow(env.db, owner, {
        folderId: grandchild.id,
        status: 'ready',
        verifiedAt: new Date(),
        sizeBytes: 300,
        originalName: 'ready.jpg',
      });
      const trashed = await createFileRow(env.db, owner, {
        folderId: child.id,
        status: 'ready',
        verifiedAt: new Date(),
        sizeBytes: 200,
        deletedAt: new Date(),
        originalName: 'trashed.jpg',
      });
      const uploading = await createFileRow(env.db, owner, {
        folderId: root.id,
        sizeBytes: 100,
        uploadId: 'mpu-1',
        uploadExpiresAt: new Date(Date.now() + DAY),
        originalName: 'uploading.jpg',
      });
      for (const f of [ready, trashed]) {
        env.store.seed(f.s3Key, new Uint8Array(8));
        for (const key of Object.values(derivedKeys({ photographerId: owner, fileId: f.id }))) {
          env.store.seed(key, new Uint8Array(1));
        }
      }
      // An orphan object with no row.
      const orphanId = randomUUID();
      env.store.seed(
        originalKey({ photographerId: owner, fileId: orphanId, originalName: 'lost.jpg' }),
        new Uint8Array(1),
      );
      await env.db.insert(faces).values({
        fileId: ready.id,
        ownerId: owner,
        rekognitionFaceId: `face-${ready.id}`,
        bbox: { left: 0, top: 0, width: 0.1, height: 0.1 },
        confidence: 99,
      });
      for (const target of [{ file: ready.id }, { folder: child.id }]) {
        const [share] = await env.db
          .insert(shares)
          .values({
            ownerId: owner,
            targetType: target.file !== undefined ? 'file' : 'folder',
            targetFileId: target.file ?? null,
            targetFolderId: target.folder ?? null,
            token: `Pg${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          })
          .returning({ id: shares.id });
        await env.db.insert(consents).values({
          shareId: share!.id,
          anonId: randomUUID(),
          purpose: 'face_search',
          policyVersion: '2026-10',
          ipHash: 'h',
        });
        await env.db.insert(consents).values({
          shareId: share!.id,
          anonId: randomUUID(),
          purpose: 'face_deletion',
          policyVersion: '2026-10',
          ipHash: 'h',
        });
      }
      await env.db
        .update(storageUsage)
        .set({ usedBytes: 500, reservedBytes: 100 })
        .where(eq(storageUsage.photographerId, owner));
      return { files: [ready, trashed, uploading] };
    }

    async function expiredForPurge(owner: string) {
      const periodEnd = bkk(2026, 5, 1);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.standard,
        status: 'expired',
        periodEnd,
      });
      const paymentId = await createPayment(env.db, {
        photographerId: owner,
        subscriptionId: id,
        renewalPeriodEnd: plus(periodEnd, -30 * DAY),
        amountSatang: 39_000,
        status: 'paid',
        paidAt: plus(periodEnd, -30 * DAY),
        receiptSentAt: plus(periodEnd, -30 * DAY),
      });
      return { id, paymentId, purgeAt: plus(periodEnd, (14 + 45) * DAY) };
    }

    async function remaining(owner: string) {
      const count = async (table: typeof files | typeof folders | typeof shares | typeof faces) =>
        (await env.db.select().from(table).where(eq(table.ownerId, owner))).length;
      return {
        files: await count(files),
        folders: await count(folders),
        shares: await count(shares),
        faces: await count(faces),
        objects: [...env.store.objects.keys()].filter(
          (k) => k.startsWith(originalsPrefix(owner)) || k.startsWith(derivedPrefix(owner)),
        ).length,
      };
    }

    it('deletes S3 objects, the collection and drive rows, keeps billing records, marks purged', async () => {
      const owner = await createBillingPhotographer(env.db);
      const other = await createBillingPhotographer(env.db);
      await seedAccount(owner);
      await seedAccount(other);
      await createSubscription(env.db, other, {
        planId: env.plan.pro,
        status: 'active',
        periodEnd: bkk(2027, 12, 1),
      });
      const { id, paymentId, purgeAt } = await expiredForPurge(owner);

      await run(env, plus(purgeAt, -7 * DAY)); // the purge warning
      await run(env, plus(purgeAt, -1));
      expect((await subscriptionById(env.db, id)).status).toBe('expired');
      expect((await remaining(owner)).files).toBe(3);

      const result = await run(env, purgeAt);
      expect(result).toMatchObject({ purged: 1, purgesIncomplete: 0, complete: true });
      expect(await remaining(owner)).toEqual({
        files: 0,
        folders: 0,
        shares: 0,
        faces: 0,
        objects: 0,
      });
      expect(env.store.calls.aborted).toEqual(['mpu-1']);
      await expect(
        env.provider.listFaces({ collectionId: faceCollectionId(owner), maxResults: 10 }),
      ).rejects.toMatchObject({ name: 'ResourceNotFoundException' });
      expect(await usageOf(env.db, owner)).toEqual({ usedBytes: 0, reservedBytes: 0 });
      // Consents of the deleted shares went too (every purpose).
      const leftConsents = await env.db
        .select({ id: consents.id })
        .from(consents)
        .innerJoin(shares, eq(shares.id, consents.shareId))
        .where(eq(shares.ownerId, owner));
      expect(leftConsents).toHaveLength(0);

      // Billing records are kept.
      const sub = await subscriptionById(env.db, id);
      expect(sub.status).toBe('purged');
      const [payment] = await env.db.select().from(payments).where(eq(payments.id, paymentId));
      expect(payment?.status).toBe('paid');
      expect((await eventsOf(env.db, id)).map((e) => e.type)).toEqual(['purged']);

      // The other photographer is untouched.
      expect(await remaining(other)).toMatchObject({ files: 3, folders: 3, shares: 2, faces: 1 });
      await expect(
        env.provider.listFaces({ collectionId: faceCollectionId(other), maxResults: 10 }),
      ).resolves.toBeDefined();
      expect(await usageOf(env.db, other)).toEqual({ usedBytes: 500, reservedBytes: 100 });

      // Rerun: nothing more happens.
      const again = await run(env, plus(purgeAt, DAY));
      expect(again.purged).toBe(0);
      expect(await eventsOf(env.db, id)).toHaveLength(1);
    });

    it('resumes across runs when the runtime budget runs out', async () => {
      const owner = await createBillingPhotographer(env.db);
      await seedAccount(owner);
      const { id, purgeAt } = await expiredForPurge(owner);

      let runs = 0;
      let outcome = 'incomplete';
      while (outcome !== 'purged') {
        runs++;
        expect(runs).toBeLessThan(40);
        // A clock that allows a handful of budget checks per run.
        let ticks = 0;
        const ctx = context(env, { batchSize: 1, now: () => ticks++, deadline: 6 });
        outcome = await purgeAccount(ctx, env.deps, id, purgeAt);
        if (outcome !== 'purged') {
          expect(outcome).toBe('incomplete');
          expect((await subscriptionById(env.db, id)).status).toBe('expired');
        }
      }
      expect(runs).toBeGreaterThan(1);
      expect(await remaining(owner)).toEqual({
        files: 0,
        folders: 0,
        shares: 0,
        faces: 0,
        objects: 0,
      });
      expect((await subscriptionById(env.db, id)).status).toBe('purged');
      expect((await eventsOf(env.db, id)).map((e) => e.type)).toEqual(['purged']);
      expect(await usageOf(env.db, owner)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    });

    it('reports an incomplete run as incomplete and finishes in the next daily run', async () => {
      const owner = await createBillingPhotographer(env.db);
      await seedAccount(owner);
      const { id, purgeAt } = await expiredForPurge(owner);
      await run(env, plus(purgeAt, -7 * DAY)); // the purge warning
      let ticks = 0;
      const first = await run(env, purgeAt, { batchSize: 1, now: () => ticks++, deadline: 12 });
      expect(first.complete).toBe(false);
      expect((await subscriptionById(env.db, id)).status).toBe('expired');
      const second = await run(env, plus(purgeAt, DAY));
      expect(second).toMatchObject({ purged: 1, complete: true });
      expect((await subscriptionById(env.db, id)).status).toBe('purged');
    });

    it('never purges unwarned: a missed warning is sent late and postpones the purge', async () => {
      const owner = await createBillingPhotographer(env.db);
      await seedAccount(owner);
      const { id, purgeAt } = await expiredForPurge(owner);
      const late = plus(purgeAt, 3 * DAY);
      const first = await run(env, late);
      expect(first.purged).toBe(0);
      expect((await subscriptionById(env.db, id)).status).toBe('expired');
      expect((await remaining(owner)).files).toBe(3);
      const [warning] = env.deps.email.of('purge_warning');
      expect(warning?.message.params.purgeAt).toBe(plus(late, 7 * DAY).toISOString());
      await run(env, plus(late, 7 * DAY - 1));
      expect((await subscriptionById(env.db, id)).status).toBe('expired');
      await run(env, plus(late, 7 * DAY));
      expect((await subscriptionById(env.db, id)).status).toBe('purged');
      expect(env.deps.email.of('purge_warning')).toHaveLength(1);
    });

    it('purges on time for a photographer without an email address', async () => {
      const owner = await createBillingPhotographer(env.db, { email: null });
      await seedAccount(owner);
      const { id, purgeAt } = await expiredForPurge(owner);
      await run(env, purgeAt);
      expect((await subscriptionById(env.db, id)).status).toBe('purged');
    });

    it('stops when the subscription was renewed before the purge ran', async () => {
      const owner = await createBillingPhotographer(env.db);
      const { files: seeded } = await seedAccount(owner);
      const { id, purgeAt } = await expiredForPurge(owner);
      await env.db
        .update(subscriptions)
        .set({ status: 'active', periodEnd: plus(purgeAt, 30 * DAY) })
        .where(eq(subscriptions.id, id));
      expect(await purgeAccount(context(env), env.deps, id, purgeAt)).toBe('not-due');
      expect((await remaining(owner)).files).toBe(seeded.length);
    });

    it('marks a superseded history row purged without touching the newer subscription’s data', async () => {
      const owner = await createBillingPhotographer(env.db);
      await seedAccount(owner);
      const periodEnd = bkk(2026, 1, 1);
      const old = await createSubscription(env.db, owner, {
        planId: env.plan.starter,
        status: 'expired',
        periodEnd,
        createdAt: bkk(2025, 1, 1),
      });
      await createSubscription(env.db, owner, {
        planId: env.plan.pro,
        status: 'active',
        periodEnd: bkk(2027, 12, 1),
      });
      const result = await run(env, plus(periodEnd, 60 * DAY));
      expect(result.purged).toBe(1);
      expect((await subscriptionById(env.db, old)).status).toBe('purged');
      // No lifecycle email about a history row.
      expect(env.deps.email.sent).toHaveLength(0);
      expect(await remaining(owner)).toMatchObject({ files: 3, folders: 3 });
    });
  });

  describe('idempotent reruns', () => {
    it('a redelivered run is skipped by the ledger, and a rerun at the same instant changes nothing', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 1, 10);
      const active = await createSubscription(env.db, owner, {
        planId: env.plan.standard,
        status: 'active',
        periodEnd,
        autoRenew: { months: 1 },
      });
      const owner2 = await createBillingPhotographer(env.db);
      const grace = await createSubscription(env.db, owner2, {
        planId: env.plan.starter,
        status: 'active',
        periodEnd: plus(periodEnd, -2 * DAY),
      });
      const ledger = new MemoryJobRunLedger();
      const handler = createJobsHandler({
        ...testJobQueues(),
        db: env.db,
        store: env.store,
        faces: env.provider,
        ledger,
        orphanScans: new S3OrphanScanStore(env.store),
        orphanGraceMs: 3_600_000,
        trashRetentionDays: 30,
        subscriptions: env.deps,
        batchSize: 1,
        maxRuntimeMs: 3_600_000,
        now: () => plus(periodEnd, -3_600_000).getTime(),
      });
      const message = JSON.stringify({
        type: 'subscriptions.transition.daily',
        scheduledTime: '2027-01-09T17:30:00Z',
      });
      const ctx: MessageContext = {
        messageId: 'm',
        receiveCount: 1,
        signal: new AbortController().signal,
        log: memoryLogger(),
      };
      await handler(message, ctx);
      const snapshot = async () => ({
        events: (await eventsOf(env.db, active)).length + (await eventsOf(env.db, grace)).length,
        notices: (await noticesOf(env.db, active)).length + (await noticesOf(env.db, grace)).length,
        payments: (await paymentsOf(env.db, active)).length,
        emails: env.deps.email.sent.length,
        charges: env.deps.gateway.calls.length,
      });
      const first = await snapshot();
      expect(first).toEqual({ events: 2, notices: 1, payments: 1, emails: 2, charges: 1 });

      await handler(message, ctx); // duplicate delivery: ledger
      expect(await snapshot()).toEqual(first);
      // Even without the ledger, the same instant again does nothing new.
      await run(env, plus(periodEnd, -3_600_000), { batchSize: 1 });
      expect(await snapshot()).toEqual(first);
      expect(env.deps.email.duplicates).toHaveLength(0);
      expect((await subscriptionById(env.db, grace)).status).toBe('grace');
    });
  });

  describe('receipts', () => {
    it('skips legacy payments, retries a failed send and never sends twice', async () => {
      const owner = await createBillingPhotographer(env.db);
      const periodEnd = bkk(2027, 1, 10);
      const id = await createSubscription(env.db, owner, {
        planId: env.plan.studio,
        status: 'active',
        periodEnd,
      });
      // A legacy row (before migration 0004): neither a checkout nor a renewal.
      await createPayment(env.db, {
        photographerId: owner,
        subscriptionId: id,
        amountSatang: 229_000,
        status: 'paid',
        paidAt: plus(periodEnd, -40 * DAY),
      });
      const renewal = await createPayment(env.db, {
        photographerId: owner,
        subscriptionId: id,
        renewalPeriodEnd: plus(periodEnd, -30 * DAY),
        amountSatang: 229_000,
        vatSatang: splitVat(229_000, 700).vatSatang,
        status: 'paid',
        paidAt: plus(periodEnd, -30 * DAY),
      });
      env.deps.email.failNext();
      const at = plus(periodEnd, -60 * DAY);
      expect((await run(env, at)).receiptFailures).toBe(1);
      const [afterFailure] = await env.db.select().from(payments).where(eq(payments.id, renewal));
      expect(afterFailure?.receiptSentAt).toBeNull();
      expect((await run(env, at)).receiptsSent).toBe(1);
      await run(env, at);
      const receipts = env.deps.email.of('payment_receipt');
      expect(receipts.map((r) => r.message.params.paymentId)).toEqual([renewal]);
      expect(receipts[0]?.message.idempotencyKey).toBe(`receipt:${renewal}`);
    });
  });
});
