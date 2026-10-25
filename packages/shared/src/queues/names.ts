/**
 * SQS queues. Each has a dead-letter queue. `media` receives S3 ObjectCreated notifications for
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
 * Scheduled job types sent to the `jobs` queue as `{ "type": ..., "scheduledTime": ... }`.
 * This is the source of truth; infra imports it from @shotx/shared for the EventBridge schedules.
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
  /**
   * Delete orphaned faces: faces in a photographer's Rekognition collection that have no `faces`
   * row (left by failed indexing attempts) and stayed unknown for FACE_ORPHAN_GRACE_MS.
   */
  'faces.reconcile.daily',
  /** Reconcile storage_usage against the objects in S3. */
  'quota.reconcile.nightly',
] as const;
export type ScheduledJobType = (typeof SCHEDULED_JOB_TYPES)[number];
