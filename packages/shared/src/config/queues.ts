import { z } from 'zod';
import {
  BULLMQ_QUEUE_DEFAULTS,
  BULLMQ_QUEUE_ENV,
  bullMqPrefix,
  QUEUE_BACKENDS,
  QUEUE_URL_ENV,
  QUEUE_VISIBILITY_TIMEOUT_ENV,
  type QueueName,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
} from '../queues/names';
import { type Env, parseEnv } from './env';
import { appStage, int, MS_PER_SECOND, SECONDS_PER_DAY } from './fields';
import type { RedisConfig } from './redis';

/**
 * Reads the URLs of the given queues from MEDIA_QUEUE_URL, FACES_QUEUE_URL, ZIP_QUEUE_URL and
 * JOBS_QUEUE_URL. Each service asks only for the queues it uses; all of them are required.
 */
export function loadQueueUrls<Q extends QueueName>(
  env: Env,
  queues: readonly Q[],
): Record<Q, string> {
  const schema = z.object(Object.fromEntries(queues.map((q) => [QUEUE_URL_ENV[q], z.url()])));
  const e = parseEnv(schema, env, 'queue') as Record<string, string>;
  return Object.fromEntries(queues.map((q) => [q, e[QUEUE_URL_ENV[q]]])) as Record<Q, string>;
}

/**
 * Reads the visibility timeout (seconds, 0 to 43,200) of the given queues from
 * MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS, FACES_QUEUE_VISIBILITY_TIMEOUT_SECONDS,
 * ZIP_QUEUE_VISIBILITY_TIMEOUT_SECONDS and JOBS_QUEUE_VISIBILITY_TIMEOUT_SECONDS. For the worker,
 * which consumes the queues; all requested ones are required.
 */
export function loadQueueVisibilityTimeouts<Q extends QueueName>(
  env: Env,
  queues: readonly Q[],
): Record<Q, number> {
  const schema = z.object(
    Object.fromEntries(
      queues.map((q) => [
        QUEUE_VISIBILITY_TIMEOUT_ENV[q],
        int(0, SQS_MAX_VISIBILITY_TIMEOUT_SECONDS),
      ]),
    ),
  );
  const e = parseEnv(schema, env, 'queue') as Record<string, number>;
  return Object.fromEntries(queues.map((q) => [q, e[QUEUE_VISIBILITY_TIMEOUT_ENV[q]]])) as Record<
    Q,
    number
  >;
}

/** BullMQ settings of one queue, ready for BullMQ's options. */
export interface BullMqQueueSettings {
  /** Job option `attempts`. */
  attempts: number;
  /** Job option `backoff: { type: 'exponential', delay: backoffDelayMs }`. */
  backoffDelayMs: number;
  /** Worker option `lockDuration` (renewed automatically while the job runs). */
  lockDurationMs: number;
  /** Worker option `maxStalledCount`. */
  maxStalledCount: number;
  /** Job option `removeOnFail.count`: failed jobs kept (the DLQ). Alarm on the failed count. */
  removeOnFailCount: number;
  /** Job option `removeOnFail.age` (seconds). */
  removeOnFailAgeSeconds: number;
  /** Job option `removeOnComplete.count`. */
  removeOnCompleteCount: number;
  /** Job option `removeOnComplete.age` (seconds). */
  removeOnCompleteAgeSeconds: number;
  /** Queue option `streams.events.maxLen`. */
  eventsMaxLen: number;
}

export type QueueBackendConfig<Q extends QueueName> = (
  | { backend: 'sqs'; urls: Record<Q, string> }
  | {
      backend: 'bullmq';
      /** BullMQ `prefix` option: bullMqPrefix(APP_STAGE). */
      prefix: string;
      queues: Record<Q, BullMqQueueSettings>;
    }
) & {
  /**
   * QUEUE_ENQUEUE_TIMEOUT_MS: the api gives up on one enqueue (BullMQ `add`, SQS SendMessage)
   * after this and fails the request, instead of hanging while Redis or SQS is unreachable.
   */
  enqueueTimeoutMs: number;
};

const queueBackendEnvSchema = z.object({
  QUEUE_BACKEND: z.enum(QUEUE_BACKENDS).default('sqs'),
  QUEUE_ENQUEUE_TIMEOUT_MS: int(100, 60_000).default(5_000),
});

