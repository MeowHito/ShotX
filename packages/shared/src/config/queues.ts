import { z } from 'zod';
import { QUEUE_URL_ENV, type QueueName } from '../queues/names';
import { type Env, parseEnv } from './env';

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
