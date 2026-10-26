import { z } from 'zod';
import { QUEUE_BACKENDS, type QueueName } from '../queues/names';
import { type Env, parseEnv } from './env';
import { int, MS_PER_SECOND, SECONDS_PER_DAY, SECONDS_PER_HOUR } from './fields';

/** x264 speed/size presets the worker accepts for preview.mp4. */
export const X264_PRESETS = [
  'ultrafast',
  'superfast',
  'veryfast',
  'faster',
  'fast',
  'medium',
  'slow',
] as const;
export type X264Preset = (typeof X264_PRESETS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** SQS allows 1–10 messages per ReceiveMessage call. */
const batchSize = int(1, 10);
const concurrency = int(1, 10);
/**
 * Longest WORKER_*_MAX_PROCESSING_SECONDS and WORKER_JOB_MAX_RUNTIME_SECONDS: under SQS's 12 h
 * visibility cap with room for the heartbeat.
 */
export const WORKER_MAX_PROCESSING_SECONDS_LIMIT = 11 * SECONDS_PER_HOUR;

const runtime = int(60, WORKER_MAX_PROCESSING_SECONDS_LIMIT);

// Worker-only tunables (moved from apps/worker/src/config.ts). Defaults are assumptions; infra
// doesn't set them, so the defaults apply unless `services.env.worker` overrides one.
const workerEnvSchema = z
  .object({
    /** Only decides whether the batch-size rules below apply (they are SQS's). */
    QUEUE_BACKEND: z.enum(QUEUE_BACKENDS).default('sqs'),
    /** Messages per ReceiveMessage call, and messages processed at once per task, per queue. */
    WORKER_MEDIA_BATCH_SIZE: batchSize.default(4),
    /** sharp and ffmpeg are CPU heavy. */
    WORKER_MEDIA_CONCURRENCY: concurrency.default(2),
    /** Faces jobs mostly wait on the shared Rekognition rate limiter. */
    WORKER_FACES_BATCH_SIZE: batchSize.default(4),
    WORKER_FACES_CONCURRENCY: concurrency.default(2),
    /** Zips stream large objects; one at a time per task by default. */
    WORKER_ZIP_BATCH_SIZE: batchSize.default(1),
    WORKER_ZIP_CONCURRENCY: concurrency.default(1),
    WORKER_JOBS_BATCH_SIZE: batchSize.default(1),
    WORKER_JOBS_CONCURRENCY: concurrency.default(1),
    /** SQS long polling. */
    WORKER_RECEIVE_WAIT_SECONDS: int(1, 20).default(20),
    /** After a failed attempt the message comes back after base × 2^(receives − 1), capped. */
    WORKER_RETRY_BASE_SECONDS: int(0, 900).default(10),
    /**
     * On SIGTERM, how long running messages may finish before their visibility is reset to 0.
     * Must be shorter than the ECS stop timeout (30 s by default).
     */
    WORKER_SHUTDOWN_GRACE_SECONDS: int(0, 110).default(20),
    /** One media message may process this long (ffmpeg is killed after it); under SQS's 12 h. */
    WORKER_MEDIA_MAX_PROCESSING_SECONDS: runtime.default(4 * SECONDS_PER_HOUR),
    /**
     * One faces message may process this long. Keep it above infra's facesJobWorstCase (3,960 s
     * at the defaults), or healthy indexing attempts are cut off.
     */
    WORKER_FACES_MAX_PROCESSING_SECONDS: runtime.default(2 * SECONDS_PER_HOUR),
    /** One zip job may stream this long before it is failed. */
    WORKER_ZIP_MAX_PROCESSING_SECONDS: runtime.default(2 * SECONDS_PER_HOUR),
    /** A scheduled job stops starting new batches after this long and resumes in its next run. */
    WORKER_JOB_MAX_RUNTIME_SECONDS: runtime.default(6 * SECONDS_PER_HOUR),
    /** Rows per batch in purge, expiry and reconciliation. */
    WORKER_JOB_BATCH_SIZE: int(1, 1000).default(200),
    /** How long a finished (type, scheduledTime) is remembered for dedupe. */
    WORKER_JOB_DEDUPE_TTL_SECONDS: int(SECONDS_PER_HOUR, 30 * SECONDS_PER_DAY).default(
      7 * SECONDS_PER_DAY,
    ),
    /**
     * UTC offset assumed for EXIF DateTimeOriginal without OffsetTimeOriginal. Cameras record
     * local time; the operator is in Thailand.
     */
    WORKER_EXIF_DEFAULT_UTC_OFFSET: z
      .string()
      .regex(/^[+-](0\d|1[0-4]):[0-5]\d$/, { error: 'must look like +07:00' })
      .default('+07:00'),
    WORKER_FFMPEG_PATH: z.string().min(1).default('ffmpeg'),
    WORKER_FFPROBE_PATH: z.string().min(1).default('ffprobe'),
    /** x264 speed/size trade-off for preview.mp4. */
    WORKER_VIDEO_X264_PRESET: z.enum(X264_PRESETS).default('veryfast'),
    WORKER_VIDEO_AUDIO_BITRATE_KBPS: int(32, 320).default(128),
    /** Scratch space for originals, video output and zips (ECS ephemeral storage). */
    WORKER_TMP_DIR: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    // --- Sweeps (ADR 0008 section 3, "Lost jobs"; job contracts at SCHEDULED_JOB_TYPES) ---------
    /**
     * media.sweep re-sends `original.completed` for a `processing` row this long after its
     * pipeline was last started. Longer than WORKER_MEDIA_MAX_PROCESSING_SECONDS, so a job that is
     * still running is not duplicated (duplicates are safe, just wasteful: ffmpeg runs twice).
     */
    MEDIA_SWEEP_PROCESSING_AGE_SECONDS: int(15 * 60, 7 * SECONDS_PER_DAY).default(
      6 * SECONDS_PER_HOUR,
    ),
    /**
     * media.sweep checks `uploading` rows (upload_id set) this long after init for a completed
     * object whose markCompleted was lost. Assumption: 1 h (an upload of one file rarely takes
     * longer; a live upload is left alone anyway).
     */
    MEDIA_SWEEP_UPLOADING_AGE_SECONDS: int(5 * 60, 36 * SECONDS_PER_HOUR).default(SECONDS_PER_HOUR),
    /** Most times media.sweep re-sends one file; then the row is left for the operator. */
    MEDIA_SWEEP_MAX_REQUEUES: int(0, 20).default(3),
    /** Rows media.sweep handles per run (each kind), bounding the burst it adds to `media`. */
    MEDIA_SWEEP_BATCH_SIZE: int(1, 10_000).default(500),
    /** faces.sweep re-sends `delete.faces` for a deletion still open this long after it was asked. */
    FACES_SWEEP_DELETION_AGE_SECONDS: int(5 * 60, 7 * SECONDS_PER_DAY).default(SECONDS_PER_HOUR),
    /**
     * faces.sweep re-sends `index.file` / `index.folder` this long after it was last sent. Longer
     * than WORKER_FACES_MAX_PROCESSING_SECONDS (a duplicate index costs Rekognition calls).
     */
    FACES_SWEEP_INDEX_AGE_SECONDS: int(15 * 60, 7 * SECONDS_PER_DAY).default(6 * SECONDS_PER_HOUR),
    /** Most times faces.sweep re-sends `index.file` for one file. Deletions have no cap. */
    FACES_SWEEP_MAX_REQUEUES: int(0, 20).default(3),
    /** Messages faces.sweep sends per run, per kind. */
    FACES_SWEEP_BATCH_SIZE: int(1, 10_000).default(500),
    /** Rows per DELETE of auth.sessions.purge.daily (it runs until done or out of runtime). */
    AUTH_SESSIONS_PURGE_BATCH_SIZE: int(1, 10_000).default(1_000),
  })
  .refine((e) => e.MEDIA_SWEEP_PROCESSING_AGE_SECONDS > e.WORKER_MEDIA_MAX_PROCESSING_SECONDS, {
    error:
      'MEDIA_SWEEP_PROCESSING_AGE_SECONDS must be longer than WORKER_MEDIA_MAX_PROCESSING_SECONDS',
  })
  .refine((e) => e.FACES_SWEEP_INDEX_AGE_SECONDS > e.WORKER_FACES_MAX_PROCESSING_SECONDS, {
    error: 'FACES_SWEEP_INDEX_AGE_SECONDS must be longer than WORKER_FACES_MAX_PROCESSING_SECONDS',
  })
  .refine(
    (e) => e.QUEUE_BACKEND === 'bullmq' || e.WORKER_MEDIA_CONCURRENCY <= e.WORKER_MEDIA_BATCH_SIZE,
    {
      error: 'WORKER_MEDIA_CONCURRENCY must be at most WORKER_MEDIA_BATCH_SIZE (with SQS)',
    },
  )
  .refine(
    (e) => e.QUEUE_BACKEND === 'bullmq' || e.WORKER_FACES_CONCURRENCY <= e.WORKER_FACES_BATCH_SIZE,
    {
      error: 'WORKER_FACES_CONCURRENCY must be at most WORKER_FACES_BATCH_SIZE (with SQS)',
    },
  )
  .refine(
    (e) => e.QUEUE_BACKEND === 'bullmq' || e.WORKER_ZIP_CONCURRENCY <= e.WORKER_ZIP_BATCH_SIZE,
    {
      error: 'WORKER_ZIP_CONCURRENCY must be at most WORKER_ZIP_BATCH_SIZE (with SQS)',
    },
  )
  .refine(
    (e) => e.QUEUE_BACKEND === 'bullmq' || e.WORKER_JOBS_CONCURRENCY <= e.WORKER_JOBS_BATCH_SIZE,
    {
      error: 'WORKER_JOBS_CONCURRENCY must be at most WORKER_JOBS_BATCH_SIZE (with SQS)',
    },
  );

export interface WorkerConsumerSettings {
  /** Messages per ReceiveMessage call (SQS only; unused with BullMQ). */
  batchSize: number;
  /**
   * Messages processed at once per task (BullMQ: Worker `concurrency`). At most batchSize with
   * SQS; not tied to it with QUEUE_BACKEND=bullmq.
   */
  concurrency: number;
}

export interface WorkerVideoSettings {
  ffmpegPath: string;
  ffprobePath: string;
  x264Preset: X264Preset;
  audioBitrateKbps: number;
}

/** Settings of media.sweep, faces.sweep and auth.sessions.purge.daily (seconds, counts). */
export interface WorkerSweepSettings {
  media: {
    processingAgeSeconds: number;
    uploadingAgeSeconds: number;
    maxRequeues: number;
    batchSize: number;
  };
  faces: {
    deletionAgeSeconds: number;
    indexAgeSeconds: number;
    maxRequeues: number;
    batchSize: number;
  };
  /** Rows per DELETE; the retention is RetentionConfig.authSessionRetentionDays. */
  authSessionsPurgeBatchSize: number;
}

export interface WorkerSettings {
  consumers: Record<QueueName, WorkerConsumerSettings>;
  receiveWaitSeconds: number;
  retryBaseSeconds: number;
  shutdownGraceMs: number;
  /** Longest processing of one message, per queue (`jobs`: WORKER_JOB_MAX_RUNTIME_SECONDS). */
  maxProcessingMs: Record<QueueName, number>;
  jobBatchSize: number;
  jobDedupeTtlSeconds: number;
  exifDefaultUtcOffset: string;
  video: WorkerVideoSettings;
  /** Undefined: the operating system's temporary directory. */
  tmpDir: string | undefined;
  logLevel: LogLevel;
  sweeps: WorkerSweepSettings;
}

/**
 * Reads the WORKER_* settings, LOG_LEVEL and the sweep settings (MEDIA_SWEEP_*, FACES_SWEEP_*,
 * AUTH_SESSIONS_PURGE_BATCH_SIZE) (worker only). Every key has a default. QUEUE_BACKEND
 * (default `sqs`) is read only to skip the concurrency <= batch size rule with `bullmq`.
 */
export function loadWorkerSettings(env: Env): WorkerSettings {
  const e = parseEnv(workerEnvSchema, env, 'worker');
  return {
    consumers: {
      media: { batchSize: e.WORKER_MEDIA_BATCH_SIZE, concurrency: e.WORKER_MEDIA_CONCURRENCY },
      faces: { batchSize: e.WORKER_FACES_BATCH_SIZE, concurrency: e.WORKER_FACES_CONCURRENCY },
      zip: { batchSize: e.WORKER_ZIP_BATCH_SIZE, concurrency: e.WORKER_ZIP_CONCURRENCY },
      jobs: { batchSize: e.WORKER_JOBS_BATCH_SIZE, concurrency: e.WORKER_JOBS_CONCURRENCY },
    },
    receiveWaitSeconds: e.WORKER_RECEIVE_WAIT_SECONDS,
    retryBaseSeconds: e.WORKER_RETRY_BASE_SECONDS,
    shutdownGraceMs: e.WORKER_SHUTDOWN_GRACE_SECONDS * MS_PER_SECOND,
    maxProcessingMs: {
      media: e.WORKER_MEDIA_MAX_PROCESSING_SECONDS * MS_PER_SECOND,
      faces: e.WORKER_FACES_MAX_PROCESSING_SECONDS * MS_PER_SECOND,
      zip: e.WORKER_ZIP_MAX_PROCESSING_SECONDS * MS_PER_SECOND,
      jobs: e.WORKER_JOB_MAX_RUNTIME_SECONDS * MS_PER_SECOND,
    },
    jobBatchSize: e.WORKER_JOB_BATCH_SIZE,
    jobDedupeTtlSeconds: e.WORKER_JOB_DEDUPE_TTL_SECONDS,
    exifDefaultUtcOffset: e.WORKER_EXIF_DEFAULT_UTC_OFFSET,
    video: {
      ffmpegPath: e.WORKER_FFMPEG_PATH,
      ffprobePath: e.WORKER_FFPROBE_PATH,
      x264Preset: e.WORKER_VIDEO_X264_PRESET,
      audioBitrateKbps: e.WORKER_VIDEO_AUDIO_BITRATE_KBPS,
    },
    tmpDir: e.WORKER_TMP_DIR,
    logLevel: e.LOG_LEVEL,
    sweeps: {
      media: {
        processingAgeSeconds: e.MEDIA_SWEEP_PROCESSING_AGE_SECONDS,
        uploadingAgeSeconds: e.MEDIA_SWEEP_UPLOADING_AGE_SECONDS,
        maxRequeues: e.MEDIA_SWEEP_MAX_REQUEUES,
        batchSize: e.MEDIA_SWEEP_BATCH_SIZE,
      },
      faces: {
        deletionAgeSeconds: e.FACES_SWEEP_DELETION_AGE_SECONDS,
        indexAgeSeconds: e.FACES_SWEEP_INDEX_AGE_SECONDS,
        maxRequeues: e.FACES_SWEEP_MAX_REQUEUES,
        batchSize: e.FACES_SWEEP_BATCH_SIZE,
      },
      authSessionsPurgeBatchSize: e.AUTH_SESSIONS_PURGE_BATCH_SIZE,
    },
  };
}
