import type { FaceConfig } from '@shotx/shared';
import { type RedisScriptClient, RedisTokenBucket } from './redis-token-bucket';
import { type Clock, type RateLimiter, systemClock, TokenBucket } from './throttling';

/** Every Rekognition operation the provider calls. Each has its own TPS quota per account and region. */
export const REKOGNITION_OPERATIONS = [
  'IndexFaces',
  'SearchFacesByImage',
  'SearchFaces',
  'DeleteFaces',
  'ListFaces',
  'CreateCollection',
  'DescribeCollection',
  'DeleteCollection',
] as const;
export type RekognitionOperation = (typeof REKOGNITION_OPERATIONS)[number];

/** One limiter per operation, matching how AWS meters the quotas. */
export type RekognitionLimiters = Readonly<Record<RekognitionOperation, RateLimiter>>;

/**
 * `interactive` is the API (face search: fail fast, few retries); `background` is the worker
 * (indexing and purges: wait longer, retry more).
 */
export type RekognitionProfile = 'interactive' | 'background';

type RekognitionConfig = FaceConfig['rekognition'];

/** Configured calls per second for an operation. */
export function operationTps(config: RekognitionConfig, operation: RekognitionOperation): number {
  const { tps } = config.rateLimit;
  switch (operation) {
    case 'IndexFaces':
      return tps.indexFaces;
    case 'SearchFacesByImage':
      return tps.searchFacesByImage;
    case 'SearchFaces':
      return tps.searchFaces;
    case 'DeleteFaces':
      return tps.deleteFaces;
    // ListFaces has its own quota and bucket. It shares the collection rate until FaceConfig has
    // a key of its own; only orphan reconciliation calls it.
    case 'ListFaces':
    case 'CreateCollection':
    case 'DescribeCollection':
    case 'DeleteCollection':
      return tps.collection;
  }
}

/**
 * Redis key of an operation's bucket. Quotas are per account and region, so the region is part of
 * the key; the prefix separates AWS accounts that share one Redis.
 */
export function rekognitionBucketKey(
  config: RekognitionConfig,
  operation: RekognitionOperation,
): string {
  return `${config.rateLimit.keyPrefix}:${config.region}:${operation}`;
}

function buildLimiters(
  make: (operation: RekognitionOperation) => RateLimiter,
): RekognitionLimiters {
  return Object.fromEntries(
    REKOGNITION_OPERATIONS.map((operation) => [operation, make(operation)]),
  ) as Record<RekognitionOperation, RateLimiter>;
}

/**
 * Production limiters: one Redis bucket per operation, shared by every API and worker instance.
 * The profile sets how long one call may wait for a slot before it fails with RateLimitedError.
 */
export function createRedisRekognitionLimiters(
  redis: RedisScriptClient,
  config: RekognitionConfig,
  profile: RekognitionProfile,
  clock: Clock = systemClock,
): RekognitionLimiters {
  return buildLimiters(
    (operation) =>
      new RedisTokenBucket(
        redis,
        rekognitionBucketKey(config, operation),
        {
          ratePerSecond: operationTps(config, operation),
          burstSeconds: config.rateLimit.burstSeconds,
          maxWaitMs: config[profile].maxWaitMs,
        },
        clock,
      ),
  );
}

/**
 * In-process limiters with the same rates and algorithm, for tests and the local evaluation
 * harness. They only hold when a single process calls Rekognition, and they wait instead of
 * failing.
 */
export function createLocalRekognitionLimiters(
  config: RekognitionConfig,
  clock: Clock = systemClock,
): RekognitionLimiters {
  return buildLimiters(
    (operation) =>
      new TokenBucket(
        {
          ratePerSecond: operationTps(config, operation),
          burstSeconds: config.rateLimit.burstSeconds,
          maxWaitMs: Number.POSITIVE_INFINITY,
        },
        clock,
        operation,
      ),
  );
}
