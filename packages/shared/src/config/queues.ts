import { z } from 'zod';
import {
  QUEUE_URL_ENV,
  QUEUE_VISIBILITY_TIMEOUT_ENV,
  type QueueName,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
} from '../queues/names';
import { type Env, parseEnv } from './env';
import { int } from './fields';

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
