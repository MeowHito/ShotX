import { createHash, randomUUID } from 'node:crypto';
import { authSessions, faceDeletions, faces, files, folders } from '@shotx/db';
import { FakeFaceProvider, SyntheticWorld } from '@shotx/face/testing';
import {
  FACE_DELETION_ALERT_EVENT,
  loadWorkerSettings,
  parseQueueMessage,
  type WorkerSweepSettings,
} from '@shotx/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { memoryLogger, silentLogger, type Logger } from '../logger';
import type { MessageContext } from '../queue/handler';
import { testSubscriptionDeps } from '../testing/billing';
import {
  createFileRow,
  createFolder,
  createPhotographer,
  fileById,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../testing/database';
import { TEST_DESTINATIONS, testJobQueues } from '../testing/jobs';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import { runAuthSessionsPurge } from './auth-sessions-purge';
import type { JobContext } from './context';
import { runFacesSweep } from './faces-sweep';
import { createJobsHandler } from './handler';
import { MemoryJobRunLedger } from './ledger';
import { runMediaSweep } from './media-sweep';
import { S3OrphanScanStore } from './orphan-scans';
import { runQuotaReconcile } from './quota-reconcile';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);
const SWEEPS: WorkerSweepSettings = loadWorkerSettings({}).sweeps;
const ON = { faceSearch: true };

function provider(): FakeFaceProvider {
  return new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] }));
}

function jobContext(
  db: Db,
  store: MemoryObjectStore,
  queues: MemoryQueueClient,
  log: Logger = silentLogger,
): JobContext {
  return {
    db,
    store,
    faces: provider(),
    queues,
    destinations: { ...TEST_DESTINATIONS },
    log,
    now: Date.now,
    batchSize: 2,
    deadline: Date.now() + HOUR,
    signal: new AbortController().signal,
  };
}

/** The messages sent to one destination, parsed. */
function sentTo<Q extends 'media' | 'faces'>(queues: MemoryQueueClient, queue: Q) {
  return queues.sent
    .filter((m) => m.queueUrl === TEST_DESTINATIONS[queue])
    .map((m) => parseQueueMessage(queue, m.body));
}

