import { randomUUID } from 'node:crypto';
import {
  consents,
  faces,
  files,
  folders,
  shares,
  storageUsage,
  zipJobEntries,
  zipJobs,
} from '@shotx/db';
import { FakeFaceProvider, SyntheticWorld } from '@shotx/face/testing';
import { derivedKeys, expectedUsage, originalKey, QueueMessageError } from '@shotx/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db';
import { memoryLogger, silentLogger } from '../logger';
import type { MessageContext } from '../sqs/consumer';
import {
  createFileRow,
  createFolder,
  createPhotographer,
  fileById,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../testing/database';
import { testSubscriptionDeps } from '../testing/billing';
import { MemoryObjectStore } from '../testing/memory-aws';
import type { JobContext } from './context';
import { createJobsHandler } from './handler';
import { MemoryJobRunLedger } from './ledger';
import { S3OrphanScanStore } from './orphan-scans';
import { runQuotaReconcile } from './quota-reconcile';
import { runTrashPurge } from './trash-purge';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

function jobContext(
  db: Db,
  store: MemoryObjectStore,
  provider: FakeFaceProvider,
  log = silentLogger,
): JobContext {
  return {
    db,
    store,
    faces: provider,
    log,
    now: Date.now,
    batchSize: 2, // small, so batching paths run
    deadline: Date.now() + 3_600_000,
    signal: new AbortController().signal,
  };
}

function newProvider(): FakeFaceProvider {
  return new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] }));
}

let tokenSeq = 0;
async function shareFor(db: Db, ownerId: string, target: { file?: string; folder?: string }) {
  const [share] = await db
    .insert(shares)
    .values({
      ownerId,
      targetType: target.file !== undefined ? 'file' : 'folder',
      targetFileId: target.file ?? null,
      targetFolderId: target.folder ?? null,
      token: `Tok${String(++tokenSeq).padStart(19, '0')}`,
    })
    .returning({ id: shares.id });
  await db.insert(consents).values({
    shareId: share!.id,
    anonId: randomUUID(),
    purpose: 'face_search',
    policyVersion: '2026-10',
    ipHash: 'h',
  });
  return share!.id;
}

/** Puts a file's original and every derivative in the store. */
function seedObjects(
  store: MemoryObjectStore,
  ownerId: string,
  file: { id: string; s3Key: string },
  size: number,
) {
  store.seed(file.s3Key, new Uint8Array(size));
  for (const key of Object.values(derivedKeys({ photographerId: ownerId, fileId: file.id }))) {
    store.seed(key, new Uint8Array(1));
  }
}

async function countersMatchFiles(db: Db, ownerId: string) {
  const owned = await db
    .select({
      status: files.status,
      verifiedAt: files.verifiedAt,
      purgeRequestedAt: files.purgeRequestedAt,
      sizeBytes: files.sizeBytes,
    })
    .from(files)
    .where(eq(files.ownerId, ownerId));
  return expectedUsage(owned);
}

