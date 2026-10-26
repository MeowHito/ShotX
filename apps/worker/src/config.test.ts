import { describe, expect, it } from 'vitest';
import { loadWorkerSettings, storageS3ClientOptions } from '@shotx/shared';
import { loadWorkerConfig } from './config';
import { checkFacesBudget } from './faces/budget';
import { createJsonLogger, errorFields } from './logger';

/** What infra gives the worker task (infra/README.md), with local values. */
const env = {
  NODE_ENV: 'production',
  APP_STAGE: 'staging',
  PUBLIC_BASE_URL: 'https://shotx.example',
  ADMIN_BASE_URL: 'https://admin.shotx.example',
  AWS_REGION: 'ap-southeast-1',
  PGHOST: 'db.internal',
  PGDATABASE: 'shotx',
  PGUSER: 'worker',
  PGPASSWORD: 'secret',
  PGSSLMODE: 'verify-full',
  REDIS_URL: 'rediss://redis.internal:6379',
  REDIS_USERNAME: 'app',
  REDIS_PASSWORD: 'secret',
  MEDIA_BUCKET: 'shotx-staging-media',
  MEDIA_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/1/shotx-staging-media',
  FACES_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/1/shotx-staging-faces',
  ZIP_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/1/shotx-staging-zip',
  JOBS_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/1/shotx-staging-jobs',
  MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '300',
  FACES_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '900',
  ZIP_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '300',
  JOBS_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '900',
  // Phase 4: plain env plus the gateway's ECS secrets (PAYMENT_GATEWAY_SECRET_ENV).
  PAYMENT_GATEWAY: 'omise',
  PAYMENT_OMISE_PUBLIC_KEY: 'pkey_test_0123456789abcdef',
  PAYMENT_OMISE_SECRET_KEY: 'skey_test_0123456789abcdef',
  PAYMENT_OMISE_WEBHOOK_SECRET: 'whsec_test_0123456789abcdef',
  EMAIL_PROVIDER: 'ses',
  EMAIL_FROM_ADDRESS: 'no-reply@shotx.example',
  EMAIL_FROM_NAME: 'ShotX',
};

