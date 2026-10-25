import type { RedisConfig } from '@shotx/shared';
import { Redis } from 'ioredis';
import type { KeyValueStore, RateLimiter, RateLimitResult } from '../tokens';

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

/** HGET + HDEL of one field in one step (feedback must not count a hit twice). */
const HASH_TAKE_SCRIPT = `
local value = redis.call('HGET', KEYS[1], ARGV[1])
if value then redis.call('HDEL', KEYS[1], ARGV[1]) end
return value
`;

/**
 * Merge-max of a hash, atomically: ARGV[1] is the TTL, then field/value pairs. Each field is set
 * only when missing or smaller (numeric compare), then the key gets its TTL (only when it exists,
 * so an empty merge never creates a key without fields). Returns the number of fields written.
 */
export const HASH_MERGE_MAX_SCRIPT = `
local written = 0
for i = 2, #ARGV, 2 do
  local field = ARGV[i]
  local value = ARGV[i + 1]
  local current = redis.call('HGET', KEYS[1], field)
  if (not current) or (tonumber(value) > tonumber(current)) then
    redis.call('HSET', KEYS[1], field, value)
    written = written + 1
  end
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return written
`;

/** The most fields one merge script call carries (Lua's unpack and argument limits). */
const MERGE_FIELDS_PER_CALL = 500;

type RedisStoreClient = Pick<Redis, 'get' | 'set' | 'del' | 'hgetall' | 'multi' | 'eval'>;

/**
 * KeyValueStore on Redis. Every key gets the service prefix, every write a TTL (ADR 0005), and
 * every error propagates so the caller denies the request (fails closed).
 */
export class RedisKeyValueStore implements KeyValueStore {
  constructor(
    private readonly redis: RedisStoreClient,
    private readonly prefix: string,
  ) {}

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(this.k(key));
  }

  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.k(key), value, 'EX', ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length > 0) await this.redis.del(...keys.map((key) => this.k(key)));
  }

  async hashGetAll(key: string): Promise<Record<string, string>> {
    return this.redis.hgetall(this.k(key));
  }

  async hashSetWithTtl(
    key: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void> {
    const multi = this.redis.multi();
    if (Object.keys(fields).length > 0) multi.hset(this.k(key), fields);
    multi.expire(this.k(key), ttlSeconds);
    const results = await multi.exec();
    // exec() resolves null when the transaction was discarded; each entry carries its own error.
    if (results === null) throw new Error('Redis transaction was discarded');
    for (const [error] of results) if (error) throw error;
  }

  async hashMergeMaxWithTtl(
    key: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void> {
    const entries = Object.entries(fields);
    for (const [field, value] of entries) {
      if (!Number.isFinite(Number(value))) throw new RangeError(`${field} is not a number`);
    }
    // Each call is atomic on its own and a merge-max is commutative, so splitting a very large
    // merge into several calls can't lose a field either.
    let i = 0;
    do {
      const batch = entries.slice(i, i + MERGE_FIELDS_PER_CALL).flat();
      await this.redis.eval(HASH_MERGE_MAX_SCRIPT, 1, this.k(key), String(ttlSeconds), ...batch);
      i += MERGE_FIELDS_PER_CALL;
    } while (i < entries.length);
  }

  async hashTake(key: string, field: string): Promise<string | null> {
    const value = (await this.redis.eval(HASH_TAKE_SCRIPT, 1, this.k(key), field)) as string | null;
    return value ?? null;
  }
}

type MemoryEntry = { value: string | Map<string, string>; expiresAt: number };

/** In-process KeyValueStore for tests and local runs, with TTLs on the given clock. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly data = new Map<string, MemoryEntry>();
  /** Make every call fail (Redis down), to test that callers fail closed. */
  failing = false;

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): MemoryEntry | undefined {
    const entry = this.data.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.data.delete(key);
      return undefined;
    }
    return entry;
  }

  private check(): Promise<void> {
    return this.failing ? Promise.reject(new Error('Redis unavailable')) : Promise.resolve();
  }

  /** Seconds a key has left, or null when it doesn't exist (for assertions). */
  ttlSeconds(key: string): number | null {
    const entry = this.live(key);
    return entry === undefined ? null : Math.ceil((entry.expiresAt - this.now()) / 1000);
  }

  /** Live keys (for assertions). */
  keys(): string[] {
    return [...this.data.keys()].filter((key) => this.live(key) !== undefined);
  }

  async get(key: string): Promise<string | null> {
    await this.check();
    const value = this.live(key)?.value;
    return typeof value === 'string' ? value : null;
  }

  async setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.check();
    this.data.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<void> {
    await this.check();
    for (const key of keys) this.data.delete(key);
  }

  async hashGetAll(key: string): Promise<Record<string, string>> {
    await this.check();
    const value = this.live(key)?.value;
    return value instanceof Map ? Object.fromEntries(value) : {};
  }

  async hashSetWithTtl(
    key: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void> {
    await this.check();
    const current = this.live(key)?.value;
    const hash = current instanceof Map ? current : new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) hash.set(field, value);
    if (hash.size > 0) {
      this.data.set(key, { value: hash, expiresAt: this.now() + ttlSeconds * 1000 });
    }
  }

  /** Same semantics as the Lua script; synchronous after the check, so it is atomic here too. */
  async hashMergeMaxWithTtl(
    key: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void> {
    await this.check();
    const current = this.live(key)?.value;
    const hash = current instanceof Map ? current : new Map<string, string>();
    for (const [field, value] of Object.entries(fields)) {
      if (!Number.isFinite(Number(value))) throw new RangeError(`${field} is not a number`);
      const existing = hash.get(field);
      if (existing === undefined || Number(value) > Number(existing)) hash.set(field, value);
    }
    if (hash.size > 0) {
      this.data.set(key, { value: hash, expiresAt: this.now() + ttlSeconds * 1000 });
    }
  }

  async hashTake(key: string, field: string): Promise<string | null> {
    await this.check();
    const value = this.live(key)?.value;
    if (!(value instanceof Map)) return null;
    const taken = value.get(field) ?? null;
    value.delete(field);
    if (value.size === 0) this.data.delete(key);
    return taken;
  }
}
