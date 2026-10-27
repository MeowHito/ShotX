import {
  bullMqJobOptions,
  bullMqProducerRedisOptions,
  bullMqQueueOptions,
  type Env,
  loadQueueBackendConfig,
  loadRedisConfig,
  SCHEDULED_JOB_TYPES,
  type ScheduledJobType,
  scheduledJobMessage,
  serializeQueueMessage,
} from '@shotx/shared';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

// `ops run-job <type>`: runs one scheduled job now (restore runbook: quota and face
// reconciliations, sweeps). It adds a `jobs` message exactly as a sender does, with the current
// second as its scheduledTime, so the worker's ledger treats it as a new run.

export function parseJobType(value: string | undefined): ScheduledJobType {
  if (value === undefined || !(SCHEDULED_JOB_TYPES as readonly string[]).includes(value)) {
    throw new Error(`job type must be one of: ${SCHEDULED_JOB_TYPES.join(', ')}`);
  }
  return value as ScheduledJobType;
}

/** The serialized `jobs` message of a manual run. */
export function manualJobBody(type: ScheduledJobType, now: Date): string {
  return serializeQueueMessage('jobs', scheduledJobMessage(type, now));
}

export async function runJob(env: Env, type: ScheduledJobType, log: (line: string) => void) {
  const backend = loadQueueBackendConfig(env, ['jobs']);
  if (backend.backend !== 'bullmq') throw new Error('run-job needs QUEUE_BACKEND=bullmq');
  const redisConfig = loadRedisConfig(env);
  const connection = new Redis(redisConfig.url, bullMqProducerRedisOptions(redisConfig));
  const settings = backend.queues.jobs;
  const queue = new Queue('jobs', { connection, ...bullMqQueueOptions(settings, backend.prefix) });
  try {
    await queue.waitUntilReady();
    const job = await queue.add(type, manualJobBody(type, new Date()), bullMqJobOptions(settings));
    log(`queued ${type} as job ${job.id ?? '?'}`);
  } finally {
    await queue.close();
    connection.disconnect();
  }
}
