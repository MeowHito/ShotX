import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  bucketParams,
  type RedisScriptClient,
  RedisTokenBucket,
  TOKEN_BUCKET_SCRIPT,
} from './redis-token-bucket';
import { RateLimitedError } from './throttling';

const sha = createHash('sha1').update(TOKEN_BUCKET_SCRIPT).digest('hex');

function fakeRedis(replies: Array<unknown>) {
  const evalsha = vi.fn<RedisScriptClient['evalsha']>(() => {
    const reply = replies.shift();
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  });
  const evalScript = vi.fn<RedisScriptClient['eval']>(() => Promise.resolve(replies.shift()));
  const client: RedisScriptClient = { evalsha, eval: evalScript };
  return { client, evalsha, evalScript };
}

function recordingClock() {
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => 0,
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

const options = { ratePerSecond: 5, burstSeconds: 1, maxWaitMs: 2000 };

describe('bucketParams', () => {
  it('converts rate, burst and wait to whole microseconds', () => {
    expect(bucketParams(options)).toEqual({
      capacity: 5,
      intervalUs: 200_000,
      toleranceUs: 800_000,
      maxWaitUs: 2_000_000,
    });
  });

  it('keeps at least one token and rounds the interval up', () => {
    expect(bucketParams({ ratePerSecond: 3, burstSeconds: 0.1, maxWaitMs: 0 })).toEqual({
      capacity: 1,
      intervalUs: 333_334,
      toleranceUs: 0,
      maxWaitUs: 0,
    });
  });

  it('rejects rates and waits that make no sense', () => {
    expect(() => bucketParams({ ...options, ratePerSecond: 0 })).toThrow(RangeError);
    expect(() => bucketParams({ ...options, burstSeconds: -1 })).toThrow(RangeError);
    expect(() => bucketParams({ ...options, maxWaitMs: -1 })).toThrow(RangeError);
    expect(() => bucketParams({ ...options, ratePerSecond: Number.NaN })).toThrow(RangeError);
  });
});

describe('RedisTokenBucket', () => {
  it('runs the script by SHA with the key and parameters', async () => {
    const { client, evalsha } = fakeRedis([[1, 0]]);
    const clock = recordingClock();
    await new RedisTokenBucket(client, 'k:ap-southeast-1:IndexFaces', options, clock).acquire();
    expect(evalsha).toHaveBeenCalledWith(
      sha,
      1,
      'k:ap-southeast-1:IndexFaces',
      200_000,
      800_000,
      2_000_000,
    );
    expect(clock.sleeps).toEqual([]);
  });

  it('sleeps until the reserved slot', async () => {
    const { client } = fakeRedis([[1, 150_400]]);
    const clock = recordingClock();
    await new RedisTokenBucket(client, 'k', options, clock).acquire();
    expect(clock.sleeps).toEqual([151]);
  });

  it('throws RateLimitedError when the slot is beyond the maximum wait', async () => {
    const { client } = fakeRedis([[0, 2_500_000]]);
    const clock = recordingClock();
    const error: unknown = await new RedisTokenBucket(client, 'k', options, clock)
      .acquire()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', waitMs: 2500, limiter: 'k' });
    expect(clock.sleeps).toEqual([]);
  });

  it('loads the script with EVAL when Redis does not have it cached', async () => {
    const { client, evalsha, evalScript } = fakeRedis([
      new Error('NOSCRIPT No matching script. Please use EVAL.'),
      [1, 0],
    ]);
    await new RedisTokenBucket(client, 'k', options, recordingClock()).acquire();
    expect(evalsha).toHaveBeenCalledTimes(1);
    expect(evalScript).toHaveBeenCalledWith(
      TOKEN_BUCKET_SCRIPT,
      1,
      'k',
      200_000,
      800_000,
      2_000_000,
    );
  });

  it('fails closed on Redis errors', async () => {
    const { client, evalScript } = fakeRedis([new Error('connect ECONNREFUSED 127.0.0.1:6379')]);
    await expect(
      new RedisTokenBucket(client, 'k', options, recordingClock()).acquire(),
    ).rejects.toThrow('ECONNREFUSED');
    expect(evalScript).not.toHaveBeenCalled();
  });

  it('rejects malformed replies', async () => {
    for (const reply of [null, [1], [2, 0], [1, -5], ['x', 0]]) {
      const { client } = fakeRedis([reply]);
      await expect(
        new RedisTokenBucket(client, 'k', options, recordingClock()).acquire(),
      ).rejects.toThrow(/Unexpected token bucket reply/);
    }
  });
});