describe('worker config', () => {
  it('accepts what infra sets on the worker task', () => {
    const config = loadWorkerConfig(env);
    // QUEUE_BACKEND defaults to sqs while infra/ exists.
    expect(config.queue).toEqual({
      backend: 'sqs',
      urls: {
        media: env.MEDIA_QUEUE_URL,
        faces: env.FACES_QUEUE_URL,
        zip: env.ZIP_QUEUE_URL,
        jobs: env.JOBS_QUEUE_URL,
      },
      visibilityTimeoutSeconds: { media: 300, faces: 900, zip: 300, jobs: 900 },
    });
    expect(config.media.web).toEqual({ longEdge: 2560, jpegQuality: 85 });
    expect(config.retention.trashRetentionDays).toBe(30);
    expect(config.retention.faceIndexExpiryDays).toBe(90);
    expect(config.worker.consumers.media).toEqual({ batchSize: 4, concurrency: 2 });
    expect(config.worker.consumers.zip).toEqual({ batchSize: 1, concurrency: 1 });
    expect(config.worker.maxProcessingMs.media).toBeLessThan(12 * 3600 * 1000);
    // Face search stays off until the Phase 0 evaluation passes.
    expect(config.features.faceSearch).toBe(false);
    expect(loadWorkerConfig({ ...env, FACE_SEARCH_ENABLED: 'true' }).features.faceSearch).toBe(
      true,
    );
    expect(config.zip).toEqual({
      maxFiles: 500,
      maxBytes: 2 * 1024 ** 3,
      resultTtlSeconds: 86_400,
    });
    expect(config.multipartPartBytes).toBe(16 * 1024 * 1024);
    expect(config.billing.renewal).toEqual({ maxAttempts: 3, leadSeconds: 86_400 });
    expect(config.email).toEqual({
      provider: 'ses',
      from: { address: 'no-reply@shotx.example', name: 'ShotX' },
    });
    expect(config.paymentGateway.gateway).toBe('omise');
    expect(config.retention.subscription).toEqual({
      graceDays: 14,
      purgeAfterExpiryDays: 45,
      reminderDays: [14, 7, 1],
      purgeWarningDays: 7,
    });
  });

  it('applies the Phase 4 contract limits', () => {
    // Zip results live at most 2 days now (tmp/ lifecycle ceiling of 3 days).
    expect(
      loadWorkerConfig({ ...env, ZIP_RESULT_TTL_SECONDS: '172800' }).zip.resultTtlSeconds,
    ).toBe(172_800);
    expect(() => loadWorkerConfig({ ...env, ZIP_RESULT_TTL_SECONDS: '172801' })).toThrow(
      /ZIP_RESULT_TTL_SECONDS/,
    );
    expect(() => loadWorkerConfig({ ...env, ZIP_RESULT_TTL_SECONDS: '259200' })).toThrow();
    // Fakes are refused on the prod stage only (staging runs NODE_ENV=production with fakes);
    // secrets are required and never echoed.
    const prod = { ...env, APP_STAGE: 'prod' };
    expect(() => loadWorkerConfig({ ...prod, EMAIL_PROVIDER: 'fake' })).toThrow(/fake/);
    expect(() => loadWorkerConfig({ ...prod, PAYMENT_GATEWAY: 'fake' })).toThrow(/fake/);
    expect(() => loadWorkerConfig({ ...env, EMAIL_FROM_ADDRESS: undefined })).toThrow(
      /EMAIL_FROM_ADDRESS/,
    );
    let message = '';
    try {
      loadWorkerConfig({ ...env, PAYMENT_OMISE_SECRET_KEY: 'short-secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/PAYMENT_OMISE_SECRET_KEY/);
    expect(message).not.toContain('short-secret');
  });

  it('rejects inconsistent worker settings without echoing values', () => {
    expect(() =>
      loadWorkerSettings({ WORKER_MEDIA_BATCH_SIZE: '1', WORKER_MEDIA_CONCURRENCY: '2' }),
    ).toThrow(/WORKER_MEDIA_CONCURRENCY/);
    expect(() => loadWorkerSettings({ WORKER_EXIF_DEFAULT_UTC_OFFSET: 'Asia/Bangkok' })).toThrow(
      /\+07:00/,
    );
    expect(() => loadWorkerConfig({ ...env, WORKER_EXIF_DEFAULT_UTC_OFFSET: 'x' })).toThrow();
    expect(() => loadWorkerConfig({ ...env, MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '2' })).toThrow(
      /heartbeats/,
    );
  });
});

describe('worker config on BullMQ', () => {
  /** The VPS: no queue URLs or visibility timeouts, QUEUE_BACKEND=bullmq. */
  const vps = Object.fromEntries(
    Object.entries({ ...env, QUEUE_BACKEND: 'bullmq' }).filter(
      ([key]) => !key.endsWith('_QUEUE_URL') && !key.endsWith('_VISIBILITY_TIMEOUT_SECONDS'),
    ),
  );

  it('reads the prefix, queue settings and schedules instead of SQS URLs', () => {
    const { queue } = loadWorkerConfig(vps);
    if (queue.backend !== 'bullmq') throw new Error('expected bullmq');
    expect(queue.prefix).toBe('shotx:staging:bull');
    expect(queue.queues.faces).toEqual({
      attempts: 5,
      backoffDelayMs: 10_000,
      lockDurationMs: 900_000,
      maxStalledCount: 1,
      removeOnFailCount: 10_000,
      removeOnFailAgeSeconds: 1_209_600,
      removeOnCompleteCount: 1_000,
      removeOnCompleteAgeSeconds: 86_400,
      eventsMaxLen: 10_000,
    });
    expect(queue.schedules.timezone).toBe('Asia/Bangkok');
    expect(queue.schedules.jobs['trash.purge.daily']).toEqual({
      cron: '30 1 * * *',
      enabled: true,
    });
    const off = loadWorkerConfig({ ...vps, SCHEDULE_TRASH_PURGE_DAILY_ENABLED: 'false' }).queue;
    expect(off.backend === 'bullmq' && off.schedules.jobs['trash.purge.daily'].enabled).toBe(false);
    expect(() => loadWorkerConfig({ ...vps, SCHEDULE_TRASH_PURGE_DAILY_CRON: 'daily' })).toThrow(
      /SCHEDULE_TRASH_PURGE_DAILY_CRON/,
    );
  });

  it('checks the faces budget against the lock renewal, without the 12 h SQS cap', () => {
    const config = loadWorkerConfig(vps);
    if (config.queue.backend !== 'bullmq') throw new Error('expected bullmq');
    const hold = {
      backend: 'bullmq' as const,
      lockDurationMs: config.queue.queues.faces.lockDurationMs,
    };
    const budget = checkFacesBudget(config.face, config.worker.maxProcessingMs.faces, hold);
    expect(budget.problems).toEqual([]);
    expect(budget.heartbeatIntervalMs).toBe(450_000);
    const thirteenHours = 13 * 3_600_000;
    expect(checkFacesBudget(config.face, thirteenHours, hold).problems).toEqual([]);
    expect(
      checkFacesBudget(config.face, thirteenHours, {
        backend: 'sqs',
        visibilityTimeoutSeconds: 900,
      }).problems,
    ).toEqual(['WORKER_FACES_MAX_PROCESSING_SECONDS is longer than heartbeats can hold (12 h)']);
  });
});

describe('worker config with R2 storage', () => {
  it('reads an explicit storage endpoint and keys, separate from AWS_ENDPOINT_URL', () => {
    const config = loadWorkerConfig({
      ...env,
      STORAGE_ENDPOINT_URL: 'https://0123456789abcdef.r2.cloudflarestorage.com',
      STORAGE_REGION: 'auto',
      STORAGE_ACCESS_KEY_ID: 'worker-key',
      STORAGE_SECRET_ACCESS_KEY: 'worker-secret',
      STORAGE_ORIGINALS_CLASS: 'STANDARD',
    });
    const options = storageS3ClientOptions(config.storage);
    expect(options).toMatchObject({
      region: 'auto',
      endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'worker-key', secretAccessKey: 'worker-secret' },
    });
    // Without STORAGE_ENDPOINT_URL storage stays on AWS S3 with the default chain.
    expect(storageS3ClientOptions(loadWorkerConfig(env).storage)).toMatchObject({
      region: 'ap-southeast-1',
    });
    expect(storageS3ClientOptions(loadWorkerConfig(env).storage)).not.toHaveProperty('credentials');
    expect(config.worker.sweeps.media.maxRequeues).toBe(3);
    expect(config.retention.authSessionRetentionDays).toBe(7);
  });
});

describe('faces time budget', () => {
  const sqsHold = (config: ReturnType<typeof loadWorkerConfig>) => {
    if (config.queue.backend !== 'sqs') throw new Error('expected sqs');
    return {
      backend: 'sqs' as const,
      visibilityTimeoutSeconds: config.queue.visibilityTimeoutSeconds.faces,
    };
  };

  it('fits the defaults: grace ≥ 2 × the worst attempt, processing cap above it, heartbeats', () => {
    const config = loadWorkerConfig(env);
    const budget = checkFacesBudget(
      config.face,
      config.worker.maxProcessingMs.faces,
      sqsHold(config),
    );
    expect(budget.problems).toEqual([]);
    // packages/face README: re-index worst case 8 × 342,600 ms.
    expect(budget.worstAttemptMs).toBe(2_740_800);
    expect(budget.heartbeatIntervalMs).toBe(300_000);
    expect(config.worker.maxProcessingMs.faces).toBeGreaterThan(budget.worstAttemptMs);
  });

  it('reports a grace or processing cap too short for the worst attempt', () => {
    const config = loadWorkerConfig({
      ...env,
      FACE_ORPHAN_GRACE_MS: '3600000',
      WORKER_FACES_MAX_PROCESSING_SECONDS: '600',
    });
    const { problems } = checkFacesBudget(
      config.face,
      config.worker.maxProcessingMs.faces,
      sqsHold(config),
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/FACE_ORPHAN_GRACE_MS/);
    expect(problems[1]).toMatch(/WORKER_FACES_MAX_PROCESSING_SECONDS/);
  });
});

describe('logger', () => {
  it('writes one JSON object per line and scrubs original keys from errors', () => {
    const lines: string[] = [];
    const log = createJsonLogger({
      write: (l) => lines.push(l),
      now: () => 0,
      base: { service: 'worker' },
    });
    log
      .child({ fileId: 'f' })
      .warn('x', errorFields(new Error('failed for originals/p/f/สมชาย.jpg now')));
    log.debug('hidden');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      level: 'warn',
      msg: 'x',
      service: 'worker',
      fileId: 'f',
      errorName: 'Error',
      errorMessage: 'failed for originals/<redacted> now',
    });
  });
});
