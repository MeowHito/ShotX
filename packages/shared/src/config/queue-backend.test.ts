import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BULLMQ_QUEUE_DEFAULTS,
  BULLMQ_QUEUE_ENV,
  bullMqPrefix,
  QUEUE_NAMES,
  QUEUE_URL_ENV,
  SCHEDULED_JOB_TYPES,
} from '../queues/names';
import { queueJobName, serializeQueueMessage, parseQueueMessage } from '../queues/index';
import { scheduledJobMessage, scheduledJobSchedulerId } from '../queues/jobs';
import { loadQueueBackendConfig } from './queues';
import {
  isCronExpression,
  loadScheduledJobsConfig,
  SCHEDULED_JOB_DEFAULTS,
  SCHEDULED_JOB_ENV,
} from './schedules';

const urls = Object.fromEntries(
  QUEUE_NAMES.map((q) => [QUEUE_URL_ENV[q], `http://localhost:4566/queue/x/000000000000/${q}`]),
);

describe('loadQueueBackendConfig', () => {
  it('defaults to sqs and reads the queue URLs', () => {
    expect(loadQueueBackendConfig(urls, ['faces', 'zip'])).toEqual({
      backend: 'sqs',
      enqueueTimeoutMs: 5_000,
      urls: {
        faces: 'http://localhost:4566/queue/x/000000000000/faces',
        zip: 'http://localhost:4566/queue/x/000000000000/zip',
      },
    });
    expect(() => loadQueueBackendConfig({}, ['media'])).toThrow(/MEDIA_QUEUE_URL/);
  });

  it('bullmq: no URLs needed, prefix from the stage, defaults equal to today', () => {
    const config = loadQueueBackendConfig(
      { QUEUE_BACKEND: 'bullmq', APP_STAGE: 'prod' },
      QUEUE_NAMES,
    );
    expect(config).toEqual({
      backend: 'bullmq',
      prefix: 'shotx:prod:bull',
      enqueueTimeoutMs: 5_000,
      queues: {
        media: {
          attempts: 5,
          backoffDelayMs: 10_000,
          lockDurationMs: 300_000,
          maxStalledCount: 1,
          removeOnFailCount: 10_000,
          removeOnFailAgeSeconds: 1_209_600,
          removeOnCompleteCount: 1_000,
          removeOnCompleteAgeSeconds: 86_400,
          eventsMaxLen: 10_000,
        },
        faces: {
          attempts: 5,
          backoffDelayMs: 10_000,
          lockDurationMs: 900_000,
          maxStalledCount: 1,
          removeOnFailCount: 10_000,
          removeOnFailAgeSeconds: 1_209_600,
          removeOnCompleteCount: 1_000,
          removeOnCompleteAgeSeconds: 86_400,
          eventsMaxLen: 10_000,
        },
        zip: {
          attempts: 3,
          backoffDelayMs: 10_000,
          lockDurationMs: 300_000,
          maxStalledCount: 1,
          removeOnFailCount: 10_000,
          removeOnFailAgeSeconds: 1_209_600,
          removeOnCompleteCount: 1_000,
          removeOnCompleteAgeSeconds: 86_400,
          eventsMaxLen: 10_000,
        },
        jobs: {
          attempts: 3,
          backoffDelayMs: 10_000,
          lockDurationMs: 900_000,
          maxStalledCount: 1,
          removeOnFailCount: 10_000,
          removeOnFailAgeSeconds: 1_209_600,
          removeOnCompleteCount: 1_000,
          removeOnCompleteAgeSeconds: 86_400,
          eventsMaxLen: 10_000,
        },
      },
    });
  });

  it('bullmq: reads per-queue overrides for the requested queues only', () => {
    const config = loadQueueBackendConfig(
      {
        QUEUE_BACKEND: 'bullmq',
        APP_STAGE: 'local',
        FACES_QUEUE_ATTEMPTS: '8',
        FACES_QUEUE_BACKOFF_BASE_SECONDS: '0',
        FACES_QUEUE_LOCK_DURATION_SECONDS: '60',
        FACES_QUEUE_MAX_STALLED_COUNT: '2',
        FACES_QUEUE_FAILED_RETENTION_COUNT: '50',
        FACES_QUEUE_COMPLETED_RETENTION_COUNT: '0',
        FACES_QUEUE_FAILED_RETENTION_SECONDS: '3600',
        FACES_QUEUE_COMPLETED_RETENTION_SECONDS: '60',
        QUEUE_ENQUEUE_TIMEOUT_MS: '2000',
        FACES_QUEUE_EVENTS_MAX_LEN: '500',
        MEDIA_QUEUE_ATTEMPTS: 'not read',
      },
      ['faces'],
    );
    expect(config).toEqual({
      backend: 'bullmq',
      prefix: 'shotx:local:bull',
      enqueueTimeoutMs: 2_000,
      queues: {
        faces: {
          attempts: 8,
          backoffDelayMs: 0,
          lockDurationMs: 60_000,
          maxStalledCount: 2,
          removeOnFailCount: 50,
          removeOnFailAgeSeconds: 3600,
          removeOnCompleteCount: 0,
          removeOnCompleteAgeSeconds: 60,
          eventsMaxLen: 500,
        },
      },
    });
  });

  it('bullmq: rejects invalid values and needs APP_STAGE', () => {
    const base = { QUEUE_BACKEND: 'bullmq', APP_STAGE: 'prod' };
    for (const [key, value] of [
      ['ZIP_QUEUE_ATTEMPTS', '0'],
      ['ZIP_QUEUE_LOCK_DURATION_SECONDS', '10'],
      ['ZIP_QUEUE_FAILED_RETENTION_COUNT', '0'],
      ['ZIP_QUEUE_MAX_STALLED_COUNT', '-1'],
    ]) {
      expect(
        () => loadQueueBackendConfig({ ...base, [key as string]: value }, ['zip']),
        key,
      ).toThrow(key);
    }
    expect(() => loadQueueBackendConfig({ QUEUE_BACKEND: 'bullmq' }, ['zip'])).toThrow(/APP_STAGE/);
    expect(() => loadQueueBackendConfig({ QUEUE_BACKEND: 'rabbit' }, ['zip'])).toThrow(
      /QUEUE_BACKEND/,
    );
  });

  it('validates BullMQ settings and the enqueue timeout with sqs too', () => {
    expect(() => loadQueueBackendConfig({ ...urls, FACES_QUEUE_ATTEMPTS: '0' }, ['faces'])).toThrow(
      /FACES_QUEUE_ATTEMPTS/,
    );
    expect(() =>
      loadQueueBackendConfig({ ...urls, ZIP_QUEUE_FAILED_RETENTION_SECONDS: '10' }, ['zip']),
    ).toThrow(/ZIP_QUEUE_FAILED_RETENTION_SECONDS/);
    expect(() =>
      loadQueueBackendConfig({ ...urls, QUEUE_ENQUEUE_TIMEOUT_MS: '10' }, ['zip']),
    ).toThrow(/QUEUE_ENQUEUE_TIMEOUT_MS/);
  });

  it('names every BullMQ variable after its queue', () => {
    for (const q of QUEUE_NAMES) {
      for (const name of Object.values(BULLMQ_QUEUE_ENV[q])) {
        expect(name.startsWith(`${q.toUpperCase()}_QUEUE_`)).toBe(true);
      }
    }
  });
});

