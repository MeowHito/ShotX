import { bullMqRedisOptions, type RedisConfig } from '@shotx/shared';
import { Redis } from 'ioredis';
import { errorFields } from '../logger';

/**
 * The dedicated ioredis connection of BullMQ (bullMqRedisOptions from @shotx/shared). Queues share
 * it; each Worker duplicates it for its blocking reads. Not the cache/rate-limit connection.
 */
export function createBullMqConnection(config: RedisConfig): Redis {
  return new Redis(config.url, bullMqRedisOptions(config));
}

/**
 * The error BullMQ stores as the failed reason (and stack) of a job: name and scrubbed message
 * only. Redis keeps failed jobs without a TTL, so it gets no more than the logs do (no S3 keys of
 * originals, which contain the uploaded file name).
 */
export function storableError(error: unknown): Error {
  const fields = errorFields(error);
  const name = typeof fields.errorName === 'string' ? fields.errorName : 'Error';
  const message = typeof fields.errorMessage === 'string' ? fields.errorMessage : name;
  const stored = new Error(message);
  stored.name = name;
  stored.stack = `${name}: ${message}`;
  return stored;
}
