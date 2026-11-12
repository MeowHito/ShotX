/**
 * Queues (SQS or BullMQ, see QUEUE_BACKENDS). On SQS each has a dead-letter queue. `media`
 * receives `original.completed` messages from the API and media.sweep, and on AWS also S3
 * ObjectCreated notifications for `originals/`; `faces` and `zip` receive jobs from the API and
 * worker, and `jobs` receives scheduled runs (EventBridge Scheduler on AWS, BullMQ job schedulers
 * on the VPS). This is the source of truth; infra imports it from @shotx/shared.
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
  /**
   * Purge files trashed more than TRASH_RETENTION_DAYS ago.
   *
   * Also the design image orphan purge (ADR 0013; in this job so no new schedule is needed). Per
   * owner, an asset is referenced when any of the owner's `share_designs` documents names it
   * (designDocAssetIds). For live assets (`purge_requested_at IS NULL`, not `uploading`):
   * referenced with `orphaned_at` set: clear it; unreferenced with `orphaned_at` null: set it to
   * now(); `orphaned_at` older than DESIGN_ASSET_ORPHAN_DAYS: purge. The purge locks the row
   * (`SELECT ... FOR UPDATE`), re-checks that no design references it in the same transaction,
   * sets `purge_requested_at` and subtracts `size_bytes` from its quota bucket; after commit it
   * deletes both objects (designAssetKeys) and then the row. Rows with `purge_requested_at` set
   * (a crash after commit) are finished on the next run. The api's write of a document locks the
   * referenced rows (`FOR KEY SHARE`) and treats purge-requested rows as missing, so a save and
   * the purge can't both win. Deleting a design never deletes its images.
   */
  'trash.purge.daily',
  /** Delete faces of folders past face_index_expires_at. */
  'faces.expire.daily',
  /**
   * Delete orphaned faces: faces in a photographer's Rekognition collection that have no `faces`
   * row (left by failed indexing attempts) and stayed unknown for FACE_ORPHAN_GRACE_MS.
   */
  'faces.reconcile.daily',
  /**
   * Reconcile storage_usage against the objects in S3. Design images count like originals (ADR
   * 0013): the `original` object under designs/{photographerId}/ of each asset that is not
   * purge-requested, in the bucket its `verified_at` says. Also expires abandoned design image
   * uploads: `uploading` rows past `upload_expires_at` become `failed` (reservation released in
   * the same guarded UPDATE) and their `original` object, if any, is deleted.
   */
  'quota.reconcile.nightly',
  /**
   * Restart lost media work (ADR 0008 section 3, "Lost jobs"; WorkerSettings.sweeps.media):
   * - `processing` rows (verified or not) whose pipeline was last started (`media_queued_at`, else
   *   `created_at`) more than MEDIA_SWEEP_PROCESSING_AGE_SECONDS ago and that were re-sent fewer
   *   than MEDIA_SWEEP_MAX_REQUEUES times: send `original.completed` again (`file.copy` for rows
   *   with `copied_from_file_id` set: copies of Wave 7), setting `media_queued_at = now()` and
   *   `media_requeues + 1` in the same guarded UPDATE first;
   * - `uploading` rows with `upload_id` set created more than MEDIA_SWEEP_UPLOADING_AGE_SECONDS
   *   ago whose multipart upload is gone (ListParts: NoSuchUpload) but whose object exists with
   *   exactly `size_bytes` (HeadObject): the API crashed between CompleteMultipartUpload and
   *   markCompleted. Complete them as markCompleted does (guarded by the upload id) and send
   *   `original.completed`. A live upload or a missing object is left alone.
   * The HeadObject recovery must also run in `quota.reconcile.nightly` before it expires an
   * abandoned upload (releasing the reservation and deleting the object), so a completed object
   * never becomes an orphan outside quota. Rows past the requeue cap are left as they are and
   * logged at error level for the operator. At most MEDIA_SWEEP_BATCH_SIZE rows per run.
   * - design images (ADR 0013): `processing` `design_assets` rows whose `queued_at` is older than
   *   MEDIA_SWEEP_PROCESSING_AGE_SECONDS and `requeues` below MEDIA_SWEEP_MAX_REQUEUES: send
   *   `design.asset` again, bumping both in the same guarded UPDATE first
   *   (`design_assets_processing_idx`).
   */
  'media.sweep',
  /**
   * Restart lost faces work (ADR 0008 section 3; WorkerSettings.sweeps.faces):
   * - `face_deletions` with `completed_at IS NULL` created more than
   *   FACES_SWEEP_DELETION_AGE_SECONDS ago: send `delete.faces` again, with no cap (a deletion asked
   *   for under PDPA must happen; nothing else would catch it, because the `faces` rows still
   *   exist), and log `face_deletion.alert` when one is older than a day;
   * - files with `faces_queued_at` older than FACES_SWEEP_INDEX_AGE_SECONDS and
   *   `faces_requeues` below FACES_SWEEP_MAX_REQUEUES: send `index.file` again (bumping both);
   *   withheld files are not re-sent (their mark is cleared instead, as index.file's `withheld`
   *   outcome does);
   * - folders with `face_index_queued_at` older than FACES_SWEEP_INDEX_AGE_SECONDS: send
   *   `index.folder` again (bumping it);
   * - coverage scan (catches files whose outbox mark was never set, e.g. rows from before
   *   migration 0006 or a lost fan-out): `ready` image files (`mime` image/*) with
   *   `face_count IS NULL`, `faces_queued_at IS NULL`, `deleted_at IS NULL`, `faces_withheld_at
   *   IS NULL` (migration 0009: a withheld file is never indexed), created more than
   *   FACES_SWEEP_INDEX_AGE_SECONDS ago, under an active face index (isCoveredByFaceIndex: a
   *   folder or ancestor with `face_index_enabled` and `face_index_expires_at` in the future).
   *   Drive it from the active folders (folders_face_index_owner_idx, then `path <@` on the GiST
   *   index) and read their files through `files_unindexed_ready_idx`, whose predicate the query
   *   must repeat exactly (`status = 'ready' AND face_count IS NULL AND faces_queued_at IS NULL
   *   AND deleted_at IS NULL AND faces_withheld_at IS NULL`), keyset-paginated by (folder_id, id). Set `faces_queued_at = now()`
   *   in a guarded UPDATE (`WHERE faces_queued_at IS NULL`) before sending `index.file`; this is a
   *   first send, so `faces_requeues` is not bumped.
   * At most FACES_SWEEP_BATCH_SIZE messages of each kind per run.
   *
   * While FACE_SEARCH_ENABLED=false nothing is indexed, so the outbox marks are kept, not
   * cleared: the faces consumer skips index jobs without touching `faces_queued_at` /
   * `face_index_queued_at`, and faces.sweep sends no `index.file` / `index.folder` and runs no
   * coverage scan (so `faces_requeues` doesn't climb to the cap while indexing is off). When it is
   * turned back on, the next runs re-send the kept marks. Deletions are re-sent either way.
   */
  'faces.sweep',
  /**
   * Delete `auth_sessions` rows whose `expires_at` is more than AUTH_SESSION_RETENTION_DAYS in
   * the past, in batches of AUTH_SESSIONS_PURGE_BATCH_SIZE. Revoked rows go with their family's
   * expiry, not earlier: a revoked row with a successor is what detects refresh-token reuse, and
   * every row of a family has the same `expires_at`. No-op on the AWS stacks (Cognito).
   */
  'auth.sessions.purge.daily',
] as const;
export type ScheduledJobType = (typeof SCHEDULED_JOB_TYPES)[number];
