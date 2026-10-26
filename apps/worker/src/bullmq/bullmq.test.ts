import {
  bullMqJobOptions,
  QueueMessageError,
  SCHEDULED_JOB_DEFAULTS,
  SCHEDULED_JOB_TYPES,
  type ScheduledJobsConfig,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { memoryLogger } from '../logger';
import { jobReceiveCount } from './consumer';
import { storableError } from './options';
import { jobMessageBody, schedulerRunSlot, syncJobSchedulers } from './schedules';

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

describe('jobMessageBody', () => {
  it('passes the serialized message of sent jobs through unchanged', () => {
    const body = JSON.stringify({ type: 'index.file', fileId: 'x' });
    expect(jobMessageBody('faces', { id: '7', name: 'faces.index.file', data: body })).toBe(body);
  });

  it('builds a scheduler run from the job name and the slot in the job id', () => {
    // 2026-10-25T18:30:00Z, the 01:30 Bangkok run.
    const job = {
      id: 'repeat:trash.purge.daily:1792953000000',
      name: 'trash.purge.daily',
      data: {},
    };
    expect(schedulerRunSlot(job)).toBe(1_792_953_000_000);
    expect(JSON.parse(jobMessageBody('jobs', job))).toEqual({
      type: 'trash.purge.daily',
      scheduledTime: '2026-10-25T18:30:00Z',
    });
    // Two slots of one scheduler give two runs.
    const next = { ...job, id: 'repeat:trash.purge.daily:1793039400000' };
    expect(jobMessageBody('jobs', next)).not.toBe(jobMessageBody('jobs', job));
  });

  it('refuses jobs without a message: QueueMessageError, so they fail without retries', () => {
    const cases: Array<
      [Parameters<typeof jobMessageBody>[0], Parameters<typeof jobMessageBody>[1]]
    > = [
      ['faces', { id: '1', name: 'faces.index.file', data: { fileId: 'x' } }],
      // A scheduler job on another queue, or with a name that isn't its scheduler's type.
      ['media', { id: 'repeat:trash.purge.daily:1', name: 'trash.purge.daily', data: {} }],
      ['jobs', { id: 'repeat:trash.purge.daily:1', name: 'faces.expire.daily', data: {} }],
      ['jobs', { id: 'repeat:unknown.job:1', name: 'unknown.job', data: {} }],
      ['jobs', { id: '12', name: 'trash.purge.daily', data: undefined }],
    ];
    for (const [queue, job] of cases) {
      expect(() => jobMessageBody(queue, job)).toThrow(QueueMessageError);
    }
  });
});

describe('BullMQ helpers', () => {
  it('stores only the error name and a scrubbed message in Redis', () => {
    const error = new TypeError('cannot read originals/p/f/สมชาย.jpg');
    const stored = storableError(error);
    expect(stored.name).toBe('TypeError');
    expect(stored.message).toBe('cannot read originals/<redacted>');
    expect(stored.stack).toBe('TypeError: cannot read originals/<redacted>');
    expect(storableError('boom').message).toBe('string');
  });

  it('counts deliveries like SQS: failed attempts and restarts after a stall or release', () => {
    expect(jobReceiveCount({ attemptsMade: 0, attemptsStarted: 1 })).toBe(1);
    expect(jobReceiveCount({ attemptsMade: 1, attemptsStarted: 2 })).toBe(2);
    // Stalled or handed back on shutdown: started again without a failed attempt.
    expect(jobReceiveCount({ attemptsMade: 0, attemptsStarted: 2 })).toBe(2);
    expect(jobReceiveCount({ attemptsMade: 0, attemptsStarted: 0 })).toBe(1);
  });
});

describe('syncJobSchedulers', () => {
  it('upserts enabled types with cron and time zone, removes disabled and unknown ones', async () => {
    const calls: unknown[][] = [];
    const queue = {
      upsertJobScheduler: (...args: unknown[]) => {
        calls.push(['upsert', ...args]);
        return Promise.resolve({} as never);
      },
      removeJobScheduler: (id: string) => {
        calls.push(['remove', id]);
        return Promise.resolve(id !== 'faces.reconcile.daily');
      },
      getJobSchedulers: () =>
        Promise.resolve([{ key: 'trash.purge.daily' }, { key: 'old.job' }] as never),
    };
    const schedules: ScheduledJobsConfig = {
      timezone: 'Asia/Bangkok',
      jobs: {
        ...SCHEDULED_JOB_DEFAULTS.jobs,
        'faces.expire.daily': { cron: '0 2 * * *', enabled: false },
        'faces.reconcile.daily': { cron: '30 4 * * *', enabled: false },
      },
    };
    const result = await syncJobSchedulers(queue, schedules, SETTINGS, memoryLogger());
    expect(result.upserted).toHaveLength(SCHEDULED_JOB_TYPES.length - 2);
    expect(result.removed).toEqual(['faces.expire.daily', 'old.job']);
    expect(calls).toContainEqual([
      'upsert',
      'trash.purge.daily',
      { pattern: '30 1 * * *', tz: 'Asia/Bangkok' },
      { name: 'trash.purge.daily', opts: bullMqJobOptions(SETTINGS) },
    ]);
    // Templates carry no data: the run's message comes from its slot.
    for (const call of calls.filter((c) => c[0] === 'upsert')) {
      expect(call[3]).not.toHaveProperty('data');
    }
  });
});
