import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisJobRunLedger } from './ledger';

const url = process.env.REDIS_URL;

describe.skipIf(!url)('RedisJobRunLedger against Redis', () => {
  const prefix = `test:worker:jobs:${randomUUID()}`;
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis(url!, {
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 1,
    });
    await redis.connect();
  });
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  it('remembers finished runs per (type, instant) with a TTL', async () => {
    const ledger = new RedisJobRunLedger(redis, prefix, 3600);
    expect(await ledger.isDone('trash.purge.daily', '2026-10-25T18:30:00Z')).toBe(false);
    await ledger.markDone('trash.purge.daily', '2026-10-25T18:30:00Z');
    expect(await ledger.isDone('trash.purge.daily', '2026-10-26T01:30:00+07:00')).toBe(true);
    expect(await ledger.isDone('quota.reconcile.nightly', '2026-10-25T18:30:00Z')).toBe(false);
    const ttl = await redis.ttl(`${prefix}:trash.purge.daily:2026-10-25T18:30:00.000Z`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });
});
