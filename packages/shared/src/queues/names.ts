/**
 * Queues (SQS or BullMQ, see QUEUE_BACKENDS). On SQS each has a dead-letter queue. `media` receives S3 ObjectCreated notifications for
 * `originals/`, `faces` and `zip` receive jobs from the API and worker, and `jobs` receives
 * EventBridge Scheduler messages. This is the source of truth; infra imports it from
 * @shotx/shared.
 */
export const QUEUE_NAMES = ['media', 'faces', 'zip', 'jobs'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/** Environment variable that holds each queue's URL (set by infra on the ECS tasks). */
export const QUEUE_URL_ENV = {
  media: 'MEDIA_QUEUE_URL',
  faces: 'FACES_QUEUE_URL',
  zip: 'ZIP_QUEUE_URL',
  jobs: 'JOBS_QUEUE_URL',
} as const satisfies Record<QueueName, string>;

/**
 * Environment variable that holds each queue's visibility timeout in seconds (set by infra on the
 * worker from `queues.<name>.visibilityTimeoutSeconds`). The worker heartbeats long jobs with
 * ChangeMessageVisibility before it runs out.
 */
export const QUEUE_VISIBILITY_TIMEOUT_ENV = {
  media: 'MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
  faces: 'FACES_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
  zip: 'ZIP_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
  jobs: 'JOBS_QUEUE_VISIBILITY_TIMEOUT_SECONDS',
} as const satisfies Record<QueueName, string>;

/** SQS's largest visibility timeout (12 hours). */
export const SQS_MAX_VISIBILITY_TIMEOUT_SECONDS = 43_200;

/**
 * Where the queues live (QUEUE_BACKEND, default `sqs`): `sqs` (AWS, with a DLQ per queue) or
 * `bullmq` (BullMQ on Redis, ADR 0008 section 3). One BullMQ queue per QueueName, with the same
 * name; job data is the string from serializeQueueMessage, parsed with parseQueueMessage.
 */
export const QUEUE_BACKENDS = ['sqs', 'bullmq'] as const;
export type QueueBackend = (typeof QUEUE_BACKENDS)[number];

/**
 * The `prefix` option of every BullMQ Queue, Worker and QueueEvents: `shotx:<stage>:bull`, under
 * the stage's `shotx:<stage>:` namespace (ADR 0005, ADR 0008). Give it to BullMQ's `prefix`,
 * never to ioredis `keyPrefix` (BullMQ's Lua scripts build keys from `prefix`).
 */
export function bullMqPrefix(stage: string): string {
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new RangeError('Invalid stage name');
  return `shotx:${stage}:bull`;
}

/** Environment variables of each queue's BullMQ settings (QUEUE_BACKEND=bullmq). */
export const BULLMQ_QUEUE_ENV = {
  media: {
    attempts: 'MEDIA_QUEUE_ATTEMPTS',
    backoffBaseSeconds: 'MEDIA_QUEUE_BACKOFF_BASE_SECONDS',
    lockDurationSeconds: 'MEDIA_QUEUE_LOCK_DURATION_SECONDS',
    maxStalledCount: 'MEDIA_QUEUE_MAX_STALLED_COUNT',
    failedRetentionCount: 'MEDIA_QUEUE_FAILED_RETENTION_COUNT',
    completedRetentionCount: 'MEDIA_QUEUE_COMPLETED_RETENTION_COUNT',
    completedRetentionSeconds: 'MEDIA_QUEUE_COMPLETED_RETENTION_SECONDS',
    failedRetentionSeconds: 'MEDIA_QUEUE_FAILED_RETENTION_SECONDS',
    eventsMaxLen: 'MEDIA_QUEUE_EVENTS_MAX_LEN',
  },
  faces: {
    attempts: 'FACES_QUEUE_ATTEMPTS',
    backoffBaseSeconds: 'FACES_QUEUE_BACKOFF_BASE_SECONDS',
    lockDurationSeconds: 'FACES_QUEUE_LOCK_DURATION_SECONDS',
    maxStalledCount: 'FACES_QUEUE_MAX_STALLED_COUNT',
    failedRetentionCount: 'FACES_QUEUE_FAILED_RETENTION_COUNT',
    completedRetentionCount: 'FACES_QUEUE_COMPLETED_RETENTION_COUNT',
    completedRetentionSeconds: 'FACES_QUEUE_COMPLETED_RETENTION_SECONDS',
    failedRetentionSeconds: 'FACES_QUEUE_FAILED_RETENTION_SECONDS',
    eventsMaxLen: 'FACES_QUEUE_EVENTS_MAX_LEN',
  },
  zip: {
    attempts: 'ZIP_QUEUE_ATTEMPTS',
    backoffBaseSeconds: 'ZIP_QUEUE_BACKOFF_BASE_SECONDS',
    lockDurationSeconds: 'ZIP_QUEUE_LOCK_DURATION_SECONDS',
    maxStalledCount: 'ZIP_QUEUE_MAX_STALLED_COUNT',
    failedRetentionCount: 'ZIP_QUEUE_FAILED_RETENTION_COUNT',
    completedRetentionCount: 'ZIP_QUEUE_COMPLETED_RETENTION_COUNT',
    completedRetentionSeconds: 'ZIP_QUEUE_COMPLETED_RETENTION_SECONDS',
    failedRetentionSeconds: 'ZIP_QUEUE_FAILED_RETENTION_SECONDS',
    eventsMaxLen: 'ZIP_QUEUE_EVENTS_MAX_LEN',
  },
  jobs: {
    attempts: 'JOBS_QUEUE_ATTEMPTS',
    backoffBaseSeconds: 'JOBS_QUEUE_BACKOFF_BASE_SECONDS',
    lockDurationSeconds: 'JOBS_QUEUE_LOCK_DURATION_SECONDS',
    maxStalledCount: 'JOBS_QUEUE_MAX_STALLED_COUNT',
    failedRetentionCount: 'JOBS_QUEUE_FAILED_RETENTION_COUNT',
    completedRetentionCount: 'JOBS_QUEUE_COMPLETED_RETENTION_COUNT',
    completedRetentionSeconds: 'JOBS_QUEUE_COMPLETED_RETENTION_SECONDS',
    failedRetentionSeconds: 'JOBS_QUEUE_FAILED_RETENTION_SECONDS',
    eventsMaxLen: 'JOBS_QUEUE_EVENTS_MAX_LEN',
  },
} as const satisfies Record<QueueName, Record<keyof BullMqQueueDefaults, string>>;

export interface BullMqQueueDefaults {
  /** Total attempts (first try included), as SQS maxReceiveCount. */
  attempts: number;
  /** Exponential backoff: attempt n waits base x 2^(n-1), as WORKER_RETRY_BASE_SECONDS on SQS. */
  backoffBaseSeconds: number;
  /** How long a crashed worker holds a job, as the SQS visibility timeout (renewed while running). */
  lockDurationSeconds: number;
  /** Stalls (lost locks) before the job fails; stalls don't count as attempts. */
  maxStalledCount: number;
  /** Failed jobs kept (the DLQ's role). BullMQ keys have no TTL: counts bound Redis memory. */
  failedRetentionCount: number;
  /** Completed jobs kept, for inspection only. */
  completedRetentionCount: number;
  /** Completed jobs older than this are removed too (whichever limit comes first). */
  completedRetentionSeconds: number;
  /** Failed jobs older than this are removed too: 14 days, the old DLQ retention. */
  failedRetentionSeconds: number;
  /** Approximate cap of the queue's event stream. */
  eventsMaxLen: number;
}

/**
 * Defaults of the BullMQ settings: attempts are infra/cdk.json `queues.<name>.maxReceiveCount`
 * and lock durations its `visibilityTimeoutSeconds` (checked by config/queue-backend.test.ts while infra/
 * exists); backoff base is WORKER_RETRY_BASE_SECONDS' default. maxStalledCount is BullMQ's
 * default: a job that stalls has usually crashed its worker, and repeating it would crash it
 * again. Failed jobs are kept 14 days (infra/cdk.json `dlqRetentionDays`), completed ones 1 day;
 * the counts are assumptions sized for small job payloads.
 */
export const BULLMQ_QUEUE_DEFAULTS = {
  media: {
    attempts: 5,
    backoffBaseSeconds: 10,
    lockDurationSeconds: 300,
    maxStalledCount: 1,
    failedRetentionCount: 10_000,
    completedRetentionCount: 1_000,
    completedRetentionSeconds: 86_400,
    failedRetentionSeconds: 1_209_600,
    eventsMaxLen: 10_000,
  },
  faces: {
    attempts: 5,
    backoffBaseSeconds: 10,
    lockDurationSeconds: 900,
    maxStalledCount: 1,
    failedRetentionCount: 10_000,
    completedRetentionCount: 1_000,
    completedRetentionSeconds: 86_400,
    failedRetentionSeconds: 1_209_600,
    eventsMaxLen: 10_000,
  },
  zip: {
    attempts: 3,
    backoffBaseSeconds: 10,
    lockDurationSeconds: 300,
    maxStalledCount: 1,
    failedRetentionCount: 10_000,
    completedRetentionCount: 1_000,
    completedRetentionSeconds: 86_400,
    failedRetentionSeconds: 1_209_600,
    eventsMaxLen: 10_000,
  },
  jobs: {
    attempts: 3,
    backoffBaseSeconds: 10,
    lockDurationSeconds: 900,
    maxStalledCount: 1,
    failedRetentionCount: 10_000,
    completedRetentionCount: 1_000,
    completedRetentionSeconds: 86_400,
    failedRetentionSeconds: 1_209_600,
    eventsMaxLen: 10_000,
  },
} as const satisfies Record<QueueName, BullMqQueueDefaults>;

/**
 * Scheduled job types, run through the `jobs` queue as `{ "type": ..., "scheduledTime": ... }`:
 * on SQS from EventBridge Scheduler (infra imports this list), on BullMQ from job schedulers
 * (config/schedules: SCHEDULED_JOB_DEFAULTS, scheduledJobMessage). Delivery is at least once, so
 * every job must be idempotent (dedupe on type + scheduledTime).
 */
export const SCHEDULED_JOB_TYPES = [
  /** Roll activity_events up into daily_stats; also keeps future activity_events partitions. */
  'stats.rollup.hourly',
  /** trial/active -> grace -> expired -> purged, and renewal reminders. */
  'subscriptions.transition.daily',
  /** Purge files trashed more than TRASH_RETENTION_DAYS ago. */
  'trash.purge.daily',
  /** Delete faces of folders past face_index_expires_at. */
  'faces.expire.daily',
  /**
   * Delete orphaned faces: faces in a photographer's Rekognition collection that have no `faces`
   * row (left by failed indexing attempts) and stayed unknown for FACE_ORPHAN_GRACE_MS.
   */
  'faces.reconcile.daily',
  /** Reconcile storage_usage against the objects in S3. */
  'quota.reconcile.nightly',
] as const;
export type ScheduledJobType = (typeof SCHEDULED_JOB_TYPES)[number];
