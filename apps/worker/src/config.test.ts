import { describe, expect, it } from 'vitest';
import { loadWorkerConfig, loadWorkerRuntimeConfig } from './config';
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
    expect(config.visibilityTimeoutSeconds).toEqual({ media: 300, jobs: 900 });
    expect(config.queueUrls.faces).toBe(env.FACES_QUEUE_URL);
    expect(config.media.web).toEqual({ longEdge: 2560, jpegQuality: 85 });
    expect(config.retention.trashRetentionDays).toBe(30);
    expect(config.worker.consumers.media).toEqual({ batchSize: 4, concurrency: 2 });
    expect(config.worker.mediaMaxProcessingMs).toBeLessThan(12 * 3600 * 1000);
  });

  it('rejects inconsistent worker settings without echoing values', () => {
    expect(() =>
      loadWorkerRuntimeConfig({ WORKER_MEDIA_BATCH_SIZE: '1', WORKER_MEDIA_CONCURRENCY: '2' }),
    ).toThrow(/WORKER_MEDIA_CONCURRENCY/);
    expect(() =>
      loadWorkerRuntimeConfig({ WORKER_EXIF_DEFAULT_UTC_OFFSET: 'Asia/Bangkok' }),
    ).toThrow(/\+07:00/);
    expect(() => loadWorkerConfig({ ...env, MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '2' })).toThrow(
      /heartbeats/,
    );
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
