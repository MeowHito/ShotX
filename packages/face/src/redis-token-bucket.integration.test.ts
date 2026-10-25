import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BucketOptions } from './bucket';
import { type RedisScriptClient, RedisTokenBucket } from './redis-token-bucket';
import { type Clock, RateLimitedError } from './throttling';

const url = process.env.REDIS_URL;
const SECOND_US = 1_000_000;

/** Records how long each caller was told to wait instead of sleeping. */
function recordingClock(): Clock & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => Date.now(),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

/** The most grants in any half-open window [t, t + windowUs); see bucket.test.ts. */
function maxInWindow(slots: readonly number[], windowUs: number): number {
  const sorted = [...slots].sort((a, b) => a - b);
  let max = 0;
  let end = 0;
  for (let start = 0; start < sorted.length; start++) {
    while (end < sorted.length && sorted[end]! < sorted[start]! + windowUs) end++;
    max = Math.max(max, end - start);
  }
  return max;
}

describe.skipIf(!url)('RedisTokenBucket against Redis', () => {
  const prefix = `test:face:${randomUUID()}`;
  let redis: Redis;
  let other: Redis;
  let n = 0;

  beforeAll(async () => {
    redis = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    other = new Redis(url!, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await Promise.all([redis.connect(), other.connect()]);
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await Promise.all([redis.quit(), other.quit()]);
  });

  function bucket(options: BucketOptions, client: RedisScriptClient = redis) {
    const clock = recordingClock();
    const key = `${prefix}:${++n}`;
    return { key, clock, limiter: new RedisTokenBucket(client, key, options, clock) };
  }

  for (const [ratePerSecond, burstSeconds] of [
    [10, 1],
    [10, 0.3],
    [7, 0.05],
    [3.5, 2.5],
    [50, 0.5],
    [0.5, 1],
  ] as const) {
    it(`never grants more than ${ratePerSecond}/s in any 1-second window (burst ${burstSeconds} s)`, async () => {
      const options = { ratePerSecond, burstSeconds, maxWaitMs: 60_000 };
      const a = bucket(options, redis);
      const b = new RedisTokenBucket(other, a.key, options);
      const { limit, burst, windowUs } = a.limiter.params;
      // Three windows' quota from two connections at once, against an idle bucket.
      const reservations = await Promise.all(
        Array.from({ length: 3 * limit }, (_, i) => (i % 2 ? b : a.limiter).reserve()),
      );
      const slots = reservations.map((r) => r.slotUs);
      expect(maxInWindow(slots, SECOND_US)).toBeLessThanOrEqual(
        Math.max(1, Math.floor(ratePerSecond)),
      );
      expect(maxInWindow(slots, windowUs)).toBeLessThanOrEqual(limit);
      // An idle bucket lets the burst through at once, and no more.
      expect(reservations.filter((r) => r.waitUs === 0)).toHaveLength(burst);
      expect(Math.max(...slots) - Math.min(...slots)).toBeLessThan(3 * windowUs);
    });
  }

  it('lets one second of quota through at once, then waits for the window', async () => {
    const { limiter, clock } = bucket({ ratePerSecond: 10, burstSeconds: 1, maxWaitMs: 5000 });
    for (let i = 0; i < 12; i++) await limiter.acquire();
    // Ten calls are free; the 11th and 12th wait until the first ones leave the window.
    expect(clock.sleeps).toHaveLength(2);
    for (const wait of clock.sleeps) {
      expect(wait).toBeGreaterThan(800);
      expect(wait).toBeLessThanOrEqual(1000);
    }
  });

  it('shares one bucket between connections', async () => {
    const options = { ratePerSecond: 1, burstSeconds: 1, maxWaitMs: 0 };
    const a = bucket(options, redis);
    const b = new RedisTokenBucket(other, a.key, options, recordingClock());
    await a.limiter.acquire();
    await expect(b.acquire()).rejects.toBeInstanceOf(RateLimitedError);
    await expect(a.limiter.acquire()).rejects.toBeInstanceOf(RateLimitedError);
  });

  it('does not reserve a slot when it refuses a call', async () => {
    const { limiter } = bucket({ ratePerSecond: 1, burstSeconds: 1, maxWaitMs: 400 });
    await limiter.acquire();
    const first: unknown = await limiter.acquire().catch((e: unknown) => e);
    const second: unknown = await limiter.acquire().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(RateLimitedError);
    expect(second).toBeInstanceOf(RateLimitedError);
    // Had the first refusal reserved a slot, the second would have to wait about 2 s.
    expect((second as RateLimitedError).waitMs).toBeLessThanOrEqual(1000);
  });

  it('stores integer microseconds and expires the key once the window is empty', async () => {
    const { key, limiter } = bucket({ ratePerSecond: 2, burstSeconds: 1, maxWaitMs: 5000 });
    for (let i = 0; i < 3; i++) await limiter.reserve();
    const [values, ttl] = await Promise.all([redis.lrange(key, 0, -1), redis.pttl(key)]);
    // Only the latest `limit` grants are kept, newest first.
    expect(values).toHaveLength(2);
    for (const value of values) expect(value).toMatch(/^\d{16,}$/);
    expect(Number(values[0])).toBeGreaterThanOrEqual(Number(values[1]));
    expect(ttl).toBeGreaterThan(1000);
    expect(ttl).toBeLessThanOrEqual(2000);
  });
});
