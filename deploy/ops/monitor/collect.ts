import { readFile, statfs } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { bullMqPrefix, QUEUE_NAMES } from '@shotx/shared';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { DbStats, HostStats, QueueStats, RedisMemory } from './checks';

// Reads one round's data. Queue sizes come straight from BullMQ's keys with read-only commands
// (the monitor's Redis user has %R~* and no scripts): `<prefix>:<queue>:failed` is a sorted set,
// `:wait` and `:paused` are lists that BullMQ LPUSHes, so the oldest job id is the last element,
// and the job hash has its creation time in `timestamp` (ms). Checked against bullmq 6.3.

/** BullMQ 5 left `0:<n>` marker entries in wait lists; they are not jobs. */
const isMarker = (id: string) => id.startsWith('0:');

export async function queueStats(redis: Redis, stage: string, now: Date): Promise<QueueStats[]> {
  const prefix = bullMqPrefix(stage);
  const out: QueueStats[] = [];
  for (const queue of QUEUE_NAMES) {
    const base = `${prefix}:${queue}`;
    const failed = await redis.zcard(`${base}:failed`);
    let waiting = 0;
    let oldest: number | null = null;
    for (const list of ['wait', 'paused'] as const) {
      const key = `${base}:${list}`;
      const length = await redis.llen(key);
      if (length === 0) continue;
      const tail = await redis.lindex(key, -1);
      const markerAtTail = tail !== null && isMarker(tail);
      waiting += markerAtTail ? length - 1 : length;
      const id = markerAtTail ? (length > 1 ? await redis.lindex(key, -2) : null) : tail;
      if (id === null) continue;
      const ts = Number(await redis.hget(`${base}:${id}`, 'timestamp'));
      if (Number.isFinite(ts) && ts > 0) {
        const age = (now.getTime() - ts) / 1000;
        oldest = oldest === null ? age : Math.max(oldest, age);
      }
    }
    out.push({ queue, failed, waiting, oldestWaitingSeconds: oldest });
  }
  return out;
}

/** `used_memory` and `maxmemory` from `INFO memory`. */
export function parseInfoMemory(info: string): RedisMemory {
  const field = (name: string) => {
    const m = new RegExp(`^${name}:(\\d+)\\s*$`, 'm').exec(info);
    if (m === null) throw new Error(`INFO memory has no ${name}`);
    return Number(m[1]);
  };
  return { usedBytes: field('used_memory'), maxBytes: field('maxmemory') };
}

export async function redisMemory(redis: Redis): Promise<RedisMemory> {
  return parseInfoMemory(await redis.info('memory'));
}

export interface DbThresholds {
  /** MEDIA_SWEEP_PROCESSING_AGE_SECONDS and MEDIA_SWEEP_MAX_REQUEUES (the sweep gave up). */
  media: { processingAgeSeconds: number; maxRequeues: number };
  faceDeletionMaxAgeSeconds: number;
  faceDeletionAlert: { perShare: number; windowSeconds: number };
  maxIds: number;
}

/** The SQL, with column grants for exactly these columns (deploy/ops/migrate.ts MONITOR_GRANTS). */
export const DB_QUERIES = {
  stuckProcessing: `
    SELECT id::text AS id, count(id) OVER () AS total
    FROM files
    WHERE status = 'processing' AND deleted_at IS NULL AND media_requeues >= $1
      AND COALESCE(media_queued_at, created_at) < now() - make_interval(secs => $2)
    ORDER BY created_at
    LIMIT $3`,
  openFaceDeletions: `
    SELECT id::text AS id, count(id) OVER () AS total,
           extract(epoch FROM now() - min(created_at) OVER ())::float8 AS oldest
    FROM face_deletions
    WHERE completed_at IS NULL AND created_at < now() - make_interval(secs => $1)
    ORDER BY created_at
    LIMIT $2`,
  faceDeletionsPerShare: `
    SELECT share_id::text AS share_id, count(id)::int AS n
    FROM face_deletions
    WHERE created_at > now() - make_interval(secs => $1)
    GROUP BY share_id
    HAVING count(id) >= $2
    ORDER BY n DESC
    LIMIT 100`,
} as const;

export async function dbStats(pool: Pool, t: DbThresholds): Promise<DbStats> {
  const limit = Math.max(t.maxIds, 1);
  const stuck = await pool.query<{ id: string; total: string }>(DB_QUERIES.stuckProcessing, [
    t.media.maxRequeues,
    t.media.processingAgeSeconds,
    limit,
  ]);
  const open = await pool.query<{ id: string; total: string; oldest: number }>(
    DB_QUERIES.openFaceDeletions,
    [t.faceDeletionMaxAgeSeconds, limit],
  );
  const perShare = await pool.query<{ share_id: string; n: number }>(
    DB_QUERIES.faceDeletionsPerShare,
    [t.faceDeletionAlert.windowSeconds, t.faceDeletionAlert.perShare],
  );
  return {
    stuckProcessing: { count: Number(stuck.rows[0]?.total ?? 0), ids: stuck.rows.map((r) => r.id) },
    openFaceDeletions: {
      count: Number(open.rows[0]?.total ?? 0),
      ids: open.rows.map((r) => r.id),
      oldestSeconds: open.rows[0]?.oldest ?? null,
    },
    faceDeletionsPerShare: perShare.rows.map((r) => ({ shareId: r.share_id, count: r.n })),
  };
}

/** MemTotal, MemAvailable and SwapTotal (bytes) from /proc/meminfo. */
export function parseMeminfo(text: string) {
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text);
    if (m === null) throw new Error(`/proc/meminfo has no ${name}`);
    return Number(m[1]) * 1024;
  };
  return {
    memTotalBytes: kb('MemTotal'),
    memAvailableBytes: kb('MemAvailable'),
    swapTotalBytes: kb('SwapTotal'),
  };
}

/** The 5-minute load average from /proc/loadavg. */
export function parseLoadavg(text: string): number {
  const value = Number(text.trim().split(/\s+/)[1]);
  if (!Number.isFinite(value)) throw new Error('/proc/loadavg is not readable');
  return value;
}

/**
 * Host figures as a container sees them: /proc/meminfo and /proc/loadavg are the host's (Docker
 * doesn't virtualise them), and statfs on a mounted volume reports the host filesystem it lives on.
 */
export async function hostStats(diskPaths: readonly string[]): Promise<HostStats> {
  const mem = parseMeminfo(await readFile('/proc/meminfo', 'utf8'));
  const load5 = parseLoadavg(await readFile('/proc/loadavg', 'utf8'));
  const disks = [];
  for (const path of diskPaths) {
    const s = await statfs(path);
    disks.push({ path, totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize });
  }
  return { ...mem, load5, cpus: availableParallelism(), disks };
}
