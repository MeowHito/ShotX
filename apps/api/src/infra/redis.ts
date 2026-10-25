import type { RedisConfig } from '@shotx/shared';
import { Redis } from 'ioredis';
import type { RateLimiter, RateLimitResult } from '../tokens';

/**
 * The API's Redis client. `enableReadyCheck: false` because the app user's ACL denies
 * `@dangerous`, which includes INFO (ADR 0005). `rediss://` URLs turn TLS on.
 */
export function createRedis(config: RedisConfig): Redis {
  return new Redis(config.url, {
    ...(config.credentials ?? {}),
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
}

/**
 * Fixed window: INCR, and set the expiry when the key is new (or somehow has none), atomically.
 * Every key gets a TTL (ADR 0005: Redis never evicts). Returns { count, ttlSeconds }.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/** Rate limits in Redis. Fails closed: any Redis error is "not allowed" (ADR 0005). */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Pick<Redis, 'eval'>,
    private readonly prefix: string,
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    try {
      const result = (await this.redis.eval(
        HIT_SCRIPT,
        1,
        `${this.prefix}rl:${key}`,
        String(windowSeconds),
      )) as [number, number];
      const [count, ttl] = result;
      return { allowed: count <= limit, retryAfterSeconds: Math.max(1, ttl) };
    } catch {
      return { allowed: false, retryAfterSeconds: windowSeconds };
    }
  }
}

/** In-process limiter for tests and local runs without Redis. Same semantics. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const now = this.now();
    let w = this.windows.get(key);
    if (w === undefined || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowSeconds * 1000 };
      this.windows.set(key, w);
    }
    w.count++;
    return Promise.resolve({
      allowed: w.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - now) / 1000)),
    });
  }
}
