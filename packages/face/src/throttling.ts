import { ErrorCode } from '@shotx/shared';

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
 * In-process token bucket for tests and local evaluation. Production uses RedisTokenBucket, which
 * every API and worker instance shares.
 */
export class TokenBucket implements RateLimiter {
  private tokens: number;
  private last: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number = Math.max(1, Math.floor(ratePerSecond)),
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = burst;
    this.last = clock.now();
  }

  acquire(): Promise<void> {
    // Chain acquisitions so callers are served in order.
    const turn = this.queue.then(() => this.take());
    this.queue = turn;
    return turn;
  }

  private async take(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.tokens = Math.min(
        this.burst,
        this.tokens + ((now - this.last) / 1000) * this.ratePerSecond,
      );
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.clock.sleep(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
    }
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