const bullMqFields = (q: QueueName) => {
  const names = BULLMQ_QUEUE_ENV[q];
  const d = BULLMQ_QUEUE_DEFAULTS[q];
  const retentionSeconds = int(60, 90 * SECONDS_PER_DAY);
  return [
    [names.attempts, int(1, 50).default(d.attempts)],
    [names.backoffBaseSeconds, int(0, 15 * 60).default(d.backoffBaseSeconds)],
    [
      names.lockDurationSeconds,
      int(30, SQS_MAX_VISIBILITY_TIMEOUT_SECONDS).default(d.lockDurationSeconds),
    ],
    [names.maxStalledCount, int(0, 10).default(d.maxStalledCount)],
    [names.failedRetentionCount, int(1, 1_000_000).default(d.failedRetentionCount)],
    [names.failedRetentionSeconds, retentionSeconds.default(d.failedRetentionSeconds)],
    [names.completedRetentionCount, int(0, 1_000_000).default(d.completedRetentionCount)],
    [names.completedRetentionSeconds, retentionSeconds.default(d.completedRetentionSeconds)],
    [names.eventsMaxLen, int(100, 1_000_000).default(d.eventsMaxLen)],
  ] as const;
};

/**
 * Reads QUEUE_BACKEND (default `sqs`), QUEUE_ENQUEUE_TIMEOUT_MS (default 5000) and the settings of
 * the given queues:
 * - `sqs`: their URLs, as loadQueueUrls (the worker also calls loadQueueVisibilityTimeouts);
 * - `bullmq`: APP_STAGE (for the prefix) and per queue `<QUEUE>_QUEUE_ATTEMPTS`,
 *   `_BACKOFF_BASE_SECONDS`, `_LOCK_DURATION_SECONDS`, `_MAX_STALLED_COUNT`,
 *   `_FAILED_RETENTION_COUNT`, `_FAILED_RETENTION_SECONDS`, `_COMPLETED_RETENTION_COUNT`,
 *   `_COMPLETED_RETENTION_SECONDS` and `_EVENTS_MAX_LEN`, all with defaults
 *   (BULLMQ_QUEUE_DEFAULTS). Queue URLs are not read. Redis is REDIS_URL (loadRedisConfig).
 * The BullMQ variables are validated with either backend, so a bad value fails at start-up even
 * before the switch. api asks for the queues it sends to, the worker for all of them.
 */
export function loadQueueBackendConfig<Q extends QueueName>(
  env: Env,
  queues: readonly Q[],
): QueueBackendConfig<Q> {
  const { QUEUE_BACKEND, QUEUE_ENQUEUE_TIMEOUT_MS } = parseEnv(queueBackendEnvSchema, env, 'queue');
  const fieldsSchema = z.object(Object.fromEntries(queues.flatMap(bullMqFields)));
  const fields = parseEnv(fieldsSchema, env, 'queue') as Record<string, number>;
  if (QUEUE_BACKEND === 'sqs') {
    return {
      backend: 'sqs',
      urls: loadQueueUrls(env, queues),
      enqueueTimeoutMs: QUEUE_ENQUEUE_TIMEOUT_MS,
    };
  }
  const { APP_STAGE } = parseEnv(z.object({ APP_STAGE: appStage() }), env, 'queue');
  return {
    backend: 'bullmq',
    prefix: bullMqPrefix(APP_STAGE),
    enqueueTimeoutMs: QUEUE_ENQUEUE_TIMEOUT_MS,
    queues: Object.fromEntries(
      queues.map((q) => {
        const names = BULLMQ_QUEUE_ENV[q];
        const get = (name: string) => fields[name] as number;
        const settings: BullMqQueueSettings = {
          attempts: get(names.attempts),
          backoffDelayMs: get(names.backoffBaseSeconds) * MS_PER_SECOND,
          lockDurationMs: get(names.lockDurationSeconds) * MS_PER_SECOND,
          maxStalledCount: get(names.maxStalledCount),
          removeOnFailCount: get(names.failedRetentionCount),
          removeOnFailAgeSeconds: get(names.failedRetentionSeconds),
          removeOnCompleteCount: get(names.completedRetentionCount),
          removeOnCompleteAgeSeconds: get(names.completedRetentionSeconds),
          eventsMaxLen: get(names.eventsMaxLen),
        };
        return [q, settings];
      }),
    ) as Record<Q, BullMqQueueSettings>,
  };
}

// --- BullMQ options (api and worker) -------------------------------------------------------------
// Plain objects shaped like BullMQ's options, so api and worker build the same queues without
// shared depending on bullmq or ioredis. Spread them and add `connection` on the app side.

/** Shape of BullMQ `JobsOptions` used for every job (and job scheduler template). */
export interface BullMqJobOptions {
  attempts: number;
  backoff: { type: 'exponential'; delay: number };
  /** BullMQ KeepJobs: whichever limit is reached first; `age` in seconds. */
  removeOnComplete: { count: number; age: number };
  removeOnFail: { count: number; age: number };
}

