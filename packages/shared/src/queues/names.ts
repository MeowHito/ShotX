/**
 * SQS queues. Each has a dead-letter queue. `media` receives S3 ObjectCreated notifications for
 * `originals/`, `faces` and `zip` receive jobs from the API and worker, and `jobs` receives
 * EventBridge Scheduler messages. infra/lib/constants.ts mirrors this list.
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
 * Scheduled job types sent to the `jobs` queue as `{ "type": ..., "scheduledTime": ... }`.
 * This is the source of truth; infra/lib/constants.ts mirrors it for the EventBridge schedules.
 * SQS delivers at least once, so every job must be idempotent (dedupe on type + scheduledTime).
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
  /** Reconcile storage_usage against the objects in S3. */
  'quota.reconcile.nightly',
] as const;
export type ScheduledJobType = (typeof SCHEDULED_JOB_TYPES)[number];
