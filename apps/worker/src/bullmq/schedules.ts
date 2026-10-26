import {
  bullMqJobOptions,
  type BullMqQueueSettings,
  QueueMessageError,
  type QueueName,
  SCHEDULED_JOB_TYPES,
  scheduledJobMessage,
  scheduledJobSchedulerId,
  type ScheduledJobsConfig,
  type ScheduledJobType,
} from '@shotx/shared';
import type { Queue } from 'bullmq';
import type { Logger } from '../logger';

/** The fields of a BullMQ job that decide its message body. */
export interface JobLike {
  id?: string | undefined;
  name: string;
  data: unknown;
}

// Job ids of scheduler runs: `repeat:<schedulerId>:<slot millis>` (JobScheduler.getSchedulerNextJobId).
const SCHEDULER_JOB_ID = /^repeat:(.+):(\d+)$/;

function isScheduledJobType(value: string): value is ScheduledJobType {
  return (SCHEDULED_JOB_TYPES as readonly string[]).includes(value);
}

/**
 * The slot (epoch ms) a job scheduler planned this run for, from the job id BullMQ gives each
 * run; null for a job that no scheduler of a scheduled job type created.
 */
export function schedulerRunSlot(job: Pick<JobLike, 'id' | 'name'>): number | null {
  const match = SCHEDULER_JOB_ID.exec(job.id ?? '');
  if (match === null || !isScheduledJobType(job.name)) return null;
  if (match[1] !== scheduledJobSchedulerId(job.name)) return null;
  const slot = Number(match[2]);
  return Number.isSafeInteger(slot) ? slot : null;
}

/**
 * The message body a handler gets for a BullMQ job:
 * - jobs added by a sender (api or worker) carry the serialized message as their data;
 * - job scheduler runs on the `jobs` queue carry no data: the body is `{ type, scheduledTime }`
 *   built from the job name and the run's slot (ADR 0008 section 3), never from the clock, so
 *   retries of one run dedupe in the ledger and the next run doesn't.
 * Anything else can never be handled: QueueMessageError (failed without retries).
 */
export function jobMessageBody(queue: QueueName, job: JobLike): string {
  if (typeof job.data === 'string') return job.data;
  if (queue === 'jobs') {
    const slot = schedulerRunSlot(job);
    if (slot !== null && isScheduledJobType(job.name)) {
      return JSON.stringify(scheduledJobMessage(job.name, slot));
    }
  }
  throw new QueueMessageError(queue, 'job data is not a serialized queue message');
}

/**
 * Makes the `jobs` queue's job schedulers match the config: one per enabled SCHEDULED_JOB_TYPES
 * entry (upserted with its cron and time zone, the job type as name and no data), none for
 * disabled types or types this version doesn't know. Idempotent: every worker runs it at start-up,
 * and upserting an unchanged scheduler keeps its next run (same job id per slot).
 */
export async function syncJobSchedulers(
  queue: Pick<Queue, 'upsertJobScheduler' | 'removeJobScheduler' | 'getJobSchedulers'>,
  schedules: ScheduledJobsConfig,
  settings: BullMqQueueSettings,
  log: Logger,
): Promise<{ upserted: ScheduledJobType[]; removed: string[] }> {
  const upserted: ScheduledJobType[] = [];
  const removed: string[] = [];
  const opts = bullMqJobOptions(settings);
  for (const type of SCHEDULED_JOB_TYPES) {
    const schedule = schedules.jobs[type];
    const id = scheduledJobSchedulerId(type);
    if (schedule.enabled) {
      await queue.upsertJobScheduler(
        id,
        { pattern: schedule.cron, tz: schedules.timezone },
        { name: type, opts },
      );
      upserted.push(type);
    } else if (await queue.removeJobScheduler(id)) {
      removed.push(id);
    }
  }
  const known = new Set<string>(SCHEDULED_JOB_TYPES.map(scheduledJobSchedulerId));
  for (const scheduler of await queue.getJobSchedulers()) {
    if (!known.has(scheduler.key) && (await queue.removeJobScheduler(scheduler.key))) {
      removed.push(scheduler.key);
    }
  }
  log.info('job schedulers synced', {
    upserted: upserted.join(','),
    removed: removed.join(','),
    timezone: schedules.timezone,
  });
  return { upserted, removed };
}
