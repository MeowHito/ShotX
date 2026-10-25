import { createHash } from 'node:crypto';
import { type Clock, RateLimitedError, type RateLimiter, systemClock } from './throttling';

/**
 * The two Redis commands the bucket needs. ioredis's `Redis` and `Cluster` satisfy it; inject one
 * client per process.
 */
export interface RedisScriptClient {
  evalsha(sha1: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * GCRA token bucket with reservations, run atomically inside Redis.
 *
 * KEYS[1] holds the bucket's theoretical arrival time (TAT) in microseconds of Redis server time.
 * ARGV: emission interval, burst tolerance and maximum wait, all in whole microseconds.
 *
 * A caller gets the earliest free slot and sleeps until then, so waiters never poll Redis. When the
 * slot is more than the maximum wait away, nothing is reserved. Returns {granted (1|0), wait µs}.
 * The key expires once the bucket is full again, because a missing key means a full bucket.
 */
export const TOKEN_BUCKET_SCRIPT = `
if redis.replicate_commands then redis.replicate_commands() end
local interval = tonumber(ARGV[1])
local tolerance = tonumber(ARGV[2])
local max_wait = tonumber(ARGV[3])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000000 + tonumber(time[2])
local tat = tonumber(redis.call('GET', KEYS[1])) or now
if tat < now then tat = now end
local wait = tat - tolerance - now
if wait < 0 then wait = 0 end
if wait > max_wait then return {0, wait} end
local next_tat = tat + interval
local ttl = math.ceil((next_tat - now) / 1000)
redis.call('SET', KEYS[1], string.format('%d', next_tat), 'PX', string.format('%d', ttl))
return {1, wait}
`;

const SCRIPT_SHA = createHash('sha1').update(TOKEN_BUCKET_SCRIPT).digest('hex');

export interface BucketOptions {
  ratePerSecond: number;
  /** The bucket holds max(1, floor(rate × burstSeconds)) tokens. */
  burstSeconds: number;
  /** Longest one call may wait for a slot before RateLimitedError. */
  maxWaitMs: number;
}

/** Bucket parameters in whole microseconds, so the script's arithmetic stays exact. */
export interface BucketParams {
  capacity: number;
  intervalUs: number;
  toleranceUs: number;
  maxWaitUs: number;
}

export function bucketParams(options: BucketOptions): BucketParams {
  const { ratePerSecond, burstSeconds, maxWaitMs } = options;
  if (!(ratePerSecond > 0) || !(burstSeconds > 0) || !(maxWaitMs >= 0)) {
    throw new RangeError(
      `Invalid token bucket: rate ${ratePerSecond}/s, burst ${burstSeconds} s, wait ${maxWaitMs} ms`,
    );
  }
  const capacity = Math.max(1, Math.floor(ratePerSecond * burstSeconds));
  // Rounding the interval up keeps the real rate at or below the configured one.
  const intervalUs = Math.ceil(1_000_000 / ratePerSecond);
  return {
    capacity,
    intervalUs,
    toleranceUs: (capacity - 1) * intervalUs,
    maxWaitUs: Math.floor(maxWaitMs * 1000),
  };
}

/**
 * Token bucket shared by every process that uses the same Redis key. Redis errors propagate: the
 * limiter fails closed instead of letting calls through unmetered.
 */
export class RedisTokenBucket implements RateLimiter {
  readonly params: BucketParams;

  constructor(
    private readonly redis: RedisScriptClient,
    readonly key: string,
    options: BucketOptions,
    private readonly clock: Clock = systemClock,
  ) {
    this.params = bucketParams(options);
  }

  async acquire(): Promise<void> {
    const { granted, waitUs } = parseReply(await this.reserve());
    const waitMs = Math.ceil(waitUs / 1000);
    if (!granted) throw new RateLimitedError(this.key, waitMs);
    if (waitMs > 0) await this.clock.sleep(waitMs);
  }

  private async reserve(): Promise<unknown> {
    const { intervalUs, toleranceUs, maxWaitUs } = this.params;
    const args = [this.key, intervalUs, toleranceUs, maxWaitUs] as const;
    try {
      return await this.redis.evalsha(SCRIPT_SHA, 1, ...args);
    } catch (error) {
      // EVAL also caches the script, so later calls take the EVALSHA path again.
      if (!(error instanceof Error && error.message.startsWith('NOSCRIPT'))) throw error;
      return this.redis.eval(TOKEN_BUCKET_SCRIPT, 1, ...args);
    }
  }
}

function parseReply(reply: unknown): { granted: boolean; waitUs: number } {
  if (Array.isArray(reply) && reply.length === 2) {
    const [granted, waitUs] = reply.map(Number) as [number, number];
    if ((granted === 0 || granted === 1) && Number.isFinite(waitUs) && waitUs >= 0) {
      return { granted: granted === 1, waitUs };
    }
  }
  throw new Error(`Unexpected token bucket reply: ${JSON.stringify(reply)}`);
}
