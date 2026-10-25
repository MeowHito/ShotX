import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BucketOptions, type RedisScriptClient, RedisTokenBucket } from './redis-token-bucket';
import { type Clock, RateLimitedError } from './throttling';

const url = process.env.REDIS_URL;

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

  it('grants a burst, then spaces calls one interval apart', async () => {
    const { limiter, clock } = bucket({ ratePerSecond: 10, burstSeconds: 0.5, maxWaitMs: 5000 });
    for (let i = 0; i < 7; i++) await limiter.acquire();
    // Five tokens are free; the 6th and 7th reserve slots about 100 ms and 200 ms out.
    const waits = clock.sleeps;
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(50);
    expect(waits[0]).toBeLessThanOrEqual(100);
    expect(waits[1]! - waits[0]!).toBeGreaterThan(80);
    expect(waits[1]! - waits[0]!).toBeLessThanOrEqual(110);
  });

  it('gives every concurrent caller its own slot', async () => {
    const { limiter, clock } = bucket({ ratePerSecond: 20, burstSeconds: 0.25, maxWaitMs: 5000 });
    await Promise.all(Array.from({ length: 25 }, () => limiter.acquire()));
    // Capacity 5 at 20/s: 5 free calls, then 20 slots 50 ms apart.
    const waits = [...clock.sleeps].sort((a, b) => a - b);
    expect(waits).toHaveLength(20);
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i]! - waits[i - 1]!).toBeGreaterThanOrEqual(35);
      expect(waits[i]! - waits[i - 1]!).toBeLessThanOrEqual(65);
    }
    expect(waits.at(-1)).toBeLessThanOrEqual(1000);
  });

  it('shares one bucket between connections', async () => {
    const options = { ratePerSecond: 1, burstSeconds: 2, maxWaitMs: 0 };
    const a = bucket(options, redis);
    const b = new RedisTokenBucket(other, a.key, options, recordingClock());
    await a.limiter.acquire();
    await b.acquire();
    await expect(a.limiter.acquire()).rejects.toBeInstanceOf(RateLimitedError);
    await expect(b.acquire()).rejects.toBeInstanceOf(RateLimitedError);
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

  it('stores integer microseconds and expires the key once the bucket is full', async () => {
    const { key, limiter } = bucket({ ratePerSecond: 2, burstSeconds: 1, maxWaitMs: 0 });
    await limiter.acquire();
    const [value, ttl] = await Promise.all([redis.get(key), redis.pttl(key)]);
    expect(value).toMatch(/^\d{16,}$/);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(500);
  });
});