/**
 * Options of every job the api or worker adds: attempts with exponential backoff (attempt n waits
 * delay x 2^(n-1)), and completed and failed jobs kept up to a count and an age (BullMQ keys have
 * no TTL; the failed set is the DLQ). Never a `jobId` (see queueJobName).
 */
export function bullMqJobOptions(settings: BullMqQueueSettings): BullMqJobOptions {
  return {
    attempts: settings.attempts,
    backoff: { type: 'exponential', delay: settings.backoffDelayMs },
    removeOnComplete: {
      count: settings.removeOnCompleteCount,
      age: settings.removeOnCompleteAgeSeconds,
    },
    removeOnFail: { count: settings.removeOnFailCount, age: settings.removeOnFailAgeSeconds },
  };
}

/** Shape of BullMQ `QueueOptions` without `connection`. */
export interface BullMqQueueOptions {
  prefix: string;
  skipVersionCheck: true;
  streams: { events: { maxLen: number } };
}

/**
 * Options of a BullMQ Queue: the stage prefix (BullMQ `prefix`, never ioredis `keyPrefix`), no
 * version check (the Redis ACL denies `@dangerous`, which includes INFO) and the events stream cap.
 */
export function bullMqQueueOptions(
  settings: BullMqQueueSettings,
  prefix: string,
): BullMqQueueOptions {
  return {
    prefix,
    skipVersionCheck: true,
    streams: { events: { maxLen: settings.eventsMaxLen } },
  };
}

/** Shape of the BullMQ `WorkerOptions` the queue settings decide, without `connection`. */
export interface BullMqWorkerOptions {
  prefix: string;
  skipVersionCheck: true;
  concurrency: number;
  lockDuration: number;
  maxStalledCount: number;
}

/**
 * Options of a BullMQ Worker: prefix and version check as the queue, the queue's lock duration
 * (renewed while the job runs) and stall limit, and the concurrency from loadWorkerSettings.
 */
export function bullMqWorkerOptions(
  settings: BullMqQueueSettings,
  prefix: string,
  concurrency: number,
): BullMqWorkerOptions {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  return {
    prefix,
    skipVersionCheck: true,
    concurrency,
    lockDuration: settings.lockDurationMs,
    maxStalledCount: settings.maxStalledCount,
  };
}

/**
 * ioredis options of the BullMQ connections that *process* jobs (worker: Workers, QueueEvents,
 * job schedulers): BullMQ requires `maxRetriesPerRequest: null` for its blocking reads, and the
 * ready check runs INFO, which the ACL denies. Commands wait while Redis reconnects. Not for the
 * api's producer (bullMqProducerRedisOptions) nor the cache/rate-limit client.
 */
export const BULLMQ_REDIS_OPTIONS = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
} as const;

export interface BullMqRedisOptions {
  username?: string;
  password?: string;
  maxRetriesPerRequest: null;
  enableReadyCheck: false;
}

/**
 * Worker-side BullMQ connection: the RBAC credentials (if any) plus BULLMQ_REDIS_OPTIONS. Use as
 * `new Redis(config.url, bullMqRedisOptions(config))`. Contains the password: never log it.
 */
export function bullMqRedisOptions(config: RedisConfig): BullMqRedisOptions {
  return { ...(config.credentials ?? {}), ...BULLMQ_REDIS_OPTIONS };
}

/**
 * ioredis options of the api's BullMQ *producer* connection (Queue.add only), which must fail
 * fast when Redis is down: one retry per command, no offline queue (commands issued while
 * disconnected are rejected at once instead of piling up), no ready check (INFO is denied). With
 * no offline queue, wait for the connection's `ready` event at start-up before serving. Wrap each
 * `add` in QUEUE_ENQUEUE_TIMEOUT_MS (loadQueueBackendConfig `enqueueTimeoutMs`).
 */
export const BULLMQ_PRODUCER_REDIS_OPTIONS = {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  enableReadyCheck: false,
} as const;

export interface BullMqProducerRedisOptions {
  username?: string;
  password?: string;
  maxRetriesPerRequest: number;
  enableOfflineQueue: false;
  enableReadyCheck: false;
}

/**
 * api-side BullMQ connection: the RBAC credentials (if any) plus BULLMQ_PRODUCER_REDIS_OPTIONS.
 * Contains the password: never log it.
 */
export function bullMqProducerRedisOptions(config: RedisConfig): BullMqProducerRedisOptions {
  return { ...(config.credentials ?? {}), ...BULLMQ_PRODUCER_REDIS_OPTIONS };
}
