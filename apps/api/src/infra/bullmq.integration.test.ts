import { loadQueueBackendConfig, loadRedisConfig, parseQueueMessage } from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { API_QUEUES } from '../config';
import {
  BullMqQueueSender,
  bullMqQueue,
  connectBullMq,
  createBullMqConnection,
} from './bullmq-queue';
import { EnqueueTimeoutError } from './enqueue-timeout';

// BullMqQueueSender against a real Redis (REDIS_URL, e.g. the compose Redis), under a throwaway
// stage prefix that is obliterated afterwards.

const redisUrl = process.env.REDIS_URL ?? '';

describe.skipIf(redisUrl === '')('BullMqQueueSender on a real Redis (REDIS_URL)', () => {
  // A skipped describe still runs its body to collect tests: without REDIS_URL build nothing.
  if (redisUrl === '') return;
  const stage = `bq${process.pid}`;
  const config = loadQueueBackendConfig(
    { QUEUE_BACKEND: 'bullmq', APP_STAGE: stage, ZIP_QUEUE_ATTEMPTS: '2' },
    API_QUEUES,
  );
  if (config.backend !== 'bullmq') throw new Error('expected bullmq');
  const connection = createBullMqConnection(loadRedisConfig({ REDIS_URL: redisUrl }));
  const sender = new BullMqQueueSender(connection, config);

  beforeAll(() => connectBullMq(connection, 5_000));

  afterAll(async () => {
    await sender.close();
    for (const name of API_QUEUES) {
      const queue = bullMqQueue(name, connection, config.prefix, config.queues[name]);
      await queue.obliterate({ force: true });
      await queue.close();
    }
    connection.disconnect();
  });

  it('adds jobs with the serialized message, its job name and the queue settings', async () => {
    const zipMessage = {
      type: 'zip.create' as const,
      jobId: '0199b2a0-0000-7000-8000-000000000001',
    };
    await sender.send('zip', zipMessage);
    await sender.send('faces', {
      type: 'index.file',
      fileId: '0199b2a0-0000-7000-8000-000000000002',
    });

    const zip = bullMqQueue('zip', connection, config.prefix, config.queues.zip);
    const [job] = await zip.getJobs(['waiting']);
    await zip.close();
    expect(job?.name).toBe('zip.create');
    expect(typeof job?.data).toBe('string');
    expect(parseQueueMessage('zip', job?.data as string)).toEqual(zipMessage);
    expect(job?.opts).toMatchObject({
      attempts: 2,
      backoff: { type: 'exponential', delay: config.queues.zip.backoffDelayMs },
      removeOnComplete: { count: config.queues.zip.removeOnCompleteCount },
      removeOnFail: { count: config.queues.zip.removeOnFailCount },
    });
    // BullMQ's own id, never a custom one.
    expect(job?.id).toMatch(/^\d+$/);

    const faces = bullMqQueue('faces', connection, config.prefix, config.queues.faces);
    const [faceJob] = await faces.getJobs(['waiting']);
    await faces.close();
    expect(faceJob?.name).toBe('faces.index.file');
    // Keys live under the stage prefix only.
    const keys = await connection.keys(`${config.prefix}:*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k.startsWith(`shotx:${stage}:bull:`))).toBe(true);
  });

  it('refuses messages that fail the queue schema', async () => {
    await expect(
      sender.send('zip', { type: 'zip.create', jobId: 'nope' } as never),
    ).rejects.toThrow(/Invalid zip queue message/);
  });
});

describe('BullMqQueueSender with Redis unreachable', () => {
  const config = loadQueueBackendConfig(
    { QUEUE_BACKEND: 'bullmq', APP_STAGE: 'unreachable', QUEUE_ENQUEUE_TIMEOUT_MS: '300' },
    API_QUEUES,
  );
  if (config.backend !== 'bullmq') throw new Error('expected bullmq');
  // Nothing listens on port 1.
  const redis = loadRedisConfig({ REDIS_URL: 'redis://127.0.0.1:1' });

  it('fails start-up within the bound', async () => {
    const connection = createBullMqConnection(redis);
    await expect(connectBullMq(connection, 300)).rejects.toThrow(/Queue Redis .* unreachable/);
  });

  it('fails an enqueue fast instead of hanging', async () => {
    const connection = createBullMqConnection(redis);
    connection.on('error', () => undefined);
    const sender = new BullMqQueueSender(connection, config);
    const started = Date.now();
    const error = await sender
      .send('zip', { type: 'zip.create', jobId: '0199b2a0-0000-7000-8000-000000000001' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2_000);
    // Either ioredis refuses at once (no offline queue) or the enqueue deadline fires.
    expect(
      error instanceof EnqueueTimeoutError || /writeable|closed|ECONNREFUSED/i.test(String(error)),
    ).toBe(true);
    connection.disconnect();
  });
});
