import { describe, expect, it, vi } from 'vitest';
import { type Clock, TokenBucket, withRetry } from './throttling';

function fakeClock(): Clock & { time: number; sleeps: number[] } {
  const clock = {
    time: 0,
    sleeps: [] as number[],
    now: () => clock.time,
    sleep: (ms: number) => {
      clock.sleeps.push(ms);
      clock.time += ms;
      return Promise.resolve();
    },
  };
  return clock;
}

describe('TokenBucket', () => {
  it('lets the burst through, then spreads the rest of the second', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(
      { ratePerSecond: 5, burstSeconds: 0.4, maxWaitMs: Number.POSITIVE_INFINITY },
      clock,
    );
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.time).toBe(0);
    // Two calls per 400 ms, and five per second.
    await bucket.acquire();
    expect(clock.time).toBe(400);
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.time).toBe(800);
    await bucket.acquire();
    expect(clock.time).toBe(1000);
    expect(clock.sleeps).toEqual([400, 400, 200]);
  });

  it('serves concurrent callers in call order, each in its own slot', async () => {
    // Time stands still: every caller arrives at once.
    const sleeps: number[] = [];
    const clock: Clock = {
      now: () => 0,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    };
    const bucket = new TokenBucket({ ratePerSecond: 2, burstSeconds: 1, maxWaitMs: 5000 }, clock);
    const slots = Array.from({ length: 5 }, () => bucket.reserve().slotUs);
    expect(slots).toEqual([0, 0, 1_000_000, 1_000_000, 2_000_000]);
    // acquire() reserves before its first await, so concurrent callers keep their call order.
    await Promise.all([bucket.acquire(), bucket.acquire(), bucket.acquire()]);
    expect(sleeps).toEqual([2000, 3000, 3000]);
  });

  it('rejects with RateLimitedError naming the limiter when the wait is too long', async () => {
    const bucket = new TokenBucket(
      { ratePerSecond: 1, burstSeconds: 1, maxWaitMs: 0 },
      fakeClock(),
      'IndexFaces',
    );
    await bucket.acquire();
    await expect(bucket.acquire()).rejects.toMatchObject({
      name: 'RateLimitedError',
      limiter: 'IndexFaces',
      waitMs: 1000,
    });
  });
});

describe('withRetry', () => {
  const retryable = (error: unknown) => error instanceof Error && error.message === 'throttled';

  it('retries retryable errors with capped exponential backoff', async () => {
    const sleeps: number[] = [];
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockRejectedValueOnce(new Error('throttled'))
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValue('ok');
    const result = await withRetry(fn, retryable, {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 250,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      random: () => 0.999,
    });
    expect(result).toBe('ok');
    expect(sleeps).toEqual([99, 199, 249]);
  });

  it('gives up after maxAttempts', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('throttled'));
    const sleep = () => Promise.resolve();
    await expect(
      withRetry(fn, retryable, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1, sleep }),
    ).rejects.toThrow('throttled');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(new Error('access denied'));
    await expect(
      withRetry(fn, retryable, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 }),
    ).rejects.toThrow('access denied');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
