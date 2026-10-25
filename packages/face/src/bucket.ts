/**
 * The rate limit behind both `TokenBucket` (in-process) and `RedisTokenBucket` (Lua in Redis): a
 * sliding window over the most recent grants.
 *
 * AWS meters Rekognition quotas in calls per second, so the guarantee is about windows, not
 * averages: **no window of `windowUs` holds more than `limit` grants**, with `windowUs` = 1 s and
 * `limit` = floor(rate) for rates of 1/s and above. That holds from the first call on: an idle
 * bucket allows at most `burst` calls at once, never more than one second's quota. (A classic
 * token bucket holding a second's worth of tokens lets up to twice the rate through in the first
 * second, because it refills while the burst is being spent.)
 *
 * A grant's slot is the earliest time that keeps every window within its limit. Callers reserve
 * their slot and sleep until then, so waiters never poll. Slots never go backwards, so the stored
 * grants stay sorted.
 */

const US_PER_MS = 1000;
const US_PER_SECOND = 1_000_000;

export interface BucketOptions {
  /**
   * Calls per second. A sliding 1-second window never holds more than floor(rate) calls, so a
   * fractional rate is rounded down. Below 1, the bucket allows one call per 1/rate seconds.
   */
  ratePerSecond: number;
  /**
   * Seconds of quota that may start back to back: an idle bucket lets
   * max(1, floor(rate × min(burstSeconds, 1))) calls through at once, then spreads the rest of
   * the second's quota. Values of 1 and above allow the whole second's quota at once.
   */
  burstSeconds: number;
  /** Longest one call may wait for a slot before RateLimitedError. */
  maxWaitMs: number;
}

/** Bucket parameters in whole microseconds, so the Lua script's arithmetic stays exact. */
export interface BucketParams {
  /** At most `limit` grants in any window of `windowUs`. */
  limit: number;
  windowUs: number;
  /** At most `burst` (≤ `limit`) grants in any window of `burstWindowUs` (≤ `windowUs`). */
  burst: number;
  burstWindowUs: number;
  maxWaitUs: number;
}

/** Rounds up to whole milliseconds, so slots stay in order after callers round sleeps up to ms. */
function ceilToMs(us: number): number {
  return Math.ceil(us / US_PER_MS) * US_PER_MS;
}

export function bucketParams(options: BucketOptions): BucketParams {
  const { ratePerSecond: rate, burstSeconds, maxWaitMs } = options;
  if (
    !(rate > 0 && Number.isFinite(rate)) ||
    !(burstSeconds > 0 && Number.isFinite(burstSeconds)) ||
    !(maxWaitMs >= 0)
  ) {
    throw new RangeError(
      `Invalid token bucket: rate ${rate}/s, burst ${burstSeconds} s, wait ${maxWaitMs} ms`,
    );
  }
  const limit = Math.max(1, Math.floor(rate));
  // One second, or longer for rates below 1/s: one call per 1/rate seconds.
  const windowUs = rate >= 1 ? US_PER_SECOND : ceilToMs(US_PER_SECOND / rate);
  const burst = Math.max(1, Math.min(limit, Math.floor(rate * Math.min(burstSeconds, 1))));
  // `burst` calls per `burst / rate` seconds is the configured rate. When `burst` equals `limit`
  // the main window already implies it.
  const burstWindowUs = burst < limit ? ceilToMs((burst * US_PER_SECOND) / rate) : windowUs;
  return { limit, windowUs, burst, burstWindowUs, maxWaitUs: Math.floor(maxWaitMs * US_PER_MS) };
}

/**
 * The earliest slot at or after `nowUs` for the next grant. `recent` holds the latest grants,
 * newest first; only the first `limit` matter. `TOKEN_BUCKET_SCRIPT` is the same function in Lua.
 */
export function nextSlotUs(recent: readonly number[], nowUs: number, params: BucketParams): number {
  let slot = nowUs;
  // Slots never go backwards, even if the clock does.
  const newest = recent[0];
  if (newest !== undefined) slot = Math.max(slot, newest);
  const oldestInWindow = recent[params.limit - 1];
  if (oldestInWindow !== undefined) slot = Math.max(slot, oldestInWindow + params.windowUs);
  if (params.burst < params.limit) {
    const oldestInBurst = recent[params.burst - 1];
    if (oldestInBurst !== undefined) slot = Math.max(slot, oldestInBurst + params.burstWindowUs);
  }
  return slot;
}

/** A reserved slot: the call may start `waitUs` after the reservation was made. */
export interface Reservation {
  /** Microseconds on the bucket's clock (Redis server time for RedisTokenBucket). */
  slotUs: number;
  waitUs: number;
}
