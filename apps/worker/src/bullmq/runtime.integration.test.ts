import { randomUUID } from 'node:crypto';
import {
  bullMqQueueOptions,
  type BullMqQueueSettings,
  bullMqPrefix,
  parseQueueMessage,
  type QueueName,
  SCHEDULED_JOB_DEFAULTS,
  SCHEDULED_JOB_TYPES,
  type ScheduledJobsConfig,
  serializeQueueMessage,
} from '@shotx/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { MemoryJobRunLedger } from '../jobs/ledger';
import { silentLogger } from '../logger';
import {
  MessageAbortedError,
  type MessageContext,
  type MessageHandler,
  PermanentMessageError,
} from '../queue/handler';
import { BullMqConsumer, type BullMqConsumerOptions } from './consumer';
import { createBullMqConnection } from './options';
import { syncJobSchedulers } from './schedules';
import { BullMqQueueSender } from './sender';

/**
 * Against a real Redis: REDIS_URL (default redis://localhost:6379, the shotx-dev compose stack).
 * Each test uses its own `shotx:it-<random>:bull` prefix and deletes its keys afterwards. Skipped
 * when no Redis answers, so CI without Redis stays green.
 */
const url = process.env.REDIS_URL || 'redis://localhost:6379';
const credentials =
  process.env.REDIS_USERNAME && process.env.REDIS_PASSWORD
    ? { username: process.env.REDIS_USERNAME, password: process.env.REDIS_PASSWORD }
    : null;

