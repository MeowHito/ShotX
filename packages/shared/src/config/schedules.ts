import { z } from 'zod';
import { SCHEDULED_JOB_TYPES, type ScheduledJobType } from '../queues/names';
import { type Env, parseEnv } from './env';

// Scheduled jobs on BullMQ job schedulers (ADR 0008 section 3; ADR 0003 for the jobs). On AWS the
// same schedules are EventBridge schedules in infra/cdk.json `schedules`; the defaults below equal
// them (config/queue-backend.test.ts checks this while infra/ exists).

/** Time zone of every schedule (BullMQ `repeat.tz`). */
export const SCHEDULE_TIMEZONE_ENV = 'SCHEDULE_TIMEZONE';

/** Environment variables of each job's cron expression and on/off switch. */
export const SCHEDULED_JOB_ENV = {
  'stats.rollup.hourly': {
    cron: 'SCHEDULE_STATS_ROLLUP_HOURLY_CRON',
    enabled: 'SCHEDULE_STATS_ROLLUP_HOURLY_ENABLED',
  },
  'subscriptions.transition.daily': {
    cron: 'SCHEDULE_SUBSCRIPTIONS_TRANSITION_DAILY_CRON',
    enabled: 'SCHEDULE_SUBSCRIPTIONS_TRANSITION_DAILY_ENABLED',
  },
  'trash.purge.daily': {
    cron: 'SCHEDULE_TRASH_PURGE_DAILY_CRON',
    enabled: 'SCHEDULE_TRASH_PURGE_DAILY_ENABLED',
  },
  'faces.expire.daily': {
    cron: 'SCHEDULE_FACES_EXPIRE_DAILY_CRON',
    enabled: 'SCHEDULE_FACES_EXPIRE_DAILY_ENABLED',
  },
  'faces.reconcile.daily': {
    cron: 'SCHEDULE_FACES_RECONCILE_DAILY_CRON',
    enabled: 'SCHEDULE_FACES_RECONCILE_DAILY_ENABLED',
  },
  'quota.reconcile.nightly': {
    cron: 'SCHEDULE_QUOTA_RECONCILE_NIGHTLY_CRON',
    enabled: 'SCHEDULE_QUOTA_RECONCILE_NIGHTLY_ENABLED',
  },
  'media.sweep': {
    cron: 'SCHEDULE_MEDIA_SWEEP_CRON',
    enabled: 'SCHEDULE_MEDIA_SWEEP_ENABLED',
  },
  'faces.sweep': {
    cron: 'SCHEDULE_FACES_SWEEP_CRON',
    enabled: 'SCHEDULE_FACES_SWEEP_ENABLED',
  },
  'auth.sessions.purge.daily': {
    cron: 'SCHEDULE_AUTH_SESSIONS_PURGE_DAILY_CRON',
    enabled: 'SCHEDULE_AUTH_SESSIONS_PURGE_DAILY_ENABLED',
  },
} as const satisfies Record<ScheduledJobType, { cron: string; enabled: string }>;

export interface ScheduledJobSchedule {
  /** Five-field cron (minute hour day-of-month month day-of-week), cron-parser syntax. */
  cron: string;
  enabled: boolean;
}

/**
 * Defaults: Asia/Bangkok, and the cron expressions of infra/cdk.json translated from EventBridge
 * `cron(m h dom mon dow year)` to five fields (year dropped, `?` as `*`). The ADR 0008 types
 * (media.sweep, faces.sweep, auth.sessions.purge.daily) are scheduled on the AWS stacks too, as
 * `cron(7,22,37,52 * * * ? *)`, `cron(20 * * * ? *)` and `cron(0 5 * * ? *)`.
 */
export const SCHEDULED_JOB_DEFAULTS = {
  timezone: 'Asia/Bangkok',
  jobs: {
    'stats.rollup.hourly': { cron: '5 * * * *', enabled: true },
    'subscriptions.transition.daily': { cron: '0 1 * * *', enabled: true },
    'trash.purge.daily': { cron: '30 1 * * *', enabled: true },
    'faces.expire.daily': { cron: '0 2 * * *', enabled: true },
    'faces.reconcile.daily': { cron: '30 4 * * *', enabled: true },
    'quota.reconcile.nightly': { cron: '30 3 * * *', enabled: true },
    // ADR 0008 section 3. Every 15 minutes, off the hourly rollup's minute 5.
    'media.sweep': { cron: '7,22,37,52 * * * *', enabled: true },
    'faces.sweep': { cron: '20 * * * *', enabled: true },
    'auth.sessions.purge.daily': { cron: '0 5 * * *', enabled: true },
  },
} as const satisfies {
  timezone: string;
  jobs: Record<ScheduledJobType, ScheduledJobSchedule>;
};