describe('scheduled jobs', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  describe('trash.purge.daily', () => {
    it('purges expired trash in FK order: faces, shares and consents, objects, files, then folders', async () => {
      const store = new MemoryObjectStore();
      const provider = newProvider();
      const ownerId = await createPhotographer(db, { usedBytes: 1100 });
      const collection = `pg-${ownerId}`;
      await provider.createCollection(collection);
      const deleteFaces = vi.spyOn(provider, 'deleteFaces');

      const verified = { status: 'ready' as const, verifiedAt: daysAgo(60) };
      // A: trashed alone 40 days ago, shared, with faces and a zip job entry.
      const a = await createFileRow(db, ownerId, {
        ...verified,
        sizeBytes: 100,
        deletedAt: daysAgo(40),
        originalName: 'a.jpg',
      });
      const shareA = await shareFor(db, ownerId, { file: a.id });
      await db.insert(faces).values({
        fileId: a.id,
        ownerId,
        rekognitionFaceId: 'face-a-1',
        bbox: { left: 0, top: 0, width: 0.1, height: 0.1 },
        confidence: 99,
      });
      const [job] = await db
        .insert(zipJobs)
        .values({
          photographerId: ownerId,
          shareId: shareA,
          anonId: randomUUID(),
          downloadSize: 'web',
          fileCount: 1,
          totalBytes: 100,
        })
        .returning({ id: zipJobs.id });
      await db.insert(zipJobEntries).values({
        jobId: job!.id,
        photographerId: ownerId,
        position: 0,
        fileId: a.id,
        name: 'a.jpg',
      });

      // F (trashed 40 days ago) > G (taken along) > B; G is shared.
      const trashedAt = daysAgo(40);
      const f = await createFolder(db, ownerId, { deletedAt: trashedAt });
      const g = await createFolder(db, ownerId, {
        parent: f,
        deletedAt: trashedAt,
        trashedViaFolderId: f.id,
      });
      const b = await createFileRow(db, ownerId, {
        ...verified,
        sizeBytes: 200,
        folderId: g.id,
        deletedAt: trashedAt,
        trashedViaFolderId: f.id,
        originalName: 'b.jpg',
      });
      await shareFor(db, ownerId, { folder: g.id });

      // C: trashed 5 days ago (kept). D: emptied from the trash by the API (quota already
      // released). E: live.
      const c = await createFileRow(db, ownerId, {
        ...verified,
        sizeBytes: 300,
        deletedAt: daysAgo(5),
        originalName: 'c.jpg',
      });
      const d = await createFileRow(db, ownerId, {
        ...verified,
        sizeBytes: 400,
        deletedAt: daysAgo(1),
        purgeRequestedAt: daysAgo(1),
        originalName: 'd.jpg',
      });
      const e = await createFileRow(db, ownerId, {
        ...verified,
        sizeBytes: 500,
        originalName: 'e.jpg',
      });
      for (const [file, size] of [
        [a, 100],
        [b, 200],
        [c, 300],
        [d, 400],
        [e, 500],
      ] as const) {
        seedObjects(store, ownerId, file, size);
      }

      const result = await runTrashPurge(jobContext(db, store, provider), 30);
      expect(result).toMatchObject({
        foldersRequested: 1,
        filesRequested: 1,
        filesPurged: 3,
        filesSkipped: 0,
        foldersPurged: 2,
        foldersBlocked: 0,
        complete: true,
      });

      expect(deleteFaces).toHaveBeenCalledWith(collection, ['face-a-1']);
      expect(await db.select().from(faces).where(eq(faces.ownerId, ownerId))).toEqual([]);
      const left = await db.select({ id: files.id }).from(files).where(eq(files.ownerId, ownerId));
      expect(left.map((r) => r.id).sort()).toEqual([c.id, e.id].sort());
      expect(
        await db
          .select()
          .from(folders)
          .where(inArray(folders.id, [f.id, g.id])),
      ).toEqual([]);
      expect(await db.select().from(shares).where(eq(shares.ownerId, ownerId))).toEqual([]);
      expect(await db.select().from(consents).where(eq(consents.shareId, shareA))).toEqual([]);
      expect(await db.select().from(zipJobs).where(eq(zipJobs.photographerId, ownerId))).toEqual(
        [],
      );

      for (const file of [a, b, d]) {
        expect(store.objects.has(file.s3Key)).toBe(false);
        for (const key of Object.values(
          derivedKeys({ photographerId: ownerId, fileId: file.id }),
        )) {
          expect(store.objects.has(key)).toBe(false);
        }
      }
      for (const file of [c, e]) expect(store.objects.has(file.s3Key)).toBe(true);

      // Quota: A and B released here, D was released by the API; C and E still count.
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 800, reservedBytes: 0 });
      expect(await countersMatchFiles(db, ownerId)).toEqual({ usedBytes: 800, reservedBytes: 0 });

      // A second run (redelivery) changes nothing.
      const again = await runTrashPurge(jobContext(db, store, provider), 30);
      expect(again).toMatchObject({ filesRequested: 0, filesPurged: 0, foldersPurged: 0 });
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 800, reservedBytes: 0 });
    });

    it('keeps files whose faces could not be deleted and purges the rest', async () => {
      const store = new MemoryObjectStore();
      const provider = newProvider();
      const ownerId = await createPhotographer(db);
      await provider.createCollection(`pg-${ownerId}`);
      provider.failNext('deleteFaces', new Error('ThrottlingException'));
      const purge = {
        status: 'ready' as const,
        verifiedAt: daysAgo(9),
        deletedAt: daysAgo(2),
        purgeRequestedAt: daysAgo(1),
      };
      const withFaces = await createFileRow(db, ownerId, { ...purge, originalName: 'x.jpg' });
      const plain = await createFileRow(db, ownerId, { ...purge, originalName: 'y.jpg' });
      await db.insert(faces).values({
        fileId: withFaces.id,
        ownerId,
        rekognitionFaceId: `face-${withFaces.id}`,
        bbox: { left: 0, top: 0, width: 0.1, height: 0.1 },
        confidence: 99,
      });
      seedObjects(store, ownerId, withFaces, 10);
      seedObjects(store, ownerId, plain, 10);

      const result = await runTrashPurge(jobContext(db, store, provider), 30);
      expect(result).toMatchObject({ filesPurged: 1, filesSkipped: 1 });
      expect(await fileById(db, withFaces.id)).toBeDefined();
      expect(store.objects.has(withFaces.s3Key)).toBe(true);
      expect(await fileById(db, plain.id)).toBeUndefined();

      // The next run succeeds.
      const next = await runTrashPurge(jobContext(db, store, provider), 30);
      expect(next).toMatchObject({ filesPurged: 1, filesSkipped: 0 });
      expect(await fileById(db, withFaces.id)).toBeUndefined();
    });

    it('purges files with faces when the collection no longer exists (nothing left to delete)', async () => {
      const store = new MemoryObjectStore();
      const provider = newProvider(); // no collection for this photographer
      const ownerId = await createPhotographer(db);
      const file = await createFileRow(db, ownerId, {
        status: 'ready',
        verifiedAt: daysAgo(9),
        deletedAt: daysAgo(2),
        purgeRequestedAt: daysAgo(1),
        originalName: 'gone.jpg',
      });
      await db.insert(faces).values({
        fileId: file.id,
        ownerId,
        rekognitionFaceId: `face-${file.id}`,
        bbox: { left: 0, top: 0, width: 0.1, height: 0.1 },
        confidence: 99,
      });
      seedObjects(store, ownerId, file, 10);
      const result = await runTrashPurge(jobContext(db, store, provider), 30);
      expect(result).toMatchObject({ filesSkipped: 0 });
      expect(await fileById(db, file.id)).toBeUndefined();
      expect(await db.select().from(faces).where(eq(faces.fileId, file.id))).toEqual([]);
    });

    it('releases reserved bytes for unverified trashed files and aborts their multipart upload', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db, { reservedBytes: 70 });
      const file = await createFileRow(db, ownerId, {
        sizeBytes: 70,
        uploadId: 'mpu-trash',
        uploadExpiresAt: daysAgo(39),
        deletedAt: daysAgo(40),
      });
      await runTrashPurge(jobContext(db, store, newProvider()), 30);
      expect(await fileById(db, file.id)).toBeUndefined();
      expect(store.calls.aborted).toEqual(['mpu-trash']);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    });

    it('leaves a purge-requested folder that still holds live content', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db, { usedBytes: 10 });
      const h = await createFolder(db, ownerId, { deletedAt: daysAgo(40) });
      const live = await createFileRow(db, ownerId, {
        status: 'ready',
        verifiedAt: daysAgo(50),
        sizeBytes: 10,
        folderId: h.id,
      });
      const result = await runTrashPurge(jobContext(db, store, newProvider()), 30);
      expect(result.foldersBlocked).toBeGreaterThanOrEqual(1);
      expect(await fileById(db, live.id)).toMatchObject({ purgeRequestedAt: null });
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 10, reservedBytes: 0 });
      // Clean up so later counts in this file aren't affected.
      await db
        .update(folders)
        .set({ purgeRequestedAt: null, deletedAt: null })
        .where(eq(folders.id, h.id));
    });

    it('stops at the deadline and leaves the rest for the next run', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db, { usedBytes: 30 });
      for (const name of ['p.jpg', 'q.jpg', 'r.jpg']) {
        await createFileRow(db, ownerId, {
          status: 'ready',
          verifiedAt: daysAgo(50),
          sizeBytes: 10,
          deletedAt: daysAgo(40),
          originalName: name,
        });
      }
      const ctx = { ...jobContext(db, store, newProvider()), deadline: Date.now() - 1 };
      const result = await runTrashPurge(ctx, 30);
      expect(result).toMatchObject({ complete: false, filesPurged: 0 });
      const next = await runTrashPurge(jobContext(db, store, newProvider()), 30);
      expect(next.filesRequested).toBe(3);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    });
  });

  describe('quota.reconcile.nightly', () => {
    it('expires abandoned uploads, fixes counters and reports S3 drift', async () => {
      const store = new MemoryObjectStore();
      const log = memoryLogger();
      const ownerId = await createPhotographer(db, { usedBytes: 999, reservedBytes: 5 });
      const ready = await createFileRow(db, ownerId, {
        status: 'ready',
        verifiedAt: daysAgo(3),
        sizeBytes: 100,
        originalName: 'ready.jpg',
      });
      store.seed(ready.s3Key, new Uint8Array(100));
      const missing = await createFileRow(db, ownerId, {
        status: 'ready',
        verifiedAt: daysAgo(3),
        sizeBytes: 60,
        originalName: 'missing.jpg',
      });
      await createFileRow(db, ownerId, {
        status: 'processing',
        sizeBytes: 50,
        originalName: 'processing.jpg',
      });
      await createFileRow(db, ownerId, {
        status: 'failed',
        sizeBytes: 30,
        originalName: 'failed.jpg',
      });
      await createFileRow(db, ownerId, {
        status: 'ready',
        verifiedAt: daysAgo(3),
        sizeBytes: 70,
        deletedAt: daysAgo(1),
        purgeRequestedAt: daysAgo(1),
        originalName: 'purging.jpg',
      });
      const abandoned = await createFileRow(db, ownerId, {
        sizeBytes: 40,
        uploadId: 'mpu-old',
        uploadExpiresAt: new Date(Date.now() - 3_600_000),
        originalName: 'abandoned.jpg',
      });
      const open = await createFileRow(db, ownerId, {
        sizeBytes: 20,
        uploadId: 'mpu-open',
        uploadExpiresAt: new Date(Date.now() + 3_600_000),
        originalName: 'open.jpg',
      });
      const orphanKey = originalKey({
        photographerId: ownerId,
        fileId: randomUUID(),
        originalName: 'orphan.jpg',
      });
      store.seed(orphanKey, new Uint8Array(10));

      const result = await runQuotaReconcile(jobContext(db, store, newProvider(), log));
      expect(result).toMatchObject({ uploadsExpired: 1, uploadsSkipped: 0, complete: true });
      expect(result.countersFixed).toBeGreaterThanOrEqual(1);
      expect(store.calls.aborted).toEqual(['mpu-old']);
      expect(await fileById(db, abandoned.id)).toBeUndefined();
      expect(await fileById(db, open.id)).toBeDefined();
      // used: ready 100 + missing 60; reserved: processing 50 + open 20.
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 160, reservedBytes: 70 });
      expect(await countersMatchFiles(db, ownerId)).toEqual({ usedBytes: 160, reservedBytes: 70 });

      const drift = log.entries.find(
        (e) =>
          e.msg === 'S3 originals disagree with the files rows' &&
          e.fields.photographerId === ownerId,
      );
      expect(drift?.fields).toMatchObject({
        orphanObjects: 1,
        orphanBytes: 10,
        missingObjects: 1,
        s3Objects: 2,
      });
      // Reported, not repaired.
      expect(store.objects.has(orphanKey)).toBe(true);
      expect(await fileById(db, missing.id)).toBeDefined();
      expect(JSON.stringify(log.entries)).not.toContain('orphan.jpg');

      // Idempotent: a second run finds nothing to fix for this photographer.
      const log2 = memoryLogger();
      await runQuotaReconcile(jobContext(db, store, newProvider(), log2));
      expect(
        log2.entries.some(
          (e) => e.msg === 'storage_usage drift corrected' && e.fields.photographerId === ownerId,
        ),
      ).toBe(false);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 160, reservedBytes: 70 });
    });

    it('creates a missing storage_usage row from the files', async () => {
      const store = new MemoryObjectStore();
      const ownerId = await createPhotographer(db);
      await db.delete(storageUsage).where(eq(storageUsage.photographerId, ownerId));
      const file = await createFileRow(db, ownerId, {
        status: 'ready',
        verifiedAt: daysAgo(1),
        sizeBytes: 42,
      });
      store.seed(file.s3Key, new Uint8Array(42));
      await runQuotaReconcile(jobContext(db, store, newProvider()));
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 42, reservedBytes: 0 });
    });
  });

  describe('jobs handler', () => {
    const context = (log = silentLogger): MessageContext => ({
      messageId: 'm',
      receiveCount: 1,
      signal: new AbortController().signal,
      log,
    });

    it('dedupes on (type, scheduledTime) and runs again for a new time', async () => {
      const store = new MemoryObjectStore();
      const ledger = new MemoryJobRunLedger();
      const handler = createJobsHandler({
        db,
        store,
        faces: newProvider(),
        ledger,
        orphanScans: new S3OrphanScanStore(store),
        orphanGraceMs: 3_600_000,
        trashRetentionDays: 30,
        subscriptions: testSubscriptionDeps(),
        batchSize: 100,
        maxRuntimeMs: 3_600_000,
      });
      const ownerId = await createPhotographer(db, { usedBytes: 0 });
      await db
        .update(storageUsage)
        .set({ usedBytes: 12345 })
        .where(eq(storageUsage.photographerId, ownerId));
      const body = JSON.stringify({
        type: 'quota.reconcile.nightly',
        scheduledTime: '2026-10-25T20:30:00Z',
      });

      await handler(body, context());
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });

      // Same run again (same instant written differently): skipped.
      await db
        .update(storageUsage)
        .set({ usedBytes: 12345 })
        .where(eq(storageUsage.photographerId, ownerId));
      const log = memoryLogger();
      await handler(
        JSON.stringify({
          type: 'quota.reconcile.nightly',
          scheduledTime: '2026-10-26T03:30:00+07:00',
        }),
        context(log),
      );
      expect(log.entries.map((e) => e.msg)).toContain(
        'scheduled run already done; skipping duplicate delivery',
      );
      expect((await usageOf(db, ownerId))?.usedBytes).toBe(12345);

      // The next night's run happens.
      await handler(
        JSON.stringify({ type: 'quota.reconcile.nightly', scheduledTime: '2026-10-26T20:30:00Z' }),
        context(),
      );
      expect((await usageOf(db, ownerId))?.usedBytes).toBe(0);
    });

    it('runs anyway when the ledger is unavailable, and does not record failed runs', async () => {
      const failing = {
        isDone: () => Promise.reject(new Error('redis down')),
        markDone: vi.fn(() => Promise.resolve()),
      };
      const handler = createJobsHandler({
        db,
        store: new MemoryObjectStore(),
        faces: newProvider(),
        ledger: failing,
        orphanScans: new S3OrphanScanStore(new MemoryObjectStore()),
        orphanGraceMs: 3_600_000,
        trashRetentionDays: 30,
        subscriptions: testSubscriptionDeps(),
        batchSize: 100,
        maxRuntimeMs: 3_600_000,
      });
      await handler(
        JSON.stringify({ type: 'trash.purge.daily', scheduledTime: '2026-10-25T18:30:00Z' }),
        context(),
      );
      expect(failing.markDone).toHaveBeenCalledTimes(1);

      const aborted = new AbortController();
      aborted.abort();
      await expect(
        handler(
          JSON.stringify({ type: 'trash.purge.daily', scheduledTime: '2026-10-26T18:30:00Z' }),
          {
            ...context(),
            signal: aborted.signal,
          },
        ),
      ).rejects.toThrow();
      expect(failing.markDone).toHaveBeenCalledTimes(1);
    });

    it('runs subscriptions.transition.daily (Phase 4) and rejects invalid messages', async () => {
      const handler = createJobsHandler({
        db,
        store: new MemoryObjectStore(),
        faces: newProvider(),
        ledger: new MemoryJobRunLedger(),
        orphanScans: new S3OrphanScanStore(new MemoryObjectStore()),
        orphanGraceMs: 3_600_000,
        trashRetentionDays: 30,
        subscriptions: testSubscriptionDeps(),
        batchSize: 100,
        maxRuntimeMs: 3_600_000,
      });
      const log = memoryLogger();
      await handler(
        JSON.stringify({
          type: 'subscriptions.transition.daily',
          scheduledTime: '2026-10-25T18:30:00Z',
        }),
        context(log),
      );
      expect(log.entries).toContainEqual(
        expect.objectContaining({ level: 'info', msg: 'scheduled job finished' }),
      );
      expect(log.entries.some((e) => /not implemented/.test(e.msg))).toBe(false);
      await expect(handler('{"type":"nope"}', context())).rejects.toBeInstanceOf(QueueMessageError);
    });
  });
});
