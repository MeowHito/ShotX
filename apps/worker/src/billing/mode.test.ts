import {
  loadBillingConfig,
  loadEmailConfig,
  loadRetentionConfig,
  SCHEDULED_JOB_DEFAULTS,
  SCHEDULED_JOB_TYPES,
  type ScheduledJobsConfig,
  type ScheduledJobType,
} from '@shotx/shared';
import { users } from '@shotx/db';
import { FakeFaceProvider, SyntheticWorld } from '@shotx/face/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { syncJobSchedulers } from '../bullmq/schedules';
import type { Db } from '../db';
import { createJobsHandler, type JobsHandlerDeps } from '../jobs/handler';
import { MemoryJobRunLedger } from '../jobs/ledger';
import { S3OrphanScanStore } from '../jobs/orphan-scans';
import { memoryLogger, silentLogger } from '../logger';
import type { MessageContext } from '../sqs/consumer';
import {
  createBillingPhotographer,
  createSubscription,
  planIds,
  subscriptionById,
  testSubscriptionDeps,
} from '../testing/billing';
import {
  createFileRow,
  fileById,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../testing/database';
import { testJobQueues } from '../testing/jobs';
import { MemoryObjectStore } from '../testing/memory-aws';
import { OffEmailProvider } from '@shotx/shared';
import { FakeEmailProvider } from './email';
import { FakeRenewalGateway, UnavailableRenewalGateway } from './gateway';
import {
  BILLING_JOB_TYPES,
  billingJobsEnabled,
  createSubscriptionJobDeps,
  isBillingJob,
  logBillingJobs,
  schedulesForBillingMode,
  type SubscriptionJobConfig,
} from './mode';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

/** The jobs that keep running with BILLING_MODE=offline (ADR 0010). */
const NON_BILLING_JOBS = SCHEDULED_JOB_TYPES.filter((t) => !isBillingJob(t));

const SETTINGS = {
  attempts: 5,
  backoffDelayMs: 10_000,
  lockDurationMs: 300_000,
  maxStalledCount: 1,
  removeOnFailCount: 10_000,
  removeOnFailAgeSeconds: 1_209_600,
  removeOnCompleteCount: 1_000,
  removeOnCompleteAgeSeconds: 86_400,
  eventsMaxLen: 10_000,
};

const DEFAULT_SCHEDULES: ScheduledJobsConfig = {
  timezone: SCHEDULED_JOB_DEFAULTS.timezone,
  jobs: { ...SCHEDULED_JOB_DEFAULTS.jobs },
};

/** A BullMQ queue stand-in that keeps its schedulers, as the real one does across deployments. */
function schedulerQueue(existing: string[] = []) {
  const schedulers = new Set(existing);
  return {
    schedulers,
    upsertJobScheduler: (id: string) => {
      schedulers.add(id);
      return Promise.resolve({} as never);
    },
    removeJobScheduler: (id: string) => Promise.resolve(schedulers.delete(id)),
    getJobSchedulers: () => Promise.resolve([...schedulers].map((key) => ({ key })) as never),
  };
}

function subscriptionConfig(overrides: Partial<SubscriptionJobConfig> = {}): SubscriptionJobConfig {
  return {
    billingMode: 'gateway',
    paymentGateway: { gateway: 'fake', webhookToleranceSeconds: 300, secrets: {} },
    billing: loadBillingConfig({}),
    email: loadEmailConfig({ EMAIL_FROM_ADDRESS: 'no-reply@shotx.example' }),
    lifecycle: loadRetentionConfig({}).subscription,
    publicBaseUrl: 'https://shotx.example',
    ...overrides,
  };
}

describe('billing jobs by BILLING_MODE (ADR 0010)', () => {
  it('names subscriptions.transition.daily as the only billing job', () => {
    expect(BILLING_JOB_TYPES).toEqual(['subscriptions.transition.daily']);
    // Kept in both modes: rollup, trash purge, face-index expiry, quota reconciliation, sweeps,
    // auth sessions purge.
    expect(NON_BILLING_JOBS).toEqual(
      expect.arrayContaining<ScheduledJobType>([
        'stats.rollup.hourly',
        'trash.purge.daily',
        'faces.expire.daily',
        'faces.reconcile.daily',
        'quota.reconcile.nightly',
        'media.sweep',
        'faces.sweep',
        'auth.sessions.purge.daily',
      ]),
    );
    expect(NON_BILLING_JOBS).toHaveLength(SCHEDULED_JOB_TYPES.length - 1);
    expect(billingJobsEnabled('offline')).toBe(false);
    expect(billingJobsEnabled('gateway')).toBe(true);
  });

  it('disables only the billing schedules offline, whatever SCHEDULE_*_ENABLED says', () => {
    const offline = schedulesForBillingMode(DEFAULT_SCHEDULES, 'offline');
    expect(offline.jobs['subscriptions.transition.daily']).toEqual({
      cron: '0 1 * * *',
      enabled: false,
    });
    for (const type of NON_BILLING_JOBS)
      expect(offline.jobs[type]).toEqual(DEFAULT_SCHEDULES.jobs[type]);
    // The input is not changed, and gateway mode keeps the config as it is.
    expect(DEFAULT_SCHEDULES.jobs['subscriptions.transition.daily'].enabled).toBe(true);
    expect(schedulesForBillingMode(DEFAULT_SCHEDULES, 'gateway')).toBe(DEFAULT_SCHEDULES);
    const turnedOff: ScheduledJobsConfig = {
      ...DEFAULT_SCHEDULES,
      jobs: {
        ...DEFAULT_SCHEDULES.jobs,
        'subscriptions.transition.daily': { cron: '0 1 * * *', enabled: false },
      },
    };
    expect(
      schedulesForBillingMode(turnedOff, 'gateway').jobs['subscriptions.transition.daily'].enabled,
    ).toBe(false);
  });

  it('registers no billing job scheduler offline and removes one left by gateway mode', async () => {
    // A worker deployed earlier with BILLING_MODE=gateway left its scheduler in Redis.
    const queue = schedulerQueue(['subscriptions.transition.daily', 'trash.purge.daily']);
    const result = await syncJobSchedulers(
      queue,
      schedulesForBillingMode(DEFAULT_SCHEDULES, 'offline'),
      SETTINGS,
      memoryLogger(),
    );
    expect(result.upserted).toEqual(NON_BILLING_JOBS);
    expect(result.removed).toEqual(['subscriptions.transition.daily']);
    expect([...queue.schedulers].sort()).toEqual([...NON_BILLING_JOBS].sort());

    // A restart offline changes nothing.
    const again = await syncJobSchedulers(
      queue,
      schedulesForBillingMode(DEFAULT_SCHEDULES, 'offline'),
      SETTINGS,
      memoryLogger(),
    );
    expect(again.removed).toEqual([]);
  });

  it('registers every job scheduler, billing included, in gateway mode', async () => {
    const queue = schedulerQueue();
    const result = await syncJobSchedulers(
      queue,
      schedulesForBillingMode(DEFAULT_SCHEDULES, 'gateway'),
      SETTINGS,
      memoryLogger(),
    );
    expect(result.upserted).toEqual([...SCHEDULED_JOB_TYPES]);
    expect(queue.schedulers.has('subscriptions.transition.daily')).toBe(true);
  });

  it('creates no renewal gateway or email provider offline', () => {
    const ses = vi.fn(() => ({ send: () => Promise.resolve({}) }));
    expect(
      createSubscriptionJobDeps(
        subscriptionConfig({
          billingMode: 'offline',
          paymentGateway: null,
          email: { provider: 'ses', from: { address: 'no-reply@shotx.example', name: 'ShotX' } },
        }),
        ses,
        silentLogger,
      ),
    ).toBeNull();
    expect(ses).not.toHaveBeenCalled();
  });

  it('creates the gateway and email provider in gateway mode, unchanged', () => {
    const deps = createSubscriptionJobDeps(
      subscriptionConfig(),
      () => {
        throw new Error('not with EMAIL_PROVIDER=fake');
      },
      silentLogger,
    );
    expect(deps?.gateway).toBeInstanceOf(FakeRenewalGateway);
    expect(deps?.email).toBeInstanceOf(FakeEmailProvider);
    expect(deps?.publicBaseUrl).toBe('https://shotx.example');
    const omise = createSubscriptionJobDeps(
      subscriptionConfig({
        paymentGateway: { gateway: 'omise', webhookToleranceSeconds: 300, secrets: {} },
      }),
      () => ({ send: () => Promise.resolve({}) }),
      silentLogger,
    );
    expect(omise?.gateway).toBeInstanceOf(UnavailableRenewalGateway);
    expect(() =>
      createSubscriptionJobDeps(
        subscriptionConfig({ paymentGateway: null }),
        () => {
          throw new Error('unused');
        },
        silentLogger,
      ),
    ).toThrow(/BILLING_MODE=gateway/);
  });

  it('drops billing emails with EMAIL_PROVIDER=off in gateway mode, logging the template only', async () => {
    const log = memoryLogger();
    const ses = vi.fn(() => ({ send: () => Promise.resolve({}) }));
    const deps = createSubscriptionJobDeps(
      subscriptionConfig({ email: loadEmailConfig({ EMAIL_PROVIDER: 'off' }) }),
      ses,
      log,
    );
    expect(deps?.email).toBeInstanceOf(OffEmailProvider);
    await expect(
      deps?.email.send({
        to: 'secret-recipient@example.com',
        template: 'grace_started',
        locale: 'th',
        params: { graceEndsAt: '2026-12-15T00:00:00+07:00', billingUrl: 'https://shotx.example/b' },
        idempotencyKey: 'grace:acct-123',
      }),
    ).resolves.toEqual({ messageId: 'email-off', dropped: true });
    expect(ses).not.toHaveBeenCalled();
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]?.fields).toEqual({
      event: 'email.dropped',
      provider: 'off',
      template: 'grace_started',
    });
    expect(JSON.stringify(log.entries)).not.toMatch(/secret-recipient|acct-123|shotx\.example\/b/);
  });

  it('logs one start-up line per mode', () => {
    const offline = memoryLogger();
    logBillingJobs('offline', offline);
    expect(offline.entries).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: expect.stringMatching(/^billing jobs off \(BILLING_MODE=offline\)/) as unknown,
        fields: { jobs: 'subscriptions.transition.daily' },
      }),
    ]);
    const gateway = memoryLogger();
    logBillingJobs('gateway', gateway);
    expect(gateway.entries).toHaveLength(1);
    expect(gateway.entries[0]?.msg).toMatch(/^billing jobs on/);
  });
});