describe('bullMqPrefix', () => {
  it('is shotx:<stage>:bull and rejects bad stages', () => {
    expect(bullMqPrefix('staging')).toBe('shotx:staging:bull');
    expect(() => bullMqPrefix('Prod')).toThrow(RangeError);
    expect(() => bullMqPrefix('a:b')).toThrow(RangeError);
  });
});

describe('queueJobName', () => {
  const fileId = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';
  it('names jobs by queue and message type', () => {
    expect(queueJobName('faces', { type: 'index.file', fileId })).toBe('faces.index.file');
    expect(queueJobName('zip', { type: 'zip.create', jobId: fileId })).toBe('zip.create');
    expect(
      queueJobName('jobs', { type: 'trash.purge.daily', scheduledTime: '2026-10-25T18:30:00Z' }),
    ).toBe('trash.purge.daily');
    expect(
      queueJobName('media', {
        Service: 'Amazon S3',
        Event: 's3:TestEvent',
        Time: '2026-10-25T05:12:31.123Z',
        Bucket: 'b',
      }),
    ).toBe('media.s3-test-event');
  });
});

describe('scheduledJobMessage', () => {
  it('builds the message from the type and the run slot, in whole seconds', () => {
    const slot = Date.UTC(2026, 9, 25, 18, 5, 0, 0);
    const message = scheduledJobMessage('stats.rollup.hourly', slot);
    expect(message).toEqual({ type: 'stats.rollup.hourly', scheduledTime: '2026-10-25T18:05:00Z' });
    // Retries of one run (same slot) dedupe; jitter below a second does not change the key.
    expect(scheduledJobMessage('stats.rollup.hourly', new Date(slot + 999))).toEqual(message);
    expect(parseQueueMessage('jobs', serializeQueueMessage('jobs', message))).toEqual(message);
  });

  it('rejects unknown types and invalid slots', () => {
    expect(() => scheduledJobMessage('nope' as never, Date.now())).toThrow(RangeError);
    expect(() => scheduledJobMessage('trash.purge.daily', Number.NaN)).toThrow(RangeError);
    expect(() => scheduledJobMessage('trash.purge.daily', new Date('x'))).toThrow(RangeError);
  });

  it('uses the job type as the scheduler id', () => {
    for (const type of SCHEDULED_JOB_TYPES) expect(scheduledJobSchedulerId(type)).toBe(type);
  });
});

