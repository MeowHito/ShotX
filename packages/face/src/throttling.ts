import { ErrorCode } from '@shotx/shared';
import {
  type BucketOptions,
  type BucketParams,
  bucketParams,
  nextSlotUs,
  type Reservation,
} from './bucket';

const US_PER_MS = 1000;

export interface RateLimiter {
  /**
   * Resolves when the caller may make one call. Throws RateLimitedError when the caller would have
   * to wait longer than the limiter allows.
   */
  acquire(): Promise<void>;
}

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A rate limiter refused a call because the next free slot is too far away. */
export class RateLimitedError extends Error {
  readonly code = ErrorCode.RATE_LIMITED;

  constructor(
    readonly limiter: string,
    /** How long the caller would have had to wait for a slot. */
    readonly waitMs: number,
  ) {
    super(`Rate limit ${limiter}: next slot in ${waitMs} ms`);
    this.name = 'RateLimitedError';
  }
}

/**
 * In-process rate limiter for tests and local evaluation, with the same algorithm and parameters
 * as RedisTokenBucket (see `./bucket`). Production uses RedisTokenBucket, which every API and
 * worker instance shares.
 */
export class TokenBucket implements RateLimiter {
  readonly params: BucketParams;
  /** Latest grants in microseconds of `clock` time, newest first; at most `params.limit`. */
  private readonly recent: number[] = [];

  constructor(
    options: BucketOptions,
    private readonly clock: Clock = systemClock,
    /** Names the limiter in RateLimitedError. */
    readonly name = 'local',
  ) {
    this.params = bucketParams(options);
  }

  /**
   * Reserves the next slot, or throws RateLimitedError (reserving nothing) when it is more than
   * `maxWaitMs` away. Synchronous, so callers get slots in call order.
   */
  reserve(): Reservation {
    const nowUs = this.clock.now() * US_PER_MS;
    const slotUs = nextSlotUs(this.recent, nowUs, this.params);
    const waitUs = slotUs - nowUs;
    if (waitUs > this.params.maxWaitUs) {
      throw new RateLimitedError(this.name, Math.ceil(waitUs / US_PER_MS));
    }
    this.recent.unshift(slotUs);
    if (this.recent.length > this.params.limit) this.recent.length = this.params.limit;
    return { slotUs, waitUs };
  }

  async acquire(): Promise<void> {
    const waitMs = Math.ceil(this.reserve().waitUs / US_PER_MS);
    if (waitMs > 0) await this.clock.sleep(waitMs);
  }
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Calls `fn`, retrying retryable errors with full-jitter exponential backoff. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? systemClock.sleep;
  const random = options.random ?? Math.random;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= options.maxAttempts || !isRetryable(error)) throw error;
      const cap = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.floor(random() * cap));
    }
  }
}
