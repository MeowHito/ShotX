import { createPublicKey, createVerify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { redisKeyPrefix } from '../config';
import { requireCloudFront, testConfig } from '../testing/fakes';
import { CloudFrontMediaUrlSigner, mediaUrl } from './cloudfront-signer';
import { createRedis, MemoryRateLimiter, RedisRateLimiter } from './redis';

describe('CloudFront signer', () => {
  const config = testConfig();
  const signer = new CloudFrontMediaUrlSigner(requireCloudFront(config));
  const key =
    'derived/0b0f6b8e-0000-7000-8000-000000000001/0b0f6b8e-0000-7000-8000-000000000002/thumb.webp';

  it('signs media URLs under the CloudFront /media base with a canned policy', () => {
    const expiresAt = new Date('2026-10-25T06:00:00Z');
    const url = new URL(signer.sign(key, expiresAt));
    expect(`${url.origin}${url.pathname}`).toBe(`https://photos.example.com/media/${key}`);
    expect(url.searchParams.get('Expires')).toBe(String(expiresAt.getTime() / 1000));
    expect(url.searchParams.get('Key-Pair-Id')).toBe('K2JCJMDEHXQW5F');
    // The signature verifies with the public half of the configured key.
    const policy = JSON.stringify({
      Statement: [
        {
          Resource: `https://photos.example.com/media/${key}`,
          Condition: { DateLessThan: { 'AWS:EpochTime': expiresAt.getTime() / 1000 } },
        },
      ],
    });
    const signature = (url.searchParams.get('Signature') ?? '')
      .replace(/-/g, '+')
      .replace(/_/g, '=')
      .replace(/~/g, '/');
    const verify = createVerify('RSA-SHA1').update(policy);
    expect(
      verify.verify(createPublicKey(requireCloudFront(config).privateKey), signature, 'base64'),
    ).toBe(true);
  });

  it('refuses keys the platform did not build, and encodes key segments', () => {
    expect(() => signer.sign('../etc/passwd', new Date())).toThrow(RangeError);
    expect(mediaUrl('https://x.example/media', 'originals/p/f/งาน 1.jpg')).toBe(
      'https://x.example/media/originals/p/f/%E0%B8%87%E0%B8%B2%E0%B8%99%201.jpg',
    );
  });
});

describe('rate limiters', () => {
  it('RedisRateLimiter counts in a window and fails closed on Redis errors', async () => {
    let count = 0;
    const calls: unknown[][] = [];
    const ok = new RedisRateLimiter(
      {
        eval: (...args: unknown[]) => {
          calls.push(args);
          return Promise.resolve([++count, 42]);
        },
      },
      'shotx:test:api:',
    );
    expect(await ok.hit('upload-init:u', 2, 60)).toEqual({ allowed: true, retryAfterSeconds: 42 });
    expect((await ok.hit('upload-init:u', 2, 60)).allowed).toBe(true);
    expect((await ok.hit('upload-init:u', 2, 60)).allowed).toBe(false);
    expect(calls[0]?.slice(1)).toEqual([1, 'shotx:test:api:rl:upload-init:u', '60']);

    const broken = new RedisRateLimiter(
      { eval: () => Promise.reject(new Error('OOM command not allowed')) },
      'p:',
    );
    expect(await broken.hit('k', 100, 60)).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('MemoryRateLimiter resets after the window', async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(() => now);
    expect((await limiter.hit('k', 1, 10)).allowed).toBe(true);
    expect(await limiter.hit('k', 1, 10)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    now = 10_000;
    expect((await limiter.hit('k', 1, 10)).allowed).toBe(true);
  });

  const redisUrl = process.env.REDIS_URL ?? '';
  it.skipIf(redisUrl === '')('RedisRateLimiter sets a TTL on every key (real Redis)', async () => {
    const config = testConfig({ REDIS_URL: redisUrl, APP_STAGE: `t${process.pid}` });
    const redis = createRedis(config.redis);
    try {
      const prefix = redisKeyPrefix(config);
      const limiter = new RedisRateLimiter(redis, prefix);
      const key = `it:${Date.now()}`;
      expect((await limiter.hit(key, 1, 30)).allowed).toBe(true);
      expect((await limiter.hit(key, 1, 30)).allowed).toBe(false);
      const ttl = await redis.ttl(`${prefix}rl:${key}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
      await redis.del(`${prefix}rl:${key}`);
    } finally {
      redis.disconnect();
    }
  });
});