// minute, hour, day of month, month, day of week (0 and 7 are Sunday).
const CRON_FIELD_RANGES: readonly (readonly [number, number])[] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function isCronField(field: string, [min, max]: readonly [number, number]): boolean {
  return field.split(',').every((item) => {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
    if (match === null) return false;
    const [, , from, to, step] = match;
    const inRange = (v: string | undefined) =>
      v === undefined || (Number(v) >= min && Number(v) <= max);
    if (!inRange(from) || !inRange(to)) return false;
    if (from !== undefined && to !== undefined && Number(from) > Number(to)) return false;
    return step === undefined || Number(step) >= 1;
  });
}

/**
 * True for a five-field cron expression of numbers, `*`, ranges, lists and steps (e.g.
 * `5 * * * *`, `0,30 1-3 * * 1-5`, `*\/15 * * * *`). No names, `?`, `L`, `W` or `#`, and no
 * seconds or year field: the common subset of cron-parser (BullMQ) and standard cron.
 */
export function isCronExpression(value: string): boolean {
  const fields = value.trim().split(/\s+/);
  return (
    fields.length === CRON_FIELD_RANGES.length &&
    fields.every((field, i) => isCronField(field, CRON_FIELD_RANGES[i] ?? [0, 0]))
  );
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const cron = z
  .string()
  .transform((value) => value.trim().split(/\s+/).join(' '))
  .refine(isCronExpression, { error: 'must be a five-field cron expression' });

const scheduleEnvSchema = z.object({
  [SCHEDULE_TIMEZONE_ENV]: z
    .string()
    .refine(isTimeZone, { error: 'must be an IANA time zone, e.g. Asia/Bangkok' })
    .default(SCHEDULED_JOB_DEFAULTS.timezone),
  ...Object.fromEntries(
    SCHEDULED_JOB_TYPES.flatMap((type) => [
      [SCHEDULED_JOB_ENV[type].cron, cron.default(SCHEDULED_JOB_DEFAULTS.jobs[type].cron)],
      [
        SCHEDULED_JOB_ENV[type].enabled,
        z.stringbool().default(SCHEDULED_JOB_DEFAULTS.jobs[type].enabled),
      ],
    ]),
  ),
});

export interface ScheduledJobsConfig {
  /** IANA time zone (BullMQ `repeat.tz`). */
  timezone: string;
  jobs: Record<ScheduledJobType, ScheduledJobSchedule>;
}

/**
 * Reads SCHEDULE_TIMEZONE (default Asia/Bangkok) and per job type SCHEDULE_<TYPE>_CRON and
 * SCHEDULE_<TYPE>_ENABLED (SCHEDULED_JOB_ENV; defaults SCHEDULED_JOB_DEFAULTS). Worker only, with
 * QUEUE_BACKEND=bullmq: it upserts one job scheduler per enabled type
 * (`upsertJobScheduler(scheduledJobSchedulerId(type), { pattern: cron, tz: timezone }, { name:
 * type })`) and removes the schedulers of disabled ones.
 */
export function loadScheduledJobsConfig(env: Env): ScheduledJobsConfig {
  const e = parseEnv(scheduleEnvSchema, env, 'schedule') as Record<string, string | boolean>;
  return {
    timezone: e[SCHEDULE_TIMEZONE_ENV] as string,
    jobs: Object.fromEntries(
      SCHEDULED_JOB_TYPES.map((type) => [
        type,
        {
          cron: e[SCHEDULED_JOB_ENV[type].cron] as string,
          enabled: e[SCHEDULED_JOB_ENV[type].enabled] as boolean,
        },
      ]),
    ) as Record<ScheduledJobType, ScheduledJobSchedule>,
  };
}