describe('jobs handler by BILLING_MODE (ADR 0010)', () => {
  let database: TestDatabase;
  let db: Db;
  let plan: Awaited<ReturnType<typeof planIds>>;

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
    plan = await planIds(db);
  });
  afterAll(async () => {
    await database.close();
  });

  const context = (log = silentLogger): MessageContext => ({
    messageId: 'm',
    receiveCount: 1,
    signal: new AbortController().signal,
    log,
  });

  function handlerDeps(
    subscriptions: JobsHandlerDeps['subscriptions'],
    store = new MemoryObjectStore(),
  ): JobsHandlerDeps & { ledger: MemoryJobRunLedger } {
    return {
      ...testJobQueues(),
      db,
      store,
      faces: new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] })),
      ledger: new MemoryJobRunLedger(),
      orphanScans: new S3OrphanScanStore(store),
      orphanGraceMs: 3_600_000,
      trashRetentionDays: 30,
      subscriptions,
      batchSize: 100,
      maxRuntimeMs: 3_600_000,
    };
  }

  const message = (type: ScheduledJobType, scheduledTime: string) =>
    JSON.stringify({ type, scheduledTime });

  it('offline: acknowledges subscriptions.transition.daily without transitions, charges or emails', async () => {
    const owner = await createBillingPhotographer(db);
    const due = await createSubscription(db, owner, {
      planId: plan.standard,
      status: 'active',
      periodEnd: daysAgo(1),
      autoRenew: { months: 1 },
    });
    const deps = handlerDeps(null);
    const log = memoryLogger();
    await handler(deps, message('subscriptions.transition.daily', '2026-11-10T18:00:00Z'), log);

    expect(log.entries.map((e) => e.msg)).toEqual([
      'billing job skipped: BILLING_MODE=offline; acknowledged without running',
    ]);
    const after = await subscriptionById(db, due);
    expect(after.status).toBe('active');
    // Not recorded as done: switching to gateway mode later runs that day's schedule normally.
    expect(deps.ledger.done.size).toBe(0);
  });

  it('gateway: runs subscriptions.transition.daily as before (charge, then grace emails)', async () => {
    const owner = await createBillingPhotographer(db);
    const due = await createSubscription(db, owner, {
      planId: plan.standard,
      status: 'active',
      periodEnd: daysAgo(1),
    });
    const subscriptions = testSubscriptionDeps();
    const deps = handlerDeps(subscriptions);
    const log = memoryLogger();
    await handler(deps, message('subscriptions.transition.daily', '2026-11-11T18:00:00Z'), log);
    expect(log.entries).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'scheduled job finished' }),
    );
    expect((await subscriptionById(db, due)).status).toBe('grace');
    expect(subscriptions.email.of('grace_started').length).toBeGreaterThanOrEqual(1);
    expect(deps.ledger.done.size).toBe(1);
  });

  it('offline: keeps running the other jobs and deletes nothing of a disabled account', async () => {
    const store = new MemoryObjectStore();
    const owner = await createBillingPhotographer(db, { usedBytes: 0 });
    await db
      .update(users)
      .set({ status: 'disabled', disabledAt: daysAgo(200) })
      .where(eq(users.id, owner));
    // Long past the purge point of the (switched off) lifecycle.
    const expired = await createSubscription(db, owner, {
      planId: plan.standard,
      status: 'expired',
      periodEnd: daysAgo(200),
    });
    const kept = await createFileRow(db, owner, {
      status: 'ready',
      verifiedAt: daysAgo(100),
      sizeBytes: 100,
      originalName: 'kept.jpg',
    });
    store.seed(kept.s3Key, new Uint8Array(100));
    const deps = handlerDeps(null, store);

    const log = memoryLogger();
    for (const type of [
      'subscriptions.transition.daily',
      'trash.purge.daily',
      'quota.reconcile.nightly',
      'faces.expire.daily',
      'stats.rollup.hourly',
      'auth.sessions.purge.daily',
    ] as const) {
      await handler(deps, message(type, '2026-11-12T18:00:00Z'), log);
    }

    expect(log.entries.filter((e) => e.msg === 'scheduled job finished')).toHaveLength(5);
    expect(deps.ledger.done.has('subscriptions.transition.daily:2026-11-12T18:00:00.000Z')).toBe(
      false,
    );
    expect(deps.ledger.done.has('quota.reconcile.nightly:2026-11-12T18:00:00.000Z')).toBe(true);
    expect((await subscriptionById(db, expired)).status).toBe('expired');
    expect((await fileById(db, kept.id))?.deletedAt).toBeNull();
    expect(await store.head(kept.s3Key)).toEqual({ size: 100 });
    // quota.reconcile.nightly still tracks usage exactly for the disabled account.
    expect(await usageOf(db, owner)).toEqual({ usedBytes: 100, reservedBytes: 0 });
  });

  async function handler(
    deps: JobsHandlerDeps,
    body: string,
    log: ReturnType<typeof memoryLogger>,
  ): Promise<void> {
    await createJobsHandler(deps)(body, context(log));
  }
});
