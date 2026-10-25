import { randomUUID } from 'node:crypto';
import { activityEvents, dailyStats, shareDailyStats, shares } from '@shotx/db';
import { FakeFaceProvider, SyntheticWorld } from '@shotx/face/testing';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Db, rows } from '../db';
import { memoryLogger, silentLogger } from '../logger';
import {
  createFolder,
  createPhotographer,
  openTestDatabase,
  type TestDatabase,
} from '../testing/database';
import { MemoryObjectStore } from '../testing/memory-aws';
import type { JobContext } from './context';
import { createJobsHandler } from './handler';
import { MemoryJobRunLedger } from './ledger';
import { S3OrphanScanStore } from './orphan-scans';
import { runStatsRollup } from './stats-rollup';

/** 17:00 on 25 Oct in Bangkok: the run recomputes 24 and 25 Oct. */
const NOW = Date.parse('2026-10-25T10:00:00Z');

function ctx(db: Db, now = NOW): JobContext {
  return {
    db,
    store: new MemoryObjectStore(),
    faces: new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] })),
    log: silentLogger,
    now: () => now,
    batchSize: 100,
    deadline: now + 3_600_000,
    signal: new AbortController().signal,
  };
}

let tokenSeq = 0;

describe('stats.rollup.hourly', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  it('rolls share events into share_daily_stats and everything into daily_stats, per Bangkok day', async () => {
    const ownerId = await createPhotographer(db);
    const folder = await createFolder(db, ownerId);
    const shareIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [row] = await db
        .insert(shares)
        .values({
          ownerId,
          targetType: 'folder',
          targetFolderId: folder.id,
          token: `Sts${String(++tokenSeq).padStart(19, '0')}`,
        })
        .returning({ id: shares.id });
      shareIds.push(row!.id);
    }
    const [a, b] = shareIds as [string, string];
    const anon1 = randomUUID();
    const anon2 = randomUUID();
    const user1 = randomUUID();
    const fileId = randomUUID();
    const on25 = new Date('2026-10-25T03:00:00Z'); // 10:00 Bangkok
    const early25 = new Date('2026-10-24T18:30:00Z'); // 01:30 on the 25th in Bangkok
    const late24 = new Date('2026-10-24T16:00:00Z'); // 23:00 on the 24th in Bangkok
    const share = (shareId: string, v: { anonId?: string; viewerId?: string }) => ({
      source: 'share' as const,
      shareId,
      photographerId: ownerId,
      viewerId: v.viewerId ?? null,
      anonId: v.anonId ?? null,
    });
    await db.insert(activityEvents).values([
      { type: 'view', ...share(a, { anonId: anon1 }), meta: { items: 10 }, createdAt: on25 },
      { type: 'view', ...share(a, { anonId: anon1 }), meta: { items: 10 }, createdAt: early25 },
      { type: 'view', ...share(a, { viewerId: user1 }), meta: { items: 5 }, createdAt: on25 },
      { type: 'view', ...share(b, { anonId: anon1 }), meta: { items: 1 }, createdAt: on25 },
      { type: 'scan', ...share(a, { anonId: anon1 }), createdAt: on25 },
      { type: 'scan', ...share(a, { anonId: anon1 }), createdAt: on25 },
      { type: 'download', ...share(a, { anonId: anon1 }), fileId, bytes: 100, createdAt: on25 },
      { type: 'zip', ...share(a, { anonId: anon2 }), bytes: 1000, createdAt: on25 },
      { type: 'download', ...share(b, { viewerId: user1 }), fileId, bytes: 7, createdAt: late24 },
      {
        type: 'download',
        source: 'owner',
        shareId: null,
        photographerId: ownerId,
        fileId,
        bytes: 500,
        createdAt: on25,
      },
      // Outside the window: never touched by this run.
      { type: 'view', ...share(a, { anonId: anon2 }), createdAt: new Date('2026-10-20T03:00:00Z') },
    ]);
    // A stale row inside the window is replaced; a row outside it is kept.
    await db.insert(dailyStats).values([
      { date: '2026-10-24', photographerId: ownerId, visitors: 99 },
      { date: '2026-10-20', photographerId: ownerId, visitors: 42 },
    ]);

    const result = await runStatsRollup(ctx(db));
    expect(result).toMatchObject({ from: '2026-10-24', to: '2026-10-25' });

    const perShare = await db
      .select()
      .from(shareDailyStats)
      .where(eq(shareDailyStats.photographerId, ownerId))
      .orderBy(asc(shareDailyStats.date), asc(shareDailyStats.shareId));
    const pick = (shareId: string, date: string) =>
      perShare.find((r) => r.shareId === shareId && r.date === date);
    expect(pick(a, '2026-10-25')).toMatchObject({
      visitors: 2, // anon1 (twice) and user1
      scanners: 1,
      scans: 2,
      downloads: 1,
      uniqueDownloaders: 2, // anon1 downloaded, anon2 zipped
      zips: 1,
      bytesOut: 1100, // share bytes only, not the owner's download
    });
    expect(pick(b, '2026-10-25')).toMatchObject({ visitors: 1, downloads: 0, bytesOut: 0 });
    expect(pick(b, '2026-10-24')).toMatchObject({
      downloads: 1,
      uniqueDownloaders: 1,
      bytesOut: 7,
    });
    expect(perShare).toHaveLength(3);

    const daily = await db
      .select()
      .from(dailyStats)
      .where(eq(dailyStats.photographerId, ownerId))
      .orderBy(asc(dailyStats.date));
    expect(daily).toEqual([
      expect.objectContaining({ date: '2026-10-20', visitors: 42 }),
      expect.objectContaining({
        date: '2026-10-24',
        visitors: 0,
        downloads: 1,
        uniqueDownloaders: 1,
        bytesOut: 7,
      }),
      expect.objectContaining({
        date: '2026-10-25',
        visitors: 2, // distinct across shares: anon1 and user1
        scanners: 1,
        scans: 2,
        downloads: 1, // owner downloads aren't viewer downloads
        uniqueDownloaders: 2,
        bytesOut: 1600, // both sources
      }),
    ]);

    // Idempotent: a second run (or a redelivery) gives the same rows.
    await runStatsRollup(ctx(db, NOW + 60_000));
    const again = await db
      .select()
      .from(dailyStats)
      .where(eq(dailyStats.photographerId, ownerId))
      .orderBy(asc(dailyStats.date));
    expect(again).toEqual(daily);
    const shareAgain = await db
      .select({
        shareId: shareDailyStats.shareId,
        date: shareDailyStats.date,
        v: shareDailyStats.visitors,
        b: shareDailyStats.bytesOut,
      })
      .from(shareDailyStats)
      .where(eq(shareDailyStats.photographerId, ownerId));
    expect(shareAgain).toHaveLength(3);
  });

  it('keeps future activity_events partitions in place on every run', async () => {
    const name = sql`'activity_events_' || to_char(date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 months', 'YYYY_MM')`;
    const [target] = await rows<{ name: string }>(db, sql`SELECT ${name} AS "name"`);
    await db.execute(sql.raw(`DROP TABLE IF EXISTS public.${target!.name}`));
    const result = await runStatsRollup(ctx(db));
    expect(result.partitionsCreated).toBeGreaterThanOrEqual(1);
    const [row] = await rows<{ found: string | null }>(
      db,
      sql`SELECT to_regclass('public.' || ${name})::text AS "found"`,
    );
    expect(row?.found).toBe(target!.name);
  });

  it('runs from the jobs queue with the new face jobs, deduped like the others', async () => {
    const provider = new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] }));
    const store = new MemoryObjectStore();
    const handler = createJobsHandler({
      db,
      store,
      faces: provider,
      orphanScans: new S3OrphanScanStore(store),
      orphanGraceMs: 3_600_000,
      ledger: new MemoryJobRunLedger(),
      trashRetentionDays: 30,
      batchSize: 100,
      maxRuntimeMs: 3_600_000,
    });
    for (const type of ['stats.rollup.hourly', 'faces.expire.daily', 'faces.reconcile.daily']) {
      const log = memoryLogger();
      await handler(JSON.stringify({ type, scheduledTime: '2026-10-25T18:00:00Z' }), {
        messageId: 'm',
        receiveCount: 1,
        signal: new AbortController().signal,
        log,
      });
      expect(log.entries.map((e) => e.msg)).toContain('scheduled job finished');
    }
  });
});
