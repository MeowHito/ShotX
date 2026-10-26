import { describe, expect, it } from 'vitest';
import { WEB_AUTH_CALLBACK_PATH } from '../api/auth';
import { AUTH_AUDIT_ACTION_PREFIX, AUTH_AUDIT_ACTIONS } from '../domain';
import { isPrivateHost } from './ip';
import {
  BULLMQ_PRODUCER_REDIS_OPTIONS,
  BULLMQ_REDIS_OPTIONS,
  bullMqJobOptions,
  bullMqProducerRedisOptions,
  bullMqQueueOptions,
  bullMqRedisOptions,
  bullMqWorkerOptions,
  loadQueueBackendConfig,
} from './queues';
import { loadRedisConfig } from './redis';
import { loadWorkerSettings } from './worker';

const credentials = { REDIS_USERNAME: 'shotx-app', REDIS_PASSWORD: 'secret-password' };

describe('loadRedisConfig with plain-text auth (VPS compose)', () => {
  it('refuses credentials over redis:// by default', () => {
    expect(() => loadRedisConfig({ REDIS_URL: 'redis://redis:6379', ...credentials })).toThrow(
      /must use rediss:\/\//,
    );
  });

  it('allows them with REDIS_ALLOW_PLAINTEXT_AUTH=true for a private host', () => {
    for (const url of [
      'redis://redis:6379',
      'redis://shotx-redis:6379/0',
      'redis://localhost:6379',
      'redis://172.18.0.4:6379',
      'redis://10.0.0.5',
      'redis://192.168.1.2',
      'redis://[fd00::4]:6379',
    ]) {
      expect(
        loadRedisConfig({ REDIS_URL: url, ...credentials, REDIS_ALLOW_PLAINTEXT_AUTH: 'true' }),
        url,
      ).toEqual({
        url,
        tls: false,
        credentials: { username: 'shotx-app', password: 'secret-password' },
      });
    }
  });

  it('refuses them for public hosts even with the flag', () => {
    for (const url of [
      'redis://master.shotx.cache.amazonaws.com:6379',
      'redis://redis.example.com',
      'redis://203.0.113.10:6379',
      'redis://[2001:db8::1]:6379',
    ]) {
      expect(
        () =>
          loadRedisConfig({ REDIS_URL: url, ...credentials, REDIS_ALLOW_PLAINTEXT_AUTH: 'true' }),
        url,
      ).toThrow(/needs a private REDIS_URL host/);
    }
  });

  it('keeps rediss:// and no-auth setups as they were, and never echoes the password', () => {
    expect(
      loadRedisConfig({
        REDIS_URL: 'rediss://master.shotx.cache.amazonaws.com:6379',
        ...credentials,
        REDIS_ALLOW_PLAINTEXT_AUTH: 'true',
      }).tls,
    ).toBe(true);
    expect(
      loadRedisConfig({ REDIS_URL: 'redis://redis:6379', REDIS_ALLOW_PLAINTEXT_AUTH: 'true' })
        .credentials,
    ).toBeNull();
    try {
      loadRedisConfig({ REDIS_URL: 'redis://redis.example.com', ...credentials });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('secret-password');
    }
    expect(() =>
      loadRedisConfig({ REDIS_URL: 'redis://redis', REDIS_ALLOW_PLAINTEXT_AUTH: 'maybe' }),
    ).toThrow(/REDIS_ALLOW_PLAINTEXT_AUTH/);
  });
});

describe('isPrivateHost', () => {
  it('knows private, loopback and single-label hosts', () => {
    for (const host of ['redis', 'localhost', 'api.localhost', '127.0.0.1', '::1', 'fe80::1']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['', 'redis.', 'a.b', '172.32.0.1', '100.64.0.1', '8.8.8.8', '-x']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe('loadWorkerSettings and QUEUE_BACKEND', () => {
  const env = { WORKER_ZIP_BATCH_SIZE: '1', WORKER_ZIP_CONCURRENCY: '4' };

  it('keeps concurrency <= batch size with SQS only', () => {
    expect(() => loadWorkerSettings(env)).toThrow(/WORKER_ZIP_CONCURRENCY must be at most/);
    expect(loadWorkerSettings({ ...env, QUEUE_BACKEND: 'bullmq' }).consumers.zip).toEqual({
      batchSize: 1,
      concurrency: 4,
    });
  });
});

describe('BullMQ option helpers', () => {
  const config = loadQueueBackendConfig({ QUEUE_BACKEND: 'bullmq', APP_STAGE: 'prod' }, ['faces']);
  if (config.backend !== 'bullmq') throw new Error('expected bullmq');
  const faces = config.queues.faces;

  it('builds job, queue and worker options from the queue settings', () => {
    expect(bullMqJobOptions(faces)).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { count: 1_000, age: 86_400 },
      removeOnFail: { count: 10_000, age: 1_209_600 },
    });
    expect(bullMqQueueOptions(faces, config.prefix)).toEqual({
      prefix: 'shotx:prod:bull',
      skipVersionCheck: true,
      streams: { events: { maxLen: 10_000 } },
    });
    expect(bullMqWorkerOptions(faces, config.prefix, 2)).toEqual({
      prefix: 'shotx:prod:bull',
      skipVersionCheck: true,
      concurrency: 2,
      lockDuration: 900_000,
      maxStalledCount: 1,
    });
    expect(() => bullMqWorkerOptions(faces, config.prefix, 0)).toThrow(RangeError);
  });

  it('gives BullMQ connections no retries limit, no ready check and the credentials', () => {
    expect(BULLMQ_REDIS_OPTIONS).toEqual({ maxRetriesPerRequest: null, enableReadyCheck: false });
    expect(
      bullMqRedisOptions({ url: 'redis://redis:6379', tls: false, credentials: null }),
    ).toEqual({ maxRetriesPerRequest: null, enableReadyCheck: false });
    expect(
      bullMqRedisOptions({
        url: 'rediss://r:6379',
        tls: true,
        credentials: { username: 'u', password: 'p' },
      }),
    ).toEqual({
      username: 'u',
      password: 'p',
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  });
});

describe('BullMQ producer connection (api)', () => {
  it('fails fast: finite retries, no offline queue, no ready check', () => {
    expect(BULLMQ_PRODUCER_REDIS_OPTIONS).toEqual({
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: false,
    });
    expect(
      bullMqProducerRedisOptions({
        url: 'redis://redis:6379',
        tls: false,
        credentials: { username: 'u', password: 'p' },
      }),
    ).toEqual({
      username: 'u',
      password: 'p',
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      enableReadyCheck: false,
    });
    // The worker's connections keep waiting through reconnects (BullMQ needs null there).
    expect(BULLMQ_REDIS_OPTIONS.maxRetriesPerRequest).toBeNull();
  });
});

describe('auth contract additions', () => {
  it('exports the web callback path', () => {
    expect(WEB_AUTH_CALLBACK_PATH).toBe('/auth/callback');
  });

  it('has the operator CLI audit actions, all under the actor-less auth. prefix', () => {
    expect(AUTH_AUDIT_ACTIONS).toEqual(
      expect.arrayContaining([
        'auth.admin.created',
        'auth.admin.totp_reset',
        'auth.admin.password_reset',
        'auth.admin.unlocked',
      ]),
    );
    for (const action of AUTH_AUDIT_ACTIONS) {
      expect(action.startsWith(AUTH_AUDIT_ACTION_PREFIX)).toBe(true);
    }
    expect(new Set(AUTH_AUDIT_ACTIONS).size).toBe(AUTH_AUDIT_ACTIONS.length);
  });
});