describe('isCronExpression', () => {
  it('accepts five-field numeric cron', () => {
    for (const ok of ['5 * * * *', '0 1 * * *', '*/15 * * * *', '0,30 1-3 * * 1-5', '0 0 1 1 7']) {
      expect(isCronExpression(ok), ok).toBe(true);
    }
  });

  it('rejects EventBridge syntax, seconds, names and out-of-range values', () => {
    for (const bad of [
      'cron(5 * * * ? *)',
      '5 * * * ? *',
      '5 * * * ?',
      '0 5 * * * *',
      '0 0 * * MON',
      '60 * * * *',
      '0 24 * * *',
      '0 0 0 * *',
      '0 0 * 13 *',
      '5-1 * * * *',
      '*/0 * * * *',
      '',
    ]) {
      expect(isCronExpression(bad), bad).toBe(false);
    }
  });
});

describe('loadScheduledJobsConfig', () => {
  it('defaults to Asia/Bangkok and every job on', () => {
    expect(loadScheduledJobsConfig({})).toEqual(SCHEDULED_JOB_DEFAULTS);
  });

  it('reads overrides and switches', () => {
    const config = loadScheduledJobsConfig({
      SCHEDULE_TIMEZONE: 'UTC',
      SCHEDULE_TRASH_PURGE_DAILY_CRON: '  15   2 * * * ',
      SCHEDULE_FACES_RECONCILE_DAILY_ENABLED: 'false',
    });
    expect(config.timezone).toBe('UTC');
    expect(config.jobs['trash.purge.daily']).toEqual({ cron: '15 2 * * *', enabled: true });
    expect(config.jobs['faces.reconcile.daily'].enabled).toBe(false);
  });

  it('rejects invalid cron and time zones', () => {
    expect(() =>
      loadScheduledJobsConfig({ SCHEDULE_STATS_ROLLUP_HOURLY_CRON: 'cron(5 * * * ? *)' }),
    ).toThrow(/SCHEDULE_STATS_ROLLUP_HOURLY_CRON/);
    expect(() => loadScheduledJobsConfig({ SCHEDULE_TIMEZONE: 'Mars/Base' })).toThrow(
      /SCHEDULE_TIMEZONE/,
    );
  });

  it('has an env pair for every scheduled job type', () => {
    expect(Object.keys(SCHEDULED_JOB_ENV).sort()).toEqual([...SCHEDULED_JOB_TYPES].sort());
    expect(Object.keys(SCHEDULED_JOB_DEFAULTS.jobs).sort()).toEqual(
      [...SCHEDULED_JOB_TYPES].sort(),
    );
  });
});