describe('sweeps (ADR 0008 lost jobs)', () => {
  let database: TestDatabase;
  let db: Db;

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });

  describe('media.sweep: stale processing files', () => {
    it('re-sends original.completed once per age window, up to the cap, then reports', async () => {
      const store = new MemoryObjectStore();
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db, { reservedBytes: 400 });
      const stale = await createFileRow(db, ownerId, {
        originalName: 'stale.jpg',
        status: 'processing',
        mediaQueuedAt: ago(7 * HOUR),
        sizeBytes: 100,
      });
      // No media_queued_at (a row from before 0006): created_at decides.
      const legacy = await createFileRow(db, ownerId, {
        originalName: 'legacy.jpg',
        status: 'processing',
        createdAt: ago(8 * HOUR),
        sizeBytes: 100,
      });
      const fresh = await createFileRow(db, ownerId, {
        originalName: 'fresh.jpg',
        status: 'processing',
        mediaQueuedAt: ago(HOUR),
        sizeBytes: 100,
      });
      const capped = await createFileRow(db, ownerId, {
        originalName: 'capped.jpg',
        status: 'processing',
        mediaQueuedAt: ago(9 * HOUR),
        mediaRequeues: SWEEPS.media.maxRequeues,
        sizeBytes: 100,
      });
      const purging = await createFileRow(db, ownerId, {
        originalName: 'purging.jpg',
        status: 'processing',
        mediaQueuedAt: ago(9 * HOUR),
        deletedAt: ago(HOUR),
        purgeRequestedAt: ago(HOUR),
      });
      const log = memoryLogger();

      const result = await runMediaSweep(jobContext(db, store, queues, log), SWEEPS.media);
      expect(result).toMatchObject({ requeued: 2, overCap: 1, errors: 0, complete: true });
      const sent = sentTo(queues, 'media');
      expect(sent.map((m) => ('fileId' in m ? m.fileId : null)).sort()).toEqual(
        [stale.id, legacy.id].sort(),
      );
      expect(sent[0]).toMatchObject({ kind: 'original.completed', photographerId: ownerId });
      for (const id of [stale.id, legacy.id]) {
        const row = await fileById(db, id);
        expect(row?.mediaRequeues).toBe(1);
        expect(row!.mediaQueuedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      }
      expect((await fileById(db, fresh.id))?.mediaRequeues).toBe(0);
      expect((await fileById(db, purging.id))?.mediaRequeues).toBe(0);
      const report = log.entries.find((e) => e.level === 'error');
      expect(report?.fields).toMatchObject({ count: 1, fileIds: capped.id });

      // Idempotent within the window: nothing is sent twice.
      await runMediaSweep(jobContext(db, store, queues), SWEEPS.media);
      expect(sentTo(queues, 'media')).toHaveLength(2);
    });
  });

  describe('media.sweep: stale copies', () => {
    it('re-sends file.copy, not original.completed, for processing copies', async () => {
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db, { reservedBytes: 100 });
      const sourceId = randomUUID();
      const copy = await createFileRow(db, ownerId, {
        originalName: 'copy-of-stale.jpg',
        status: 'processing',
        sizeBytes: 100,
        copiedFromFileId: sourceId,
        mediaQueuedAt: ago(7 * HOUR),
      });
      await runMediaSweep(jobContext(db, new MemoryObjectStore(), queues), SWEEPS.media);
      expect(sentTo(queues, 'media')).toContainEqual({
        kind: 'file.copy',
        fileId: copy.id,
        sourceFileId: sourceId,
        photographerId: ownerId,
      });
      expect((await fileById(db, copy.id))?.mediaRequeues).toBe(1);
    });
  });

  describe('media.sweep: uploads whose markCompleted was lost', () => {
    it('completes them from the object; leaves live, missing, wrong-size and young ones', async () => {
      const store = new MemoryObjectStore();
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db, { reservedBytes: 500 });
      const open = (name: string, overrides: Parameters<typeof createFileRow>[2] = {}) =>
        createFileRow(db, ownerId, {
          originalName: name,
          sizeBytes: 100,
          uploadId: `mpu-${name}`,
          uploadExpiresAt: new Date(Date.now() + DAY),
          createdAt: ago(2 * HOUR),
          ...overrides,
        });
      const lost = await open('lost.jpg');
      store.seed(lost.s3Key, new Uint8Array(100));
      const live = await open('live.jpg');
      store.openUpload(live.s3Key, 'mpu-live.jpg');
      const missing = await open('missing.jpg');
      const wrongSize = await open('wrong.jpg');
      store.seed(wrongSize.s3Key, new Uint8Array(99));
      const young = await open('young.jpg', { createdAt: ago(60_000) });
      store.seed(young.s3Key, new Uint8Array(100));

      const result = await runMediaSweep(jobContext(db, store, queues), SWEEPS.media);
      expect(result).toMatchObject({ uploadsRecovered: 1, uploadsLeft: 3, errors: 0 });
      expect(await fileById(db, lost.id)).toMatchObject({
        status: 'processing',
        uploadId: null,
        uploadPartBytes: null,
      });
      expect((await fileById(db, lost.id))?.mediaQueuedAt).toBeInstanceOf(Date);
      expect(sentTo(queues, 'media')).toEqual([
        { kind: 'original.completed', fileId: lost.id, photographerId: ownerId, key: lost.s3Key },
      ]);
      // Reserved until the pipeline verifies the bytes; nothing deleted or aborted.
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 500 });
      expect(store.calls.deleted).toEqual([]);
      expect(store.calls.aborted).toEqual([]);
      for (const file of [live, missing, wrongSize, young]) {
        expect((await fileById(db, file.id))?.status).toBe('uploading');
      }
      expect(store.calls.listedParts).not.toContain('mpu-young.jpg');

      // A second run doesn't touch the recovered row again.
      await runMediaSweep(jobContext(db, store, queues), SWEEPS.media);
      expect(sentTo(queues, 'media')).toHaveLength(1);
    });
  });

  describe('quota.reconcile.nightly recovers before it expires', () => {
    it('completes an expired upload whose object has the declared size instead of deleting it', async () => {
      const store = new MemoryObjectStore();
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db, { reservedBytes: 300 });
      const expired = { uploadExpiresAt: ago(HOUR), sizeBytes: 100 };
      const finished = await createFileRow(db, ownerId, {
        ...expired,
        uploadId: 'mpu-finished',
        originalName: 'finished.jpg',
      });
      store.seed(finished.s3Key, new Uint8Array(100));
      const partial = await createFileRow(db, ownerId, {
        ...expired,
        uploadId: 'mpu-partial',
        originalName: 'partial.jpg',
      });
      store.seed(partial.s3Key, new Uint8Array(40));
      const nothing = await createFileRow(db, ownerId, {
        ...expired,
        uploadId: 'mpu-nothing',
        originalName: 'nothing.jpg',
      });

      const result = await runQuotaReconcile(jobContext(db, store, queues));
      expect(result).toMatchObject({ uploadsExpired: 2, uploadsRecovered: 1, uploadsSkipped: 0 });
      expect(store.calls.aborted.sort()).toEqual(['mpu-finished', 'mpu-nothing', 'mpu-partial']);
      // The finished upload is kept, completed and sent to the pipeline; its bytes stay reserved.
      expect(await fileById(db, finished.id)).toMatchObject({
        status: 'processing',
        uploadId: null,
      });
      expect(store.objects.has(finished.s3Key)).toBe(true);
      expect(sentTo(queues, 'media')).toEqual([
        {
          kind: 'original.completed',
          fileId: finished.id,
          photographerId: ownerId,
          key: finished.s3Key,
        },
      ]);
      // The others expire as before.
      expect(await fileById(db, partial.id)).toBeUndefined();
      expect(await fileById(db, nothing.id)).toBeUndefined();
      expect(store.objects.has(partial.s3Key)).toBe(false);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 100 });
    });
  });

  describe('faces.sweep', () => {
    async function deletion(ownerId: string, createdAt: Date, completed = false) {
      const [row] = await db
        .insert(faceDeletions)
        .values({
          photographerId: ownerId,
          shareId: randomUUID(),
          facesMatched: 2,
          createdAt,
          ...(completed ? { completedAt: new Date(), facesDeleted: 2 } : {}),
        })
        .returning({ id: faceDeletions.id });
      return row!.id;
    }

    it('re-sends open deletions with no cap and alerts on overdue ones', async () => {
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db);
      const overdue = await deletion(ownerId, ago(2 * DAY));
      const stale = await deletion(ownerId, ago(2 * HOUR));
      await deletion(ownerId, ago(60_000)); // too young
      await deletion(ownerId, ago(3 * DAY), true); // done
      const log = memoryLogger();

      const result = await runFacesSweep(
        jobContext(db, new MemoryObjectStore(), queues, log),
        SWEEPS.faces,
        ON,
      );
      expect(result).toMatchObject({ deletionsResent: 2, deletionsOverdue: 1 });
      expect(sentTo(queues, 'faces')).toEqual([
        { type: 'delete.faces', deletionId: overdue },
        { type: 'delete.faces', deletionId: stale },
      ]);
      const alert = log.entries.find((e) => e.msg === FACE_DELETION_ALERT_EVENT);
      expect(alert?.fields).toMatchObject({
        event: FACE_DELETION_ALERT_EVENT,
        count: 1,
        deletionIds: overdue,
      });
      // No cap and no mark: every run re-sends until the faces consumer completes the deletion.
      await runFacesSweep(jobContext(db, new MemoryObjectStore(), queues), SWEEPS.faces, ON);
      expect(sentTo(queues, 'faces')).toHaveLength(4);
      await db.delete(faceDeletions).where(eq(faceDeletions.photographerId, ownerId));
    });

    it('re-sends stale index.file and index.folder marks, bumping them, up to the cap', async () => {
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db);
      const folder = await createFolder(db, ownerId, {
        faceIndexEnabled: true,
        faceIndexQueuedAt: ago(7 * HOUR),
      });
      const freshFolder = await createFolder(db, ownerId, {
        faceIndexEnabled: true,
        faceIndexQueuedAt: ago(HOUR),
      });
      // The API turned indexing off while a sweep raced it: never sent, the mark is dropped.
      const turnedOff = await createFolder(db, ownerId, { faceIndexQueuedAt: ago(7 * HOUR) });
      const ready = { status: 'ready' as const, verifiedAt: ago(DAY), folderId: folder.id };
      const stale = await createFileRow(db, ownerId, {
        ...ready,
        originalName: 'stale.jpg',
        facesQueuedAt: ago(7 * HOUR),
      });
      const fresh = await createFileRow(db, ownerId, {
        ...ready,
        originalName: 'fresh.jpg',
        facesQueuedAt: ago(HOUR),
      });
      // Withheld (migration 0009): its stale mark is cleared, never re-sent.
      const withheld = await createFileRow(db, ownerId, {
        ...ready,
        originalName: 'withheld.jpg',
        facesQueuedAt: ago(7 * HOUR),
        facesRequeues: 1,
        facesWithheldAt: ago(DAY),
      });
      const capped = await createFileRow(db, ownerId, {
        ...ready,
        originalName: 'capped.jpg',
        facesQueuedAt: ago(7 * HOUR),
        facesRequeues: SWEEPS.faces.maxRequeues,
      });
      const log = memoryLogger();

      const result = await runFacesSweep(
        jobContext(db, new MemoryObjectStore(), queues, log),
        SWEEPS.faces,
        ON,
      );
      expect(result).toMatchObject({
        filesRequeued: 1,
        filesOverCap: 1,
        foldersRequeued: 1,
        foldersCleared: 1,
        filesWithheldCleared: 1,
      });
      expect(await fileById(db, withheld.id)).toMatchObject({
        facesQueuedAt: null,
        facesRequeues: 0,
      });
      const [off] = await db
        .select({ queuedAt: folders.faceIndexQueuedAt })
        .from(folders)
        .where(eq(folders.id, turnedOff.id));
      expect(off?.queuedAt).toBeNull();
      expect(sentTo(queues, 'faces')).toEqual([
        { type: 'index.file', fileId: stale.id },
        { type: 'index.folder', folderId: folder.id },
      ]);
      const bumped = await fileById(db, stale.id);
      expect(bumped?.facesRequeues).toBe(1);
      expect(bumped!.facesQueuedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect((await fileById(db, fresh.id))?.facesRequeues).toBe(0);
      expect(log.entries.find((e) => e.level === 'error')?.fields).toMatchObject({
        count: 1,
        fileIds: capped.id,
      });
      const [folderRow] = await db
        .select({ queuedAt: folders.faceIndexQueuedAt })
        .from(folders)
        .where(eq(folders.id, folder.id));
      expect(folderRow!.queuedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
      expect(freshFolder.id).not.toBe(folder.id);

      // Within the window nothing is re-sent.
      await runFacesSweep(jobContext(db, new MemoryObjectStore(), queues), SWEEPS.faces, ON);
      expect(sentTo(queues, 'faces')).toHaveLength(2);
      await db.update(files).set({ facesQueuedAt: null }).where(eq(files.ownerId, ownerId));
      await db
        .update(folders)
        .set({ faceIndexQueuedAt: null })
        .where(inArray(folders.id, [folder.id, freshFolder.id]));
    });
  });

  describe('faces.sweep coverage scan', () => {
    it('marks and sends covered, never-indexed photos without a mark, bounded per run', async () => {
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db);
      const indexed = await createFolder(db, ownerId, { faceIndexEnabled: true });
      const child = await createFolder(db, ownerId, { parent: indexed });
      const expired = await createFolder(db, ownerId, {
        faceIndexEnabled: true,
        faceIndexExpiresAt: ago(HOUR),
      });
      const plain = await createFolder(db, ownerId);
      let n = 0;
      const photo = (overrides: Parameters<typeof createFileRow>[2]) =>
        createFileRow(db, ownerId, {
          originalName: `cover-${++n}.jpg`,
          status: 'ready',
          verifiedAt: ago(DAY),
          createdAt: ago(7 * HOUR),
          ...overrides,
        });
      const a = await photo({ folderId: indexed.id });
      const b = await photo({ folderId: child.id }); // covered by the parent's index
      const c = await photo({ folderId: child.id });
      // Not candidates:
      await photo({ folderId: indexed.id, faceCount: 0 }); // indexed
      await photo({ folderId: indexed.id, facesQueuedAt: ago(HOUR) }); // outstanding job
      await photo({ folderId: indexed.id, createdAt: ago(HOUR) }); // too young
      await photo({ folderId: indexed.id, mime: 'video/mp4', originalName: 'clip.mp4' });
      await photo({ folderId: indexed.id, deletedAt: ago(HOUR) });
      await photo({ folderId: indexed.id, status: 'processing' });
      await photo({ folderId: expired.id });
      await photo({ folderId: plain.id });
      await photo({ folderId: null });
      await photo({ folderId: indexed.id, facesWithheldAt: ago(DAY) }); // PDPA: never indexed
      // A face deletion is open for it: index.file would end as deletion-pending every run.
      const pending = await photo({ folderId: indexed.id });
      const [open] = await db
        .insert(faceDeletions)
        .values({ photographerId: ownerId, shareId: randomUUID(), facesMatched: 1 })
        .returning({ id: faceDeletions.id });
      await db.insert(faces).values({
        fileId: pending.id,
        ownerId,
        rekognitionFaceId: randomUUID(),
        bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
        confidence: 99,
        deletionId: open!.id,
      });

      const settings = { ...SWEEPS.faces, batchSize: 2 };
      const first = await runFacesSweep(
        jobContext(db, new MemoryObjectStore(), queues),
        settings,
        ON,
      );
      expect(first.filesCovered).toBe(2);
      await runFacesSweep(jobContext(db, new MemoryObjectStore(), queues), settings, ON);
      const sent = sentTo(queues, 'faces').map((m) => ('fileId' in m ? m.fileId : null));
      expect(sent.sort()).toEqual([a.id, b.id, c.id].sort());
      for (const file of [a, b, c]) {
        // Marked (so it leaves the scan), first send: no requeue counted.
        const row = await fileById(db, file.id);
        expect(row?.facesQueuedAt).toBeInstanceOf(Date);
        expect(row?.facesRequeues).toBe(0);
      }
      // Everything is marked now: a third run sends nothing.
      await runFacesSweep(jobContext(db, new MemoryObjectStore(), queues), settings, ON);
      expect(sentTo(queues, 'faces')).toHaveLength(3);
      await db.update(files).set({ facesQueuedAt: null }).where(eq(files.ownerId, ownerId));
      await db.update(files).set({ faceCount: 0 }).where(eq(files.ownerId, ownerId));
    });

    it('with face search off re-sends only deletions and keeps every mark', async () => {
      const queues = new MemoryQueueClient();
      const ownerId = await createPhotographer(db);
      const folder = await createFolder(db, ownerId, {
        faceIndexEnabled: true,
        faceIndexQueuedAt: ago(7 * HOUR),
      });
      const marked = await createFileRow(db, ownerId, {
        originalName: 'off-marked.jpg',
        status: 'ready',
        verifiedAt: ago(DAY),
        folderId: folder.id,
        facesQueuedAt: ago(7 * HOUR),
      });
      await createFileRow(db, ownerId, {
        originalName: 'off-unmarked.jpg',
        status: 'ready',
        verifiedAt: ago(DAY),
        folderId: folder.id,
        createdAt: ago(7 * HOUR),
      });
      const [deletion] = await db
        .insert(faceDeletions)
        .values({
          photographerId: ownerId,
          shareId: randomUUID(),
          facesMatched: 1,
          createdAt: ago(2 * HOUR),
        })
        .returning({ id: faceDeletions.id });

      const result = await runFacesSweep(
        jobContext(db, new MemoryObjectStore(), queues),
        SWEEPS.faces,
        { faceSearch: false },
      );
      expect(result).toMatchObject({
        indexing: false,
        deletionsResent: 1,
        filesRequeued: 0,
        foldersRequeued: 0,
        filesCovered: 0,
      });
      expect(sentTo(queues, 'faces')).toEqual([{ type: 'delete.faces', deletionId: deletion!.id }]);
      expect(await fileById(db, marked.id)).toMatchObject({ facesRequeues: 0 });
      expect((await fileById(db, marked.id))!.facesQueuedAt!.getTime()).toBeLessThan(
        Date.now() - 6 * HOUR,
      );

      // Back on: the kept marks are re-sent and the scan runs.
      const on = await runFacesSweep(
        jobContext(db, new MemoryObjectStore(), queues),
        SWEEPS.faces,
        ON,
      );
      expect(on).toMatchObject({ filesRequeued: 1, foldersRequeued: 1, filesCovered: 1 });
      await db.delete(faceDeletions).where(eq(faceDeletions.photographerId, ownerId));
      await db
        .update(files)
        .set({ facesQueuedAt: null, faceCount: 0 })
        .where(eq(files.ownerId, ownerId));
      await db.update(folders).set({ faceIndexQueuedAt: null }).where(eq(folders.id, folder.id));
    });
  });

  describe('auth.sessions.purge.daily', () => {
    const hash = () => createHash('sha256').update(randomUUID()).digest('hex');

    it('deletes sessions past the retention after expiry, in batches, whole families', async () => {
      const userId = await createPhotographer(db);
      const insert = async (
        expiresAt: Date,
        extra: Partial<typeof authSessions.$inferInsert> = {},
      ) => {
        const [row] = await db
          .insert(authSessions)
          .values({
            userId,
            pool: 'users',
            refreshTokenHash: hash(),
            familyId: randomUUID(),
            createdAt: new Date(expiresAt.getTime() - 30 * DAY),
            expiresAt,
            ...extra,
          })
          .returning({ id: authSessions.id });
        return row!.id;
      };
      // An old family: a rotated (revoked) row and its successor, both long expired.
      const family = randomUUID();
      const successor = await insert(ago(10 * DAY), { familyId: family });
      await insert(ago(10 * DAY), {
        familyId: family,
        revokedAt: ago(40 * DAY),
        replacedById: successor,
      });
      await insert(ago(9 * DAY));
      // Expired within the retention (7 days): kept, also when revoked.
      const recent = await insert(ago(2 * DAY), { revokedAt: ago(3 * DAY) });
      const live = await insert(new Date(Date.now() + 20 * DAY));

      const result = await runAuthSessionsPurge(
        jobContext(db, new MemoryObjectStore(), new MemoryQueueClient()),
        {
          retentionDays: 7,
          batchSize: 1, // one row per DELETE: the successor may go before the row pointing at it
        },
      );
      expect(result).toEqual({ deleted: 3, complete: true });
      const left = await db
        .select({ id: authSessions.id })
        .from(authSessions)
        .where(eq(authSessions.userId, userId));
      expect(left.map((r) => r.id).sort()).toEqual([recent, live].sort());
    });
  });

  describe('jobs handler', () => {
    it('runs the three new scheduled job types (no "not implemented" warning)', async () => {
      const store = new MemoryObjectStore();
      const handler = createJobsHandler({
        ...testJobQueues(),
        db,
        store,
        faces: provider(),
        ledger: new MemoryJobRunLedger(),
        orphanScans: new S3OrphanScanStore(store),
        orphanGraceMs: HOUR,
        trashRetentionDays: 30,
        subscriptions: testSubscriptionDeps(),
        batchSize: 100,
        maxRuntimeMs: HOUR,
      });
      for (const type of ['media.sweep', 'faces.sweep', 'auth.sessions.purge.daily']) {
        const log = memoryLogger();
        const context: MessageContext = {
          messageId: 'm',
          receiveCount: 1,
          signal: new AbortController().signal,
          log,
        };
        await handler(JSON.stringify({ type, scheduledTime: '2026-10-27T03:07:00Z' }), context);
        expect(log.entries.some((e) => /not implemented/.test(e.msg))).toBe(false);
        expect(log.entries).toContainEqual(
          expect.objectContaining({ level: 'info', msg: 'scheduled job finished' }),
        );
      }
    });
  });
});
