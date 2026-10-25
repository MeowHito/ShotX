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
  it('allows a burst, then one call per 1/rate seconds', async () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 2, clock);
    await bucket.acquire();
    await bucket.acquire();
    expect(clock.time).toBe(0);
    await bucket.acquire();
    expect(clock.time).toBe(200);
    await Promise.all([bucket.acquire(), bucket.acquire()]);
    expect(clock.time).toBe(600);
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