/**
 * EventBridge `cron(minutes hours day-of-month month day-of-week year)` as five-field cron:
 * drop the year and turn `?` (no specific value) into `*`. Day-of-week names and numbers differ
 * between the two (EventBridge 1-7 = SUN-SAT, cron 0-7 = SUN..SUN), so a numeric day-of-week is
 * shifted by one; `L`, `W` and `#` have no five-field equivalent and fail the comparison.
 */
function eventBridgeToCron(expression: string): string {
  const match = /^cron\((.+)\)$/.exec(expression.trim());
  if (match?.[1] === undefined)
    throw new Error(`not an EventBridge cron expression: ${expression}`);
  const fields = match[1].trim().split(/\s+/);
  if (fields.length !== 6) throw new Error(`EventBridge cron needs 6 fields: ${expression}`);
  const [minute, hour, dom, month, dow] = fields.map((f) => (f === '?' ? '*' : f)) as [
    string,
    string,
    string,
    string,
    string,
  ];
  const cronDow = dow.replace(/\d+/g, (d) => String(Number(d) - 1));
  return [minute, hour, dom, month, cronDow].join(' ');
}

const CDK_JSON = new URL('../../../../infra/cdk.json', import.meta.url);

// infra/ is removed after the VPS stack runs (ADR 0008); then the shared defaults stand alone.
describe.skipIf(!existsSync(CDK_JSON))('defaults match infra/cdk.json while infra/ exists', () => {
  const shotx = (
    JSON.parse(readFileSync(CDK_JSON, 'utf8')) as {
      context: {
        shotx: {
          schedules: {
            timezone: string;
            jobs: Record<string, { expression: string; enabled: boolean }>;
          };
          queues: Record<string, { maxReceiveCount: number; visibilityTimeoutSeconds: number }>;
        };
      };
    }
  ).context.shotx;

  it('translates EventBridge cron correctly', () => {
    expect(eventBridgeToCron('cron(5 * * * ? *)')).toBe('5 * * * *');
    expect(eventBridgeToCron('cron(0 1 ? * 2-6 *)')).toBe('0 1 * * 1-5');
    expect(eventBridgeToCron('cron(30 3 1 * ? 2026)')).toBe('30 3 1 * *');
  });

  it('schedules: same time zone, cron and switches', () => {
    expect(SCHEDULED_JOB_DEFAULTS.timezone).toBe(shotx.schedules.timezone);
    expect(Object.keys(shotx.schedules.jobs).sort()).toEqual([...SCHEDULED_JOB_TYPES].sort());
    for (const type of SCHEDULED_JOB_TYPES) {
      const job = shotx.schedules.jobs[type];
      expect(SCHEDULED_JOB_DEFAULTS.jobs[type], type).toEqual({
        cron: eventBridgeToCron(job?.expression ?? ''),
        enabled: job?.enabled,
      });
      expect(isCronExpression(SCHEDULED_JOB_DEFAULTS.jobs[type].cron)).toBe(true);
    }
  });

  it('queues: attempts are maxReceiveCount, lock durations the visibility timeouts', () => {
    for (const q of QUEUE_NAMES) {
      expect(BULLMQ_QUEUE_DEFAULTS[q].attempts, q).toBe(shotx.queues[q]?.maxReceiveCount);
      expect(BULLMQ_QUEUE_DEFAULTS[q].lockDurationSeconds, q).toBe(
        shotx.queues[q]?.visibilityTimeoutSeconds,
      );
    }
  });
});
