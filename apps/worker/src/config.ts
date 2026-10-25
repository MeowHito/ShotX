import { type DatabaseConfig, loadDatabaseConfig } from '@shotx/db';
import {
  type AppConfig,
  type AwsConfig,
  type Env,
  loadAppConfig,
  loadAwsConfig,
  loadMediaConfig,
  loadMediaStorageConfig,
  loadQueueUrls,
  loadQueueVisibilityTimeouts,
  loadRedisConfig,
  loadRetentionConfig,
  type MediaConfig,
  type MediaStorageConfig,
  parseEnv,
  type RedisConfig,
  type RetentionConfig,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
} from '@shotx/shared';
import { z } from 'zod';
import type { VideoTools } from './media/video';

/** Queues the Phase 2 worker consumes. `faces` and `zip` consumers come in Phase 3. */
export const CONSUMED_QUEUES = ['media', 'jobs'] as const;
export type ConsumedQueue = (typeof CONSUMED_QUEUES)[number];

/** Queues the worker sends to. */
export const SENT_QUEUES = ['faces'] as const;

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const HOUR = 3600;

// Worker-only tunables. Defaults are assumptions; infra doesn't set them, so the defaults apply
// unless `services.env.worker` overrides one.
const workerEnvSchema = z
  .object({
    /** Messages per ReceiveMessage call (SQS allows 1–10). */
    WORKER_MEDIA_BATCH_SIZE: int(1, 10).default(4),
    /** Media messages processed at once per task (sharp and ffmpeg are CPU heavy). */
    WORKER_MEDIA_CONCURRENCY: int(1, 10).default(2),
    WORKER_JOBS_BATCH_SIZE: int(1, 10).default(1),
    WORKER_JOBS_CONCURRENCY: int(1, 10).default(1),
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
    WORKER_MEDIA_MAX_PROCESSING_SECONDS: int(60, 11 * HOUR).default(4 * HOUR),
    /** A scheduled job stops starting new batches after this long and resumes in its next run. */
    WORKER_JOB_MAX_RUNTIME_SECONDS: int(60, 11 * HOUR).default(6 * HOUR),
    /** Rows per batch in purge and reconciliation. */
    WORKER_JOB_BATCH_SIZE: int(1, 1000).default(200),
    /** How long a finished (type, scheduledTime) is remembered for dedupe. */
    WORKER_JOB_DEDUPE_TTL_SECONDS: int(HOUR, 30 * 24 * HOUR).default(7 * 24 * HOUR),
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
    WORKER_VIDEO_X264_PRESET: z
      .enum(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow'])
      .default('veryfast'),
    WORKER_VIDEO_AUDIO_BITRATE_KBPS: int(32, 320).default(128),
    /** Scratch space for originals and video output (ECS ephemeral storage). */
    WORKER_TMP_DIR: z.string().min(1).optional(),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  })
  .refine((e) => e.WORKER_MEDIA_CONCURRENCY <= e.WORKER_MEDIA_BATCH_SIZE, {
    error: 'WORKER_MEDIA_CONCURRENCY must be at most WORKER_MEDIA_BATCH_SIZE',
  })
  .refine((e) => e.WORKER_JOBS_CONCURRENCY <= e.WORKER_JOBS_BATCH_SIZE, {
    error: 'WORKER_JOBS_CONCURRENCY must be at most WORKER_JOBS_BATCH_SIZE',
  });

export interface ConsumerSettings {
  batchSize: number;
  concurrency: number;
}

export interface WorkerRuntimeConfig {
  consumers: Record<ConsumedQueue, ConsumerSettings>;
  receiveWaitSeconds: number;
  retryBaseSeconds: number;
  shutdownGraceMs: number;
  mediaMaxProcessingMs: number;
  jobMaxRuntimeMs: number;
  jobBatchSize: number;
  jobDedupeTtlSeconds: number;
  exifDefaultUtcOffset: string;
  video: VideoTools;
  tmpDir: string | undefined;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadWorkerRuntimeConfig(env: Env): WorkerRuntimeConfig {
  const e = parseEnv(workerEnvSchema, env, 'worker');
  return {
    consumers: {
      media: { batchSize: e.WORKER_MEDIA_BATCH_SIZE, concurrency: e.WORKER_MEDIA_CONCURRENCY },
      jobs: { batchSize: e.WORKER_JOBS_BATCH_SIZE, concurrency: e.WORKER_JOBS_CONCURRENCY },
    },
    receiveWaitSeconds: e.WORKER_RECEIVE_WAIT_SECONDS,
    retryBaseSeconds: e.WORKER_RETRY_BASE_SECONDS,
    shutdownGraceMs: e.WORKER_SHUTDOWN_GRACE_SECONDS * 1000,
    mediaMaxProcessingMs: e.WORKER_MEDIA_MAX_PROCESSING_SECONDS * 1000,
    jobMaxRuntimeMs: e.WORKER_JOB_MAX_RUNTIME_SECONDS * 1000,
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
  };
}

export interface WorkerConfig {
  app: AppConfig;
  aws: AwsConfig;
  storage: MediaStorageConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  queueUrls: Record<ConsumedQueue | (typeof SENT_QUEUES)[number], string>;
  visibilityTimeoutSeconds: Record<ConsumedQueue, number>;
  media: MediaConfig;
  retention: RetentionConfig;
  worker: WorkerRuntimeConfig;
}

/** Everything the worker reads from the environment, validated at start-up. */
export function loadWorkerConfig(env: Env): WorkerConfig {
  const visibilityTimeoutSeconds = loadQueueVisibilityTimeouts(env, CONSUMED_QUEUES);
  for (const queue of CONSUMED_QUEUES) {
    const seconds = visibilityTimeoutSeconds[queue];
    if (seconds < 3 || seconds > SQS_MAX_VISIBILITY_TIMEOUT_SECONDS) {
      throw new Error(
        `Invalid queue configuration: the ${queue} visibility timeout must be at least 3 s for heartbeats`,
      );
    }
  }
  return {
    app: loadAppConfig(env),
    aws: loadAwsConfig(env),
    storage: loadMediaStorageConfig(env),
    database: loadDatabaseConfig(env),
    redis: loadRedisConfig(env),
    queueUrls: loadQueueUrls(env, [...CONSUMED_QUEUES, ...SENT_QUEUES]),
    visibilityTimeoutSeconds,
    media: loadMediaConfig(env),
    retention: loadRetentionConfig(env),
    worker: loadWorkerRuntimeConfig(env),
  };
}
