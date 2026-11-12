import { randomUUID } from 'node:crypto';
import { designAssets, storageUsage } from '@shotx/db';
import { FakeFaceProvider, SyntheticWorld } from '@shotx/face/testing';
import { designAssetKey, loadWorkerSettings, parseQueueMessage } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { memoryLogger, silentLogger } from '../logger';
import {
  createDesign,
  createDesignAsset,
  createPhotographer,
  designAssetById,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../testing/database';
import { TEST_DESTINATIONS, testJobQueues } from '../testing/jobs';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import type { JobContext } from './context';
import { requestDuePurges, runDesignAssetPurge } from './design-assets-purge';
import { createJobsHandler } from './handler';
import { MemoryJobRunLedger } from './ledger';
import { runMediaSweep } from './media-sweep';
import { S3OrphanScanStore } from './orphan-scans';
import { runQuotaReconcile } from './quota-reconcile';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const SWEEPS = loadWorkerSettings({}).sweeps;
const ORPHAN_DAYS = 30;

function provider(): FakeFaceProvider {
  return new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] }));
}

function jobContext(
  db: Db,
  store: MemoryObjectStore,
  options: { queues?: MemoryQueueClient; log?: ReturnType<typeof memoryLogger> } = {},
): JobContext {
  return {
    db,
    store,
    queues: options.queues ?? new MemoryQueueClient(),
    destinations: { ...TEST_DESTINATIONS },
    faces: provider(),
    log: options.log ?? silentLogger,
    now: Date.now,
    batchSize: 2, // small, so batching paths run
    deadline: Date.now() + HOUR,
    signal: new AbortController().signal,
  };
}

/** Both objects of an asset in the store. */
function seedAsset(
  store: MemoryObjectStore,
  asset: { originalKey: string; webKey: string },
  size: number,
) {
  store.seed(asset.originalKey, new Uint8Array(size));
  store.seed(asset.webKey, new Uint8Array(1));
}

