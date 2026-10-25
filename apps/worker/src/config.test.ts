import { describe, expect, it } from 'vitest';
import { loadWorkerSettings } from '@shotx/shared';
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
};

describe('worker config', () => {
  it('accepts what infra sets on the worker task', () => {
    const config = loadWorkerConfig(env);
    expect(config.visibilityTimeoutSeconds).toEqual({
      media: 300,
      faces: 900,
      zip: 300,
      jobs: 900,
    });
    expect(config.queueUrls.faces).toBe(env.FACES_QUEUE_URL);
    expect(config.queueUrls.zip).toBe(env.ZIP_QUEUE_URL);
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

describe('faces time budget', () => {
  it('fits the defaults: grace ≥ 2 × the worst attempt, processing cap above it, heartbeats', () => {
    const config = loadWorkerConfig(env);
    const budget = checkFacesBudget(
      config.face,
      config.worker.maxProcessingMs.faces,
      config.visibilityTimeoutSeconds.faces,
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
      config.visibilityTimeoutSeconds.faces,
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
