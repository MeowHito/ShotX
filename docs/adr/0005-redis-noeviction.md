# ADR 0005: Redis never evicts (maxmemory-policy noeviction)

- Status: Accepted
- Date: 2026-10-25

## Context

ElastiCache Redis holds three kinds of data for api and worker:

- **Rate-limit state**: the per-IP, per-share and per-viewer face-search windows, and the
  Rekognition token buckets that every api and worker instance shares (packages/face
  `redis-token-bucket.ts`: LINDEX, LPUSH, LTRIM and PEXPIRE inside an EVAL that reads TIME).
- **face_only grants**: the file ids a viewer matched, kept for 24 h. In `face_only` mode every
  view and download must be in the grant.
- **Cache**: values that can be rebuilt from PostgreSQL or S3.

With the default ElastiCache parameter group (`volatile-lru`), a full Redis silently evicts keys
that have a TTL, and every key above has one. An evicted limiter window lets a burst through: the
per-IP face-search limit, or more Rekognition calls than the account quota, which turns into
throttling for everyone. An evicted grant makes a viewer's photos disappear mid-session, or
forces a new scan (another Rekognition call and another biometric processing step). None of this
shows up anywhere: no error, no metric that points at the cause.

The user decided that rate-limit keys and face_only grants must never be evicted.

## Decision

1. The replication group uses a custom parameter group (`infra/lib/stacks/data-stack.ts`,
   family `redis7` for engine version 7.1) with `maxmemory-policy noeviction`. This is a fixed
   decision, not a context value (`REDIS_PARAMETERS`).
2. A CloudWatch alarm, `shotx-<stage>-redis-memory`, fires when `DatabaseMemoryUsagePercentage`
   (used_memory / maxmemory) of the fullest node stays above
   `redis.alarms.memoryUsagePercentThreshold` (75%) for `redis.alarms.evaluationPeriods` 1-minute
   periods. It notifies the existing alarm topic (`AlarmTopicArn`).
3. The app user's access string also denies `@dangerous` (`on ~* &* +@all -@dangerous`), so no
   client can FLUSHALL, run KEYS over a full keyspace, or change CONFIG, including
   `maxmemory-policy`.

## Rationale

- With noeviction, a full Redis fails loudly: writes get
  `OOM command not allowed when used memory > 'maxmemory'`, and reads keep working. A loud
  failure is better than a limiter that silently stops limiting, or a grant that silently
  vanishes.
- The 75% alarm leaves room to act before writes fail: find keys that grow without bound, or
  move to a larger node type (`redis.nodeType`).
- The data is small and short-lived: windows are a few entries per key, grants are id lists
  with a 24 h TTL. Normal use should stay far below the threshold, so crossing it means a bug or
  abuse worth looking at.

## Alternatives considered

- **`volatile-lru` / `allkeys-lru` (evict under pressure).** Rejected: it evicts exactly the keys
  that must not disappear, silently.
- **`volatile-ttl` with longer TTLs on important keys.** Rejected: it still evicts limiter and
  grant keys, just in a different order, and couples correctness to TTL tuning.
- **A second Redis (or logical database) for cache with an LRU policy.** Not needed yet: there is
  no large cache. If one appears, give it its own replication group with `allkeys-lru` rather than
  changing this one. `maxmemory-policy` applies to the whole instance, not per database.
- **Keep grants in PostgreSQL.** Possible later if grants outgrow Redis. Today Redis TTLs fit
  their 24 h lifetime and avoid a cleanup job.

## Consequences

- **Every key must have a TTL.** With noeviction, nothing removes a key without one; it stays
  until someone deletes it. api and worker set an expiry on every write (`SET ... EX`, `EXPIRE`,
  `PEXPIRE`). Reviews reject keys without one.
- **Redis is not an LRU cache.** Code that caches in Redis must bound what it stores (TTL plus a
  bounded key space) and must not count on Redis making room. Large or unbounded caches belong
  elsewhere, in process memory or a separate cache cluster.
- **Write errors must fail closed.** When a rate-limit or grant write fails (OOM or any other
  error), the api denies the request (`RATE_LIMITED`, or no access in `face_only` mode). It never
  treats a failed limiter as "allowed". Reads of existing grants keep working.
- **Operations:** when the alarm fires, check the key count and memory by prefix (`SCAN` with a
  match, `MEMORY USAGE`; the app user can't run KEYS or INFO, so use an admin connection or the
  ElastiCache console), then fix the leak or scale the node type. Raising maxmemory by changing
  `reserved-memory-percent` only buys time.
- Changing the policy needs a new ADR. infra tests fail if the parameter group, its
  `noeviction` value or the alarm goes missing.