describe('design images in the scheduled jobs (ADR 0013)', () => {
  let database: TestDatabase;
  let db: Db;

  // A fresh database per test: the jobs scan every photographer, and the counts are exact.
  beforeEach(async () => {
    database = await openTestDatabase();
    db = database.db;
  });
  afterEach(async () => {
    await database.close();
  });

  describe('media.sweep', () => {
    it('re-sends design.asset for stale processing rows once per window, up to the cap', async () => {
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db, { reservedBytes: 4000 });
      const stale = await createDesignAsset(db, ownerId, { queuedAt: ago(7 * HOUR) });
      const fresh = await createDesignAsset(db, ownerId, { queuedAt: ago(HOUR) });
      const capped = await createDesignAsset(db, ownerId, {
        queuedAt: ago(9 * HOUR),
        requeues: SWEEPS.media.maxRequeues,
      });
      const purging = await createDesignAsset(db, ownerId, {
        queuedAt: ago(9 * HOUR),
        purgeRequestedAt: ago(HOUR),
      });
      const ready = await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(9 * HOUR),
        width: 10,
        height: 10,
        queuedAt: ago(9 * HOUR),
      });
      const log = memoryLogger();

      const result = await runMediaSweep(
        jobContext(db, new MemoryObjectStore(), { queues, log }),
        SWEEPS.media,
      );
      expect(result).toMatchObject({ designAssetsRequeued: 1, designAssetsOverCap: 1 });
      const sent = queues.sent
        .filter((m) => m.queueUrl === TEST_DESTINATIONS.media)
        .map((m) => parseQueueMessage('media', m.body));
      expect(sent).toEqual([{ kind: 'design.asset', assetId: stale.id, photographerId: ownerId }]);
      const bumped = await designAssetById(db, stale.id);
      expect(bumped?.requeues).toBe(1);
      expect(bumped!.queuedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      for (const id of [fresh.id, purging.id, ready.id]) {
        expect((await designAssetById(db, id))?.requeues).toBe(0);
      }
      const report = log.entries.find(
        (e) => e.level === 'error' && e.msg.startsWith('design images stuck'),
      );
      expect(report?.fields).toMatchObject({ count: 1, assetIds: capped.id });

      // Within the window nothing is sent twice.
      await runMediaSweep(jobContext(db, new MemoryObjectStore(), { queues }), SWEEPS.media);
      expect(queues.sent.filter((m) => m.queueUrl === TEST_DESTINATIONS.media)).toHaveLength(1);
    });
  });

  describe('trash.purge.daily: orphaned design images', () => {
    it('marks, clears and purges by what the owner designs reference', async () => {
      const store = new MemoryObjectStore();
      const size = 500;
      const ownerId = await createPhotographer(db, { usedBytes: 6 * size });
      const other = await createPhotographer(db, { usedBytes: size });
      const verified = { status: 'ready' as const, verifiedAt: ago(40 * DAY), width: 1, height: 1 };
      const bg = await createDesignAsset(db, ownerId, { ...verified, sizeBytes: size });
      const logo = await createDesignAsset(db, ownerId, { ...verified, sizeBytes: size });
      const unused = await createDesignAsset(db, ownerId, { ...verified, sizeBytes: size });
      const due = await createDesignAsset(db, ownerId, {
        ...verified,
        sizeBytes: size,
        orphanedAt: ago(31 * DAY),
      });
      const notYet = await createDesignAsset(db, ownerId, {
        ...verified,
        sizeBytes: size,
        orphanedAt: ago(29 * DAY),
      });
      // Orphaned long ago, but a design uses it again: kept, the mark cleared.
      const reused = await createDesignAsset(db, ownerId, {
        ...verified,
        sizeBytes: size,
        orphanedAt: ago(31 * DAY),
      });
      // A rejected upload (nothing counted) orphaned long ago: purged without a quota move.
      const rejected = await createDesignAsset(db, ownerId, {
        status: 'failed',
        sizeBytes: size,
        orphanedAt: ago(31 * DAY),
      });
      const uploading = await createDesignAsset(db, ownerId, { status: 'uploading' });
      // Another photographer's design naming this owner's asset id does not keep it.
      const foreignRef = await createDesignAsset(db, other, { ...verified, sizeBytes: size });
      await createDesign(db, ownerId, { backgroundAssetId: bg.id, imageAssetIds: [logo.id] });
      await createDesign(db, ownerId, { imageAssetIds: [reused.id] });
      await createDesign(db, other, { imageAssetIds: [unused.id, foreignRef.id] });
      for (const a of [bg, logo, unused, due, notYet, reused, rejected, foreignRef]) {
        seedAsset(store, a, size);
      }

      const result = await runDesignAssetPurge(jobContext(db, store), ORPHAN_DAYS);
      expect(result).toMatchObject({
        designAssetsOrphaned: 1, // unused
        designAssetsReclaimed: 1, // reused
        designAssetsRequested: 2, // due, rejected
        designAssetsPurged: 2,
        designAssetsSkipped: 0,
        complete: true,
      });

      for (const a of [bg, logo, foreignRef]) {
        expect((await designAssetById(db, a.id))?.orphanedAt).toBeNull();
      }
      expect((await designAssetById(db, unused.id))?.orphanedAt).toBeInstanceOf(Date);
      expect((await designAssetById(db, notYet.id))?.orphanedAt).toBeInstanceOf(Date);
      expect((await designAssetById(db, reused.id))?.orphanedAt).toBeNull();
      expect((await designAssetById(db, uploading.id))?.orphanedAt).toBeNull();
      for (const a of [due, rejected]) {
        expect(await designAssetById(db, a.id)).toBeUndefined();
        expect(store.objects.has(a.originalKey)).toBe(false);
        expect(store.objects.has(a.webKey)).toBe(false);
      }
      expect(store.objects.has(reused.originalKey)).toBe(true);
      expect(store.objects.has(unused.originalKey)).toBe(true);
      // Only the verified purge left used; the failed one counted nowhere.
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 5 * size, reservedBytes: 0 });
      expect(await usageOf(db, other)).toEqual({ usedBytes: size, reservedBytes: 0 });

      // Idempotent: a second run changes nothing.
      const again = await runDesignAssetPurge(jobContext(db, store), ORPHAN_DAYS);
      expect(again).toMatchObject({
        designAssetsOrphaned: 0,
        designAssetsReclaimed: 0,
        designAssetsRequested: 0,
        designAssetsPurged: 0,
      });
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 5 * size, reservedBytes: 0 });
    });

    it('re-checks under lock: a design saved after the marking keeps the image', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db, { usedBytes: 100 });
      const asset = await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(40 * DAY),
        width: 1,
        height: 1,
        sizeBytes: 100,
        orphanedAt: ago(31 * DAY),
      });
      // The marking (step 1) ran before this save; the purge request must still see it.
      await createDesign(db, ownerId, { imageAssetIds: [asset.id] });
      const result = await requestDuePurges(jobContext(db, store), ago(ORPHAN_DAYS * DAY));
      expect(result).toEqual({ requested: 0, reclaimed: 1 });
      const row = await designAssetById(db, asset.id);
      expect(row?.orphanedAt).toBeNull();
      expect(row?.purgeRequestedAt).toBeNull();
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 100, reservedBytes: 0 });
    });

    it('finishes purges a crash left, and keeps rows whose objects could not be deleted', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db);
      const leftover = await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(40 * DAY),
        width: 1,
        height: 1,
        orphanedAt: ago(31 * DAY),
        purgeRequestedAt: ago(DAY),
      });
      seedAsset(store, leftover, 100);
      store.failDeletes = true;
      const failed = await runDesignAssetPurge(jobContext(db, store), ORPHAN_DAYS);
      expect(failed).toMatchObject({ designAssetsPurged: 0, designAssetsSkipped: 1 });
      expect(await designAssetById(db, leftover.id)).toBeDefined();

      store.failDeletes = false;
      const done = await runDesignAssetPurge(jobContext(db, store), ORPHAN_DAYS);
      expect(done).toMatchObject({ designAssetsPurged: 1, designAssetsRequested: 0 });
      expect(await designAssetById(db, leftover.id)).toBeUndefined();
      expect(store.objects.has(leftover.originalKey)).toBe(false);
      // The quota was released when the purge was requested, not again now.
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    });

    it('keeps every image a document that no longer parses may name', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db, { usedBytes: 100 });
      const kept = await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(40 * DAY),
        width: 1,
        height: 1,
        sizeBytes: 100,
        orphanedAt: ago(31 * DAY),
      });
      seedAsset(store, kept, 100);
      await createDesign(db, ownerId, {
        doc: { version: 99, layers: [{ kind: 'picture', src: `asset:${kept.id.toUpperCase()}` }] },
      });
      const log = memoryLogger();
      const result = await runDesignAssetPurge(jobContext(db, store, { log }), ORPHAN_DAYS);
      expect(result).toMatchObject({ designAssetsRequested: 0, designAssetsPurged: 0 });
      expect((await designAssetById(db, kept.id))?.orphanedAt).toBeNull();
      expect(store.objects.has(kept.originalKey)).toBe(true);
      expect(log.entries.some((e) => e.level === 'error')).toBe(true);
    });

    it('runs from the jobs queue in trash.purge.daily with the files purge', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db, { usedBytes: 100 });
      const due = await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(40 * DAY),
        width: 1,
        height: 1,
        sizeBytes: 100,
        orphanedAt: ago(31 * DAY),
      });
      seedAsset(store, due, 100);
      const handler = createJobsHandler({
        ...testJobQueues(),
        db,
        store,
        faces: provider(),
        ledger: new MemoryJobRunLedger(),
        orphanScans: new S3OrphanScanStore(store),
        orphanGraceMs: HOUR,
        trashRetentionDays: 30,
        subscriptions: null,
        batchSize: 100,
        maxRuntimeMs: HOUR,
      });
      const log = memoryLogger();
      await handler(
        JSON.stringify({ type: 'trash.purge.daily', scheduledTime: '2026-11-12T18:00:00Z' }),
        { messageId: 'm', receiveCount: 1, signal: new AbortController().signal, log },
      );
      const finished = log.entries.find((e) => e.msg === 'scheduled job finished');
      expect(finished?.fields).toMatchObject({
        designAssetsRequested: 1,
        designAssetsPurged: 1,
        complete: true,
      });
      expect(finished?.fields.filesPurged).toBeTypeOf('number');
      expect(await designAssetById(db, due.id)).toBeUndefined();
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    });
  });

  describe('quota.reconcile.nightly', () => {
    it('fails expired design uploads, releasing the reservation and deleting the object', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db, { reservedBytes: 300 });
      const expired = await createDesignAsset(db, ownerId, {
        status: 'uploading',
        sizeBytes: 100,
        uploadExpiresAt: ago(HOUR),
      });
      const live = await createDesignAsset(db, ownerId, {
        status: 'uploading',
        sizeBytes: 200,
        uploadExpiresAt: new Date(Date.now() + HOUR),
      });
      store.seed(expired.originalKey, new Uint8Array(100));
      store.seed(live.originalKey, new Uint8Array(200));

      const result = await runQuotaReconcile(jobContext(db, store));
      expect(result).toMatchObject({ designUploadsExpired: 1, designUploadsSkipped: 0 });
      expect((await designAssetById(db, expired.id))?.status).toBe('failed');
      expect((await designAssetById(db, live.id))?.status).toBe('uploading');
      expect(store.objects.has(expired.originalKey)).toBe(false);
      expect(store.objects.has(live.originalKey)).toBe(true);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 200 });

      // Idempotent: nothing is released twice.
      const again = await runQuotaReconcile(jobContext(db, store));
      expect(again.designUploadsExpired).toBe(0);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 200 });
    });

    it('counts design originals in the counters and the S3 comparison (not web.webp)', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db);
      const ready = await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(DAY),
        width: 1,
        height: 1,
        sizeBytes: 400,
      });
      const processing = await createDesignAsset(db, ownerId, { sizeBytes: 50 });
      await createDesignAsset(db, ownerId, {
        status: 'failed',
        sizeBytes: 70,
      });
      await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(40 * DAY),
        width: 1,
        height: 1,
        sizeBytes: 900,
        purgeRequestedAt: ago(HOUR),
      });
      seedAsset(store, ready, 400);
      store.seed(processing.originalKey, new Uint8Array(50));
      // Wrong counters: fixed from files + design_assets.
      await db
        .update(storageUsage)
        .set({ usedBytes: 1, reservedBytes: 2 })
        .where(eq(storageUsage.photographerId, ownerId));

      const log = memoryLogger();
      const result = await runQuotaReconcile(jobContext(db, store, { log }));
      expect(result.countersFixed).toBeGreaterThanOrEqual(1);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 400, reservedBytes: 50 });
      const drift = log.entries.filter(
        (e) =>
          e.msg === 'S3 originals disagree with the files rows' &&
          e.fields.photographerId === ownerId,
      );
      expect(drift).toEqual([]);

      // An original with no row is reported; a verified asset without its object too.
      store.seed(
        designAssetKey({ photographerId: ownerId, assetId: randomUUID() }, 'original'),
        new Uint8Array(30),
      );
      store.objects.delete(ready.originalKey);
      const log2 = memoryLogger();
      await runQuotaReconcile(jobContext(db, store, { log: log2 }));
      const reported = log2.entries.find(
        (e) =>
          e.msg === 'S3 originals disagree with the files rows' &&
          e.fields.photographerId === ownerId,
      );
      expect(reported?.fields).toMatchObject({
        orphanObjects: 1,
        orphanBytes: 30,
        missingObjects: 1,
        designOriginals: 2,
      });
      // Reported only: counters and rows unchanged.
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 400, reservedBytes: 50 });
      expect(await designAssetById(db, ready.id)).toBeDefined();
    });

    it('creates the storage_usage row of a photographer who only has design images', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db);
      await db.delete(storageUsage).where(eq(storageUsage.photographerId, ownerId));
      const asset = await createDesignAsset(db, ownerId, {
        status: 'ready',
        verifiedAt: ago(DAY),
        width: 1,
        height: 1,
        sizeBytes: 123,
      });
      seedAsset(store, asset, 123);
      await runQuotaReconcile(jobContext(db, store));
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 123, reservedBytes: 0 });
      expect(
        await db.select().from(designAssets).where(eq(designAssets.id, asset.id)),
      ).toHaveLength(1);
    });
  });
});
