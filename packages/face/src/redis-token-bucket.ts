import { createHash } from 'node:crypto';
import { type BucketOptions, type BucketParams, bucketParams, type Reservation } from './bucket';
import { type Clock, RateLimitedError, type RateLimiter, systemClock } from './throttling';

const US_PER_MS = 1000;

/**
 * The two Redis commands the bucket needs. ioredis's `Redis` and `Cluster` satisfy it; inject one
 * client per process.
 */
export interface RedisScriptClient {
  evalsha(sha1: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * `nextSlotUs` from `./bucket`, run atomically inside Redis with Redis server time.
 *
 * KEYS[1] is a list of the latest grants (microseconds of Redis time, newest first, at most
 * `limit` entries). ARGV: limit, window µs, burst, burst window µs, maximum wait µs.
 *
 * A caller gets the earliest slot that keeps every window within its limit and sleeps until then,
 * so waiters never poll Redis. When the slot is more than the maximum wait away, nothing is
 * reserved. Returns {granted (1|0), wait µs, slot µs}. The key expires once its newest grant has
 * left the window, because a missing key means an idle bucket.
 */
export const TOKEN_BUCKET_SCRIPT = `
if redis.replicate_commands then redis.replicate_commands() end
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local burst_window = tonumber(ARGV[4])
local max_wait = tonumber(ARGV[5])
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000000 + tonumber(time[2])
local slot = now
local newest = redis.call('LINDEX', KEYS[1], 0)
if newest then slot = math.max(slot, tonumber(newest)) end
local oldest = redis.call('LINDEX', KEYS[1], limit - 1)
if oldest then slot = math.max(slot, tonumber(oldest) + window) end
if burst < limit then
  local oldest_burst = redis.call('LINDEX', KEYS[1], burst - 1)
  if oldest_burst then slot = math.max(slot, tonumber(oldest_burst) + burst_window) end
end
local wait = slot - now
if wait > max_wait then return {0, wait, slot} end
redis.call('LPUSH', KEYS[1], string.format('%d', slot))
redis.call('LTRIM', KEYS[1], 0, limit - 1)
redis.call('PEXPIRE', KEYS[1], string.format('%d', math.ceil((slot + window - now) / 1000)))
return {1, wait, slot}
`;

const SCRIPT_SHA = createHash('sha1').update(TOKEN_BUCKET_SCRIPT).digest('hex');

/**
 * Rate limiter shared by every process that uses the same Redis key (see `./bucket` for the
 * guarantee). Redis errors propagate: the limiter fails closed instead of letting calls through
 * unmetered.
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
    if (!Number.isFinite(this.params.maxWaitUs)) {
      throw new RangeError(`Token bucket ${key} needs a finite maximum wait`);
    }
  }

  /**
   * Reserves the next slot in Redis, or throws RateLimitedError (reserving nothing) when it is
   * more than `maxWaitMs` away.
   */
  async reserve(): Promise<Reservation> {
    const { granted, waitUs, slotUs } = parseReply(await this.run());
    if (!granted) throw new RateLimitedError(this.key, Math.ceil(waitUs / US_PER_MS));
    return { slotUs, waitUs };
  }

  async acquire(): Promise<void> {
    const waitMs = Math.ceil((await this.reserve()).waitUs / US_PER_MS);
    if (waitMs > 0) await this.clock.sleep(waitMs);
  }

  private async run(): Promise<unknown> {
    const { limit, windowUs, burst, burstWindowUs, maxWaitUs } = this.params;
    const args = [this.key, limit, windowUs, burst, burstWindowUs, maxWaitUs] as const;
    try {
      return await this.redis.evalsha(SCRIPT_SHA, 1, ...args);
    } catch (error) {
      // EVAL also caches the script, so later calls take the EVALSHA path again.
      if (!(error instanceof Error && error.message.startsWith('NOSCRIPT'))) throw error;
      return this.redis.eval(TOKEN_BUCKET_SCRIPT, 1, ...args);
    }
  }
}

function parseReply(reply: unknown): { granted: boolean; waitUs: number; slotUs: number } {
  if (Array.isArray(reply) && reply.length === 3) {
    const [granted, waitUs, slotUs] = reply.map(Number) as [number, number, number];
    if (
      (granted === 0 || granted === 1) &&
      Number.isSafeInteger(waitUs) &&
      waitUs >= 0 &&
      Number.isSafeInteger(slotUs) &&
      slotUs >= 0
    ) {
      return { granted: granted === 1, waitUs, slotUs };
    }
  }
  throw new Error(`Unexpected token bucket reply: ${JSON.stringify(reply)}`);
}