async function redisReachable(): Promise<boolean> {
  const probe = new Redis(url, {
    ...(credentials ?? {}),
    lazyConnect: true,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  probe.on('error', () => undefined);
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const reachable = await redisReachable();

const SETTINGS: BullMqQueueSettings = {
  attempts: 3,
  backoffDelayMs: 50,
  lockDurationMs: 30_000,
  maxStalledCount: 1,
  removeOnFailCount: 100,
  removeOnFailAgeSeconds: 3600,
  removeOnCompleteCount: 100,
  removeOnCompleteAgeSeconds: 3600,
  eventsMaxLen: 1000,
};

const SETTINGS_BY_QUEUE = (
  settings: BullMqQueueSettings,
): Record<QueueName, BullMqQueueSettings> => ({
  media: settings,
  faces: settings,
  zip: settings,
  jobs: settings,
});

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const facesBody = (fileId = randomUUID()) =>
  serializeQueueMessage('faces', { type: 'index.file', fileId });

// Generous limits: under the full turbo run every package's tests compete for CPU, and BullMQ's
// timers (backoff, lock renewal, stall checks) slip with the event loop.
describe.skipIf(!reachable)('BullMQ runtime against Redis', { timeout: 60_000 }, () => {
  const connection = createBullMqConnection({ url, tls: false, credentials });
  connection.on('error', () => undefined);
  const prefixes: string[] = [];
  const cleanups: Array<() => Promise<unknown>> = [];

  /** A fresh prefix per test, so tests never see each other's jobs. */
  function newPrefix(): string {
    const prefix = bullMqPrefix(`it-${randomUUID().slice(0, 8)}`);
    prefixes.push(prefix);
    return prefix;
  }

  function sender(prefix: string, settings = SETTINGS): BullMqQueueSender {
    const s = new BullMqQueueSender({
      connection,
      prefix,
      queues: SETTINGS_BY_QUEUE(settings),
      log: silentLogger,
    });
    cleanups.push(() => s.close());
    return s;
  }

  function consumer(
    options: Pick<BullMqConsumerOptions, 'queue' | 'prefix' | 'handler'> &
      Partial<BullMqConsumerOptions>,
  ): BullMqConsumer {
    const c = new BullMqConsumer({
      connection,
      settings: SETTINGS,
      concurrency: 1,
      shutdownGraceMs: 1000,
      abortSettleMs: 2000,
      log: silentLogger,
      ...options,
    });
    cleanups.push(() => c.stop());
    void c.start();
    return c;
  }

  function queue(prefix: string, name: QueueName): Queue {
    const q = new Queue(name, { ...bullMqQueueOptions(SETTINGS, prefix), connection });
    cleanups.push(() => q.close());
    return q;
  }

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
  });

  afterAll(async () => {
    for (const prefix of prefixes) {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await connection.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      if (keys.length > 0) await connection.del(...keys);
    }
    await connection.quit();
  });

  it('delivers sent messages to the handler with the job id and receive count 1', async () => {
    const prefix = newPrefix();
    const s = sender(prefix);
    const one = facesBody();
    const two = [facesBody(), facesBody()];
    await s.sendMessage('faces', one);
    await s.sendMessages('faces', two);
    await expect(s.sendMessage('faces', '{"type":"nope"}')).rejects.toThrow(/Invalid faces/);
    await expect(s.sendMessage('nope', one)).rejects.toThrow(RangeError);

    const seen: Array<{ body: string; context: MessageContext }> = [];
    consumer({
      queue: 'faces',
      prefix,
      handler: (body, context) => {
        seen.push({ body, context });
        return Promise.resolve();
      },
    });
    await waitFor(() => seen.length === 3);
    expect(seen.map((s) => s.body).sort()).toEqual([one, ...two].sort());
    expect(seen.every((s) => s.context.receiveCount === 1)).toBe(true);

    const q = queue(prefix, 'faces');
    await waitFor(async () => (await q.getCompletedCount()) === 3);
    const job = await q.getJob(seen[0]!.context.messageId);
    expect(job?.name).toBe('faces.index.file');
    expect(job?.data).toBe(seen[0]!.body);
    expect(job?.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 50 },
      removeOnComplete: { count: 100, age: 3600 },
      removeOnFail: { count: 100, age: 3600 },
    });
    expect(job?.id).not.toMatch(/^[a-z]/); // BullMQ's own ids, no custom dedupe ids
  });

  it('retries a failing job with backoff until it succeeds, counting receives', async () => {
    const prefix = newPrefix();
    const counts: number[] = [];
    consumer({
      queue: 'media',
      prefix,
      handler: (_body, { receiveCount }) => {
        counts.push(receiveCount);
        return receiveCount < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve();
      },
    });
    const job = await queue(prefix, 'media').add('media.object-created', 'body', {
      attempts: 3,
      backoff: { type: 'exponential', delay: 50 },
    });
    await waitFor(async () => (await job.getState()) === 'completed', 40_000);
    expect(counts).toEqual([1, 2, 3]);
  });

  it('keeps a job that used all attempts in the failed set, with a scrubbed reason', async () => {
    const prefix = newPrefix();
    let calls = 0;
    consumer({
      queue: 'media',
      prefix,
      handler: () => {
        calls++;
        return Promise.reject(new Error('cannot read originals/p/f/สมชาย.jpg'));
      },
    });
    const q = queue(prefix, 'media');
    const added = await q.add('media.object-created', 'body', {
      attempts: 2,
      backoff: { type: 'exponential', delay: 20 },
    });
    await waitFor(async () => (await added.getState()) === 'failed');
    const job = await q.getJob(added.id!);
    expect(calls).toBe(2);
    expect(job?.attemptsMade).toBe(2);
    expect(job?.failedReason).toBe('cannot read originals/<redacted>');
    expect((job?.stacktrace ?? []).join('\n')).not.toContain('สมชาย');
  });

  it('fails permanent errors and invalid job data at once, without retries', async () => {
    const prefix = newPrefix();
    const bodies: string[] = [];
    consumer({
      queue: 'zip',
      prefix,
      handler: (body) => {
        bodies.push(body);
        return Promise.reject(new PermanentMessageError('no such zip job'));
      },
    });
    const q = queue(prefix, 'zip');
    const permanent = await q.add('zip.create', 'body', { attempts: 3 });
    const invalid = await q.add('zip.create', { not: 'a string' }, { attempts: 3 });
    await waitFor(async () => (await permanent.getState()) === 'failed');
    await waitFor(async () => (await invalid.getState()) === 'failed');
    expect(bodies).toEqual(['body']); // the invalid job never reached the handler
    const [p, i] = await Promise.all([q.getJob(permanent.id!), q.getJob(invalid.id!)]);
    expect(p?.attemptsMade).toBe(1);
    expect(p?.failedReason).toBe('no such zip job');
    expect(i?.attemptsMade).toBe(1);
    expect(i?.failedReason).toMatch(/Invalid zip queue message/);
  });

  it('aborts the signal when the lock is lost, and the job comes back through the stall check', async () => {
    const prefix = newPrefix();
    const contexts: MessageContext[] = [];
    let aborted: unknown;
    const handler: MessageHandler = (_body, context) => {
      contexts.push(context);
      if (contexts.length > 1) return Promise.resolve();
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => {
          aborted = context.signal.reason;
          reject(context.signal.reason as Error);
        });
      });
    };
    consumer({
      queue: 'media',
      prefix,
      handler,
      settings: { ...SETTINGS, lockDurationMs: 1000 },
      tuning: { stalledInterval: 300 },
    });
    const job = await queue(prefix, 'media').add('media.object-created', 'body');
    await waitFor(() => contexts.length === 1);
    // Another worker "took" the job: its lock is no longer ours.
    await connection.del(`${prefix}:media:${job.id}:lock`);
    await waitFor(() => aborted !== undefined);
    expect(aborted).toBeInstanceOf(MessageAbortedError);
    expect((aborted as MessageAbortedError).reason).toBe('lost');
    // The stalled check hands it out again; the redelivery is visible in receiveCount.
    await waitFor(async () => (await job.getState()) === 'completed');
    expect(contexts).toHaveLength(2);
    expect(contexts[1]!.receiveCount).toBe(2);
  });

  it('lets running jobs finish within the shutdown grace', async () => {
    const prefix = newPrefix();
    let signal: AbortSignal | undefined;
    const c = consumer({
      queue: 'faces',
      prefix,
      shutdownGraceMs: 2000,
      handler: async (_body, context) => {
        signal = context.signal;
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
    });
    const job = await queue(prefix, 'faces').add('faces.index.file', facesBody());
    await waitFor(() => signal !== undefined);
    await c.stop();
    expect(signal?.aborted).toBe(false);
    expect(await job.getState()).toBe('completed');
  });

  it('aborts on shutdown after the grace and hands the job back without using an attempt', async () => {
    const prefix = newPrefix();
    let first: MessageContext | undefined;
    const c = consumer({
      queue: 'faces',
      prefix,
      shutdownGraceMs: 200,
      handler: (_body, context) => {
        first = context;
        return new Promise((_resolve, reject) =>
          context.signal.addEventListener('abort', () => reject(context.signal.reason as Error)),
        );
      },
    });
    const q = queue(prefix, 'faces');
    const added = await q.add('faces.index.file', facesBody(), { attempts: 3 });
    await waitFor(() => first !== undefined);
    const started = Date.now();
    await c.stop();
    // grace 200 ms + abort settle (at most 2 s here), plus slack for load
    expect(Date.now() - started).toBeLessThan(5000);
    expect(first?.signal.reason).toBeInstanceOf(MessageAbortedError);
    expect((first?.signal.reason as MessageAbortedError).reason).toBe('shutdown');
    const job = await q.getJob(added.id!);
    expect(await job?.getState()).toBe('waiting');
    expect(job?.attemptsMade).toBe(0);

    // The next worker gets it as a redelivery.
    const counts: number[] = [];
    consumer({
      queue: 'faces',
      prefix,
      handler: (_body, { receiveCount }) => {
        counts.push(receiveCount);
        return Promise.resolve();
      },
    });
    await waitFor(async () => (await added.getState()) === 'completed');
    expect(counts).toEqual([2]);
  });

  it('syncs job schedulers idempotently and removes disabled ones', async () => {
    const prefix = newPrefix();
    const q = queue(prefix, 'jobs');
    const only = (type: keyof ScheduledJobsConfig['jobs'], cron: string): ScheduledJobsConfig => ({
      timezone: 'Asia/Bangkok',
      jobs: Object.fromEntries(
        Object.entries(SCHEDULED_JOB_DEFAULTS.jobs).map(([t, s]) => [
          t,
          t === type ? { cron, enabled: true } : { ...s, enabled: false },
        ]),
      ) as ScheduledJobsConfig['jobs'],
    });
    const config = only('trash.purge.daily', '30 1 * * *');
    await syncJobSchedulers(q, config, SETTINGS, silentLogger);
    await syncJobSchedulers(q, config, SETTINGS, silentLogger);
    const schedulers = await q.getJobSchedulers();
    expect(schedulers.map((s) => s.key)).toEqual(['trash.purge.daily']);
    expect(schedulers[0]).toMatchObject({ name: 'trash.purge.daily', tz: 'Asia/Bangkok' });
    const delayed = await q.getDelayed();
    expect(delayed).toHaveLength(1);
    expect(delayed[0]!.id).toMatch(/^repeat:trash\.purge\.daily:\d+$/);
    // The next 01:30 in Bangkok is 18:30 UTC.
    expect(new Date(delayed[0]!.timestamp + delayed[0]!.delay).toISOString()).toMatch(
      /T18:30:00\.000Z$/,
    );
    expect(delayed[0]!.opts.attempts).toBe(3);

    await syncJobSchedulers(q, only('faces.expire.daily', '0 2 * * *'), SETTINGS, silentLogger);
    expect((await q.getJobSchedulers()).map((s) => s.key)).toEqual(['faces.expire.daily']);
  });

  it('runs consecutive scheduler slots as distinct scheduled times through the ledger', async () => {
    const prefix = newPrefix();
    const q = queue(prefix, 'jobs');
    const ledger = new MemoryJobRunLedger();
    const runs: string[] = [];
    const ids: string[] = [];
    consumer({
      queue: 'jobs',
      prefix,
      handler: async (body, { messageId }) => {
        const message = parseQueueMessage('jobs', body);
        ids.push(messageId);
        if (await ledger.isDone(message.type, message.scheduledTime)) return;
        runs.push(message.scheduledTime);
        await ledger.markDone(message.type, message.scheduledTime);
      },
    });
    // Every second (a six-field pattern, only for this test) so two slots pass quickly.
    const schedules: ScheduledJobsConfig = {
      timezone: 'Asia/Bangkok',
      jobs: Object.fromEntries(
        Object.entries(SCHEDULED_JOB_DEFAULTS.jobs).map(([t, s]) => [
          t,
          t === 'stats.rollup.hourly'
            ? { cron: '* * * * * *', enabled: true }
            : { ...s, enabled: false },
        ]),
      ) as ScheduledJobsConfig['jobs'],
    };
    await syncJobSchedulers(q, schedules, SETTINGS, silentLogger);
    await waitFor(() => runs.length >= 2);
    await q.removeJobScheduler('stats.rollup.hourly');

    expect(new Set(runs).size).toBe(runs.length);
    for (const [n, time] of runs.slice(0, 2).entries()) {
      expect(time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      // The scheduled time is the slot in the job id, not the time the job started.
      const slot = Number(/^repeat:stats\.rollup\.hourly:(\d+)$/.exec(ids[n]!)?.[1]);
      expect(Date.parse(time)).toBe(Math.floor(slot / 1000) * 1000);
    }
  });

  it('works under an ACL user without @dangerous commands (no INFO)', async (ctx) => {
    const prefix = newPrefix();
    const user = `shotx-it-${randomUUID().slice(0, 8)}`;
    const password = randomUUID();
    try {
      await connection.call(
        'ACL',
        'SETUSER',
        user,
        'on',
        `>${password}`,
        `~${prefix}:*`,
        'resetchannels',
        '+@all',
        '-@dangerous',
      );
    } catch {
      ctx.skip(); // no ACL permission on this Redis
    }
    cleanups.push(() => connection.call('ACL', 'DELUSER', user));
    const restricted = createBullMqConnection({
      url,
      tls: false,
      credentials: { username: user, password },
    });
    restricted.on('error', () => undefined);
    cleanups.push(() => restricted.quit());
    await expect(restricted.info()).rejects.toThrow(/NOPERM/);

    const s = new BullMqQueueSender({
      connection: restricted,
      prefix,
      queues: SETTINGS_BY_QUEUE(SETTINGS),
      log: silentLogger,
    });
    cleanups.push(() => s.close());
    const seen: string[] = [];
    const c = new BullMqConsumer({
      queue: 'faces',
      connection: restricted,
      prefix,
      settings: SETTINGS,
      concurrency: 1,
      shutdownGraceMs: 1000,
      log: silentLogger,
      handler: (body) => {
        seen.push(body);
        return Promise.resolve();
      },
    });
    cleanups.push(() => c.stop());
    void c.start();
    const body = facesBody();
    await s.sendMessage('faces', body);
    await waitFor(() => seen.length === 1);
    expect(seen).toEqual([body]);
    await syncJobSchedulers(s.queue('jobs'), SCHEDULED_JOB_DEFAULTS, SETTINGS, silentLogger);
    expect(await s.queue('jobs').getJobSchedulersCount()).toBe(SCHEDULED_JOB_TYPES.length);
  });
});
