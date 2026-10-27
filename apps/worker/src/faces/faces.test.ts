import { testJobQueues } from '../testing/jobs';
import { randomUUID } from 'node:crypto';
import { faceDeletions, faces, files, folders, users } from '@shotx/db';
import { faceCollectionId, IndexPhotoError } from '@shotx/face';
import { FakeFaceProvider, renderScene, type Scene, SyntheticWorld } from '@shotx/face/testing';
import { type Env, loadFaceConfig, serializeQueueMessage } from '@shotx/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { runFacesExpire } from '../jobs/faces-expire';
import { runFacesReconcile } from '../jobs/faces-reconcile';
import type { JobContext } from '../jobs/context';
import { RECONCILE_SCAN_PREFIX, S3OrphanScanStore } from '../jobs/orphan-scans';
import { memoryLogger, silentLogger } from '../logger';
import type { MessageContext } from '../sqs/consumer';
import {
  createFileRow,
  createFolder,
  createPhotographer,
  fileById,
  openTestDatabase,
  type TestDatabase,
} from '../testing/database';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import { CollectionRegistry, type FacesDeps } from './deps';
import { createFacesHandler } from './handler';
import { RecordFacesDeadlineError } from './index-file';

const FACES_URL = 'http://sqs.local/queue/faces';
const DAY = 86_400_000;
const GRACE = 3 * 3_600_000; // FACE_ORPHAN_GRACE_MS default

const world = SyntheticWorld.create({ volunteers: 3, bystanders: 1, seed: 7 });
const [p1, p2, p3] = world.persons.map((p) => p.id) as [string, string, string];
const scene: Scene = {
  width: 1600,
  height: 1000,
  faces: [
    { personId: p1, pose: 'front', left: 100, top: 100, size: 300 },
    { personId: p2, pose: 'front', left: 700, top: 200, size: 260 },
    { personId: p3, pose: 'left', left: 1200, top: 500, size: 220 },
  ],
};

function context(log = silentLogger, receiveCount = 1): MessageContext {
  return { messageId: 'm', receiveCount, signal: new AbortController().signal, log };
}

describe('faces consumer', () => {
  let database: TestDatabase;
  let db: Db;
  let photo: Buffer;
  let store: MemoryObjectStore;
  let queues: MemoryQueueClient;
  let provider: FakeFaceProvider;
  let clock: { t: number };

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
    photo = await renderScene(world, scene, 1);
  });
  afterAll(async () => {
    await database.close();
  });
  beforeEach(() => {
    store = new MemoryObjectStore();
    queues = new MemoryQueueClient();
    provider = new FakeFaceProvider(world);
    clock = { t: Date.now() };
  });

  function deps(env: Env = {}, overrides: Partial<FacesDeps> = {}): FacesDeps {
    return {
      db,
      store,
      queues,
      facesQueueUrl: FACES_URL,
      provider,
      collections: new CollectionRegistry(provider),
      face: loadFaceConfig({ FACE_INDEX_TILING: 'never', ...env }),
      features: { faceSearch: true },
      retention: { faceIndexExpiryDays: 90 },
      batchSize: 2,
      maxProcessingMs: 3_600_000,
      now: () => clock.t,
      ...overrides,
    };
  }

  const indexJob = (fileId: string) =>
    serializeQueueMessage('faces', { type: 'index.file', fileId });

  /** A photographer with a face-indexed folder (expiring in `expiresInMs`) holding one photo. */
  async function indexedFolderWithPhoto(expiresInMs = DAY) {
    const ownerId = await createPhotographer(db);
    const folder = await createFolder(db, ownerId, {
      faceIndexEnabled: true,
      faceIndexExpiresAt: new Date(Date.now() + expiresInMs),
    });
    const file = await readyPhoto(ownerId, folder.id);
    return { ownerId, folder, file };
  }

  async function readyPhoto(ownerId: string, folderId: string | null, mime = 'image/jpeg') {
    const file = await createFileRow(db, ownerId, {
      originalName: mime === 'video/mp4' ? `v-${randomUUID()}.mp4` : `p-${randomUUID()}.jpg`,
      mime,
      sizeBytes: photo.length,
      status: 'ready',
      verifiedAt: new Date(),
      folderId,
    });
    store.seed(file.s3Key, photo, mime);
    return file;
  }

  async function faceRows(fileId: string) {
    return db.select().from(faces).where(eq(faces.fileId, fileId));
  }

  describe('index.file', () => {
    it('acknowledges without indexing while FACE_SEARCH_ENABLED is false', async () => {
      const { file } = await indexedFolderWithPhoto();
      const log = memoryLogger();
      await createFacesHandler(deps({}, { features: { faceSearch: false } }))(
        indexJob(file.id),
        context(log),
      );
      expect(provider.calls.indexFaces).toBe(0);
      expect(provider.calls.createCollection).toBe(0);
      expect((await fileById(db, file.id))?.faceCount).toBeNull();
      expect(log.entries.some((e) => /disabled/.test(e.msg))).toBe(true);
    });

    it('indexes into the owner collection, records faces and extends the covering folders', async () => {
      const { ownerId, folder, file } = await indexedFolderWithPhoto();
      const child = await createFolder(db, ownerId, { parent: folder });
      const nested = await readyPhoto(ownerId, child.id);
      await createFacesHandler(deps())(indexJob(nested.id), context());

      const rows = await faceRows(nested.id);
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.ownerId === ownerId && r.deletionId === null)).toBe(true);
      const stored = provider.storedFaces(faceCollectionId(ownerId));
      expect(new Set(stored.map((f) => f.faceId))).toEqual(
        new Set(rows.map((r) => r.rekognitionFaceId)),
      );
      expect(stored.every((f) => f.externalImageId === nested.id)).toBe(true);
      expect((await fileById(db, nested.id))?.faceCount).toBe(3);
      // Images went to Rekognition as bytes (ADR 0008 section 5): nothing written to tmp/.
      expect([...store.objects.keys()].some((k) => k.startsWith('tmp/'))).toBe(false);
      // The covering folder's expiry moved to upload + 90 days (it was 1 day out).
      const [row] = await db.select().from(folders).where(eq(folders.id, folder.id));
      const created = (await fileById(db, nested.id))!.createdAt.getTime();
      expect(row!.faceIndexExpiresAt!.getTime()).toBe(created + 90 * DAY);
      // The other photo is untouched.
      expect((await fileById(db, file.id))?.faceCount).toBeNull();
    });

    it('skips duplicate deliveries once indexed, and uncovered, trashed and video files', async () => {
      const { ownerId, folder, file } = await indexedFolderWithPhoto();
      const handler = createFacesHandler(deps());
      await handler(indexJob(file.id), context());
      const calls = provider.calls.indexFaces;
      const log = memoryLogger();
      await handler(indexJob(file.id), context(log));
      expect(provider.calls.indexFaces).toBe(calls);
      expect(log.entries.at(-1)).toMatchObject({ fields: { outcome: 'already-indexed' } });
      expect(await faceRows(file.id)).toHaveLength(3);

      const plain = await createFolder(db, ownerId);
      const uncovered = await readyPhoto(ownerId, plain.id);
      const atRoot = await readyPhoto(ownerId, null);
      const trashed = await readyPhoto(ownerId, plain.id);
      await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, trashed.id));
      const video = await readyPhoto(ownerId, folder.id, 'video/mp4');
      for (const [id, outcome] of [
        [uncovered.id, 'not-covered'],
        [atRoot.id, 'not-covered'],
        [trashed.id, 'not-indexable'],
        [video.id, 'not-indexable'],
        [randomUUID(), 'missing'],
      ] as const) {
        const entries = memoryLogger();
        await handler(indexJob(id), context(entries));
        expect(entries.entries.at(-1)).toMatchObject({ fields: { outcome } });
      }
      expect(provider.calls.indexFaces).toBe(calls);
    });

    it('re-indexes a file whose rows have no face_count: previous faces are replaced', async () => {
      const { ownerId, file } = await indexedFolderWithPhoto();
      const handler = createFacesHandler(deps());
      await handler(indexJob(file.id), context());
      const before = (await faceRows(file.id)).map((r) => r.rekognitionFaceId);
      await db.update(files).set({ faceCount: null }).where(eq(files.id, file.id));

      await handler(indexJob(file.id), context());
      const after = (await faceRows(file.id)).map((r) => r.rekognitionFaceId);
      expect(after).toHaveLength(3);
      expect(after.some((id) => before.includes(id))).toBe(false);
      const stored = provider.storedFaces(faceCollectionId(ownerId)).map((f) => f.faceId);
      expect(new Set(stored)).toEqual(new Set(after)); // the old faces are gone
      expect((await fileById(db, file.id))?.faceCount).toBe(3);
    });

    it('does not re-index a file with faces waiting for a face deletion', async () => {
      const { ownerId, file } = await indexedFolderWithPhoto();
      const handler = createFacesHandler(deps());
      await handler(indexJob(file.id), context());
      const [deletion] = await db
        .insert(faceDeletions)
        .values({ photographerId: ownerId, shareId: randomUUID(), facesMatched: 1 })
        .returning();
      const [row] = await faceRows(file.id);
      await db.update(faces).set({ deletionId: deletion!.id }).where(eq(faces.id, row!.id));
      await db.update(files).set({ faceCount: null }).where(eq(files.id, file.id));
      const log = memoryLogger();
      await handler(indexJob(file.id), context(log));
      expect(log.entries.at(-1)).toMatchObject({ fields: { outcome: 'deletion-pending' } });
    });

    it('retries DeleteFaces for orphans after a failed attempt and never records them', async () => {
      const { ownerId, file } = await indexedFolderWithPhoto();
      // Tiles: the full image is indexed, the first tile fails, the rollback DeleteFaces fails.
      provider.failNext('indexFaces', new Error('InternalServerError'), { after: 1 });
      provider.failNext('deleteFaces', new Error('ServiceUnavailableException'));
      const log = memoryLogger();
      const error = await createFacesHandler(deps({ FACE_INDEX_TILING: 'always' }))(
        indexJob(file.id),
        context(log),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IndexPhotoError);
      expect((error as IndexPhotoError).orphanFaceIds).toHaveLength(3);
      // The worker's own retry deleted them; nothing was recorded.
      expect(provider.storedFaces(faceCollectionId(ownerId))).toEqual([]);
      expect(await faceRows(file.id)).toEqual([]);
      expect((await fileById(db, file.id))?.faceCount).toBeNull();
      expect(log.entries.some((e) => /deleted the faces its cleanup left/.test(e.msg))).toBe(true);
    });

    it('leaves orphans to two-job reconciliation when every delete fails', async () => {
      const { ownerId, file } = await indexedFolderWithPhoto();
      provider.failNext('indexFaces', new Error('InternalServerError'), { after: 1 });
      provider.failNext('deleteFaces', new Error('ServiceUnavailableException'), { times: 2 });
      const log = memoryLogger();
      await expect(
        createFacesHandler(deps({ FACE_INDEX_TILING: 'always' }))(indexJob(file.id), context(log)),
      ).rejects.toBeInstanceOf(IndexPhotoError);
      const collection = faceCollectionId(ownerId);
      const orphans = provider.storedFaces(collection).map((f) => f.faceId);
      expect(orphans).toHaveLength(3);
      expect(await faceRows(file.id)).toEqual([]);
      expect(log.entries.some((e) => e.level === 'error' && /reconciliation/.test(e.msg))).toBe(
        true,
      );

      // A later attempt succeeds and records its own faces (which reconciliation must keep).
      await createFacesHandler(deps())(indexJob(file.id), context());
      const recorded = (await faceRows(file.id)).map((r) => r.rekognitionFaceId);
      expect(recorded).toHaveLength(3);

      const scans = new S3OrphanScanStore(store);
      const job = (now: number): JobContext => ({
        db,
        store,
        faces: provider,
        ...testJobQueues(queues),
        log: silentLogger,
        now: () => now,
        batchSize: 50,
        deadline: now + 3_600_000,
        signal: new AbortController().signal,
      });
      const reconcile = (now: number) =>
        runFacesReconcile(job(now), { provider, scans, graceMs: GRACE });

      // Run 1 stores the scan (candidates = the orphans only) and deletes nothing.
      const t0 = clock.t;
      const first = await reconcile(t0);
      expect(first).toMatchObject({ orphansDeleted: 0, scansStored: expect.any(Number) as number });
      const scan = await scans.load(ownerId);
      expect(new Set(scan!.candidateFaceIds)).toEqual(new Set(orphans));
      expect([...store.objects.keys()]).toContain(`${RECONCILE_SCAN_PREFIX}${ownerId}.json`);
      expect(provider.storedFaces(collection)).toHaveLength(6);

      // Run 2 inside the grace keeps the stored scan and doesn't rescan.
      const second = await reconcile(t0 + GRACE / 2);
      expect(second.scansDeferred).toBeGreaterThanOrEqual(1);
      expect(await scans.load(ownerId)).toEqual(scan);
      expect(provider.storedFaces(collection)).toHaveLength(6);

      // Run 3 after the grace deletes the orphans, keeps the recorded faces, rescans clean.
      const third = await reconcile(t0 + GRACE + 1);
      expect(third.orphansDeleted).toBeGreaterThanOrEqual(3);
      expect(new Set(provider.storedFaces(collection).map((f) => f.faceId))).toEqual(
        new Set(recorded),
      );
      expect(await scans.load(ownerId)).toBeNull();
    });

    it('discards the faces when the commit comes after the record-faces deadline', async () => {
      const { ownerId, file } = await indexedFolderWithPhoto();
      const indexFaces = provider.indexFaces.bind(provider);
      provider.indexFaces = async (request) => {
        const result = await indexFaces(request);
        clock.t += GRACE / 2 + 1; // a very slow attempt
        return result;
      };
      await expect(createFacesHandler(deps())(indexJob(file.id), context())).rejects.toBeInstanceOf(
        RecordFacesDeadlineError,
      );
      expect(await faceRows(file.id)).toEqual([]);
      expect((await fileById(db, file.id))?.faceCount).toBeNull();
      expect(provider.storedFaces(faceCollectionId(ownerId))).toEqual([]);
    });

    it('discards the faces when the file is trashed while indexing', async () => {
      const { ownerId, file } = await indexedFolderWithPhoto();
      const indexFaces = provider.indexFaces.bind(provider);
      provider.indexFaces = async (request) => {
        const result = await indexFaces(request);
        await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, file.id));
        return result;
      };
      const log = memoryLogger();
      await createFacesHandler(deps())(indexJob(file.id), context(log));
      expect(log.entries.at(-1)).toMatchObject({ fields: { outcome: 'superseded' } });
      expect(await faceRows(file.id)).toEqual([]);
      expect(provider.storedFaces(faceCollectionId(ownerId))).toEqual([]);
    });
  });

  describe('index.folder', () => {
    it('queues index.file for the unindexed photos its subtree index covers', async () => {
      const { ownerId, folder, file } = await indexedFolderWithPhoto();
      const child = await createFolder(db, ownerId, { parent: folder });
      const nested = await readyPhoto(ownerId, child.id);
      const third = await readyPhoto(ownerId, child.id);
      await readyPhoto(ownerId, child.id, 'video/mp4');
      const indexed = await readyPhoto(ownerId, folder.id);
      await db.update(files).set({ faceCount: 0 }).where(eq(files.id, indexed.id));
      const sibling = await createFolder(db, ownerId);
      await readyPhoto(ownerId, sibling.id);

      const body = serializeQueueMessage('faces', { type: 'index.folder', folderId: folder.id });
      await createFacesHandler(deps({}, { features: { faceSearch: false } }))(body, context());
      expect(queues.sent).toEqual([]);

      await createFacesHandler(deps())(body, context());
      const sent = queues.sent.map((m) => (JSON.parse(m.body) as { fileId: string }).fileId);
      expect(queues.sent.every((m) => m.queueUrl === FACES_URL)).toBe(true);
      expect(new Set(sent)).toEqual(new Set([file.id, nested.id, third.id]));
    });
  });

  describe('outbox marks (faces_queued_at, face_index_queued_at)', () => {
    const marked = (at = new Date(Date.now() - 60_000)) => ({
      facesQueuedAt: at,
      facesRequeues: 2,
    });

    it('index.file clears its mark and requeue counter when it ends, whatever the outcome', async () => {
      const { file } = await indexedFolderWithPhoto();
      await db.update(files).set(marked()).where(eq(files.id, file.id));
      await createFacesHandler(deps())(indexJob(file.id), context());
      expect(await fileById(db, file.id)).toMatchObject({
        facesQueuedAt: null,
        facesRequeues: 0,
      });
      expect((await fileById(db, file.id))?.faceCount).not.toBeNull();

      // Skipped outcomes end the job too (here: not covered, root file).
      const root = await readyPhoto((await fileById(db, file.id))!.ownerId, null);
      await db.update(files).set(marked()).where(eq(files.id, root.id));
      await createFacesHandler(deps())(indexJob(root.id), context());
      expect((await fileById(db, root.id))?.facesQueuedAt).toBeNull();
    });

    it('keeps the mark when the job fails (a retry or faces.sweep re-sends)', async () => {
      const { file } = await indexedFolderWithPhoto();
      await db.update(files).set(marked()).where(eq(files.id, file.id));
      provider.indexFaces = () => Promise.reject(new Error('Rekognition down'));
      await expect(createFacesHandler(deps())(indexJob(file.id), context())).rejects.toThrow();
      expect(await fileById(db, file.id)).toMatchObject({ facesRequeues: 2 });
      expect((await fileById(db, file.id))?.facesQueuedAt).toBeInstanceOf(Date);
    });

    it('keeps a newer mark set while the job ran (that send starts its own job)', async () => {
      const { file } = await indexedFolderWithPhoto();
      await db.update(files).set(marked()).where(eq(files.id, file.id));
      const newer = new Date();
      // A fan-out re-marks the file while this index.file job runs.
      const collections = new CollectionRegistry(provider);
      const ensure = collections.ensure.bind(collections);
      collections.ensure = async (id) => {
        await db.update(files).set({ facesQueuedAt: newer }).where(eq(files.id, file.id));
        return ensure(id);
      };
      await createFacesHandler(deps({}, { collections }))(indexJob(file.id), context());
      expect((await fileById(db, file.id))?.faceCount).not.toBeNull();
      expect((await fileById(db, file.id))?.facesQueuedAt?.getTime()).toBe(newer.getTime());
    });

    it('index.folder marks the files it sends and clears the folder mark when done', async () => {
      const { ownerId, folder, file } = await indexedFolderWithPhoto();
      const second = await readyPhoto(ownerId, folder.id);
      const third = await readyPhoto(ownerId, folder.id); // batchSize 2: two batches
      await db
        .update(folders)
        .set({ faceIndexQueuedAt: new Date(Date.now() - 60_000) })
        .where(eq(folders.id, folder.id));
      const body = serializeQueueMessage('faces', { type: 'index.folder', folderId: folder.id });
      await createFacesHandler(deps())(body, context());
      for (const id of [file.id, second.id, third.id]) {
        expect((await fileById(db, id))?.facesQueuedAt).toBeInstanceOf(Date);
      }
      const [row] = await db
        .select({ queuedAt: folders.faceIndexQueuedAt })
        .from(folders)
        .where(eq(folders.id, folder.id));
      expect(row?.queuedAt).toBeNull();
    });

    it('keeps every mark while FACE_SEARCH_ENABLED is false (re-sent once it is on)', async () => {
      const { folder, file } = await indexedFolderWithPhoto();
      const queuedAt = new Date(Date.now() - 60_000);
      await db
        .update(folders)
        .set({ faceIndexQueuedAt: queuedAt })
        .where(eq(folders.id, folder.id));
      await db.update(files).set(marked(queuedAt)).where(eq(files.id, file.id));
      const off = createFacesHandler(deps({}, { features: { faceSearch: false } }));
      await off(
        serializeQueueMessage('faces', { type: 'index.folder', folderId: folder.id }),
        context(),
      );
      await off(indexJob(file.id), context());
      expect(queues.sent).toEqual([]);
      expect(provider.calls.indexFaces).toBe(0);
      const [row] = await db
        .select({ queuedAt: folders.faceIndexQueuedAt })
        .from(folders)
        .where(eq(folders.id, folder.id));
      expect(row?.queuedAt?.getTime()).toBe(queuedAt.getTime());
      expect(await fileById(db, file.id)).toMatchObject({
        facesQueuedAt: queuedAt,
        facesRequeues: 2,
      });
    });

    it('index.folder clears the folder mark when the folder is gone or trashed', async () => {
      const { folder } = await indexedFolderWithPhoto();
      await db
        .update(folders)
        .set({ faceIndexQueuedAt: new Date(Date.now() - 60_000), deletedAt: new Date() })
        .where(eq(folders.id, folder.id));
      const body = serializeQueueMessage('faces', { type: 'index.folder', folderId: folder.id });
      await createFacesHandler(deps())(body, context());
      expect(queues.sent).toEqual([]);
      const [row] = await db
        .select({ queuedAt: folders.faceIndexQueuedAt })
        .from(folders)
        .where(eq(folders.id, folder.id));
      expect(row?.queuedAt).toBeNull();
    });
  });

  describe('unindex.folder and faces.expire.daily', () => {
    it('deletes faces no active index covers, even with the flag off, and keeps covered ones', async () => {
      const { ownerId, folder, file } = await indexedFolderWithPhoto(90 * DAY);
      const child = await createFolder(db, ownerId, {
        parent: folder,
        faceIndexEnabled: true,
        faceIndexExpiresAt: new Date(Date.now() + 90 * DAY),
      });
      const inChild = await readyPhoto(ownerId, child.id);
      const handler = createFacesHandler(deps());
      await handler(indexJob(file.id), context());
      await handler(indexJob(inChild.id), context());

      await db
        .update(folders)
        .set({ faceIndexEnabled: false, faceIndexExpiresAt: null })
        .where(eq(folders.id, folder.id));
      const unindex = serializeQueueMessage('faces', {
        type: 'unindex.folder',
        folderId: folder.id,
      });
      await createFacesHandler(deps({}, { features: { faceSearch: false } }))(unindex, context());
      expect(await faceRows(file.id)).toEqual([]);
      expect((await fileById(db, file.id))?.faceCount).toBeNull();
      // The child folder's own index still covers its photo.
      expect(await faceRows(inChild.id)).toHaveLength(3);
      const collection = faceCollectionId(ownerId);
      expect(provider.storedFaces(collection)).toHaveLength(3);
      // Idempotent.
      await createFacesHandler(deps())(unindex, context());
      expect(provider.storedFaces(collection)).toHaveLength(3);

      // The child's index expires: the daily job deletes the rest.
      await db
        .update(folders)
        .set({ faceIndexExpiresAt: new Date(Date.now() - 1000) })
        .where(eq(folders.id, child.id));
      const result = await runFacesExpire({
        db,
        store,
        faces: provider,
        ...testJobQueues(queues),
        log: silentLogger,
        now: Date.now,
        batchSize: 2,
        deadline: Date.now() + 3_600_000,
        signal: new AbortController().signal,
      });
      expect(result).toMatchObject({ facesDeleted: 3, filesCleared: 1, complete: true });
      expect(provider.storedFaces(collection)).toEqual([]);
      expect(await faceRows(inChild.id)).toEqual([]);
    });

    it('keeps faces whose DeleteFaces failed and retries the message', async () => {
      const { ownerId, folder, file } = await indexedFolderWithPhoto();
      await createFacesHandler(deps())(indexJob(file.id), context());
      await db
        .update(folders)
        .set({ faceIndexEnabled: false, faceIndexExpiresAt: null })
        .where(eq(folders.id, folder.id));
      provider.failNext('deleteFaces', new Error('ThrottlingException'));
      const unindex = serializeQueueMessage('faces', {
        type: 'unindex.folder',
        folderId: folder.id,
      });
      await expect(createFacesHandler(deps())(unindex, context())).rejects.toThrow(/kept 2 faces/);
      // Batches of 2: the first batch's DeleteFaces failed, the second went through.
      expect(await faceRows(file.id)).toHaveLength(2);
      await createFacesHandler(deps())(unindex, context());
      expect(await faceRows(file.id)).toEqual([]);
      expect(provider.storedFaces(faceCollectionId(ownerId))).toEqual([]);
    });
  });

  describe('delete.faces', () => {
    it('deletes the marked faces, recomputes face_count and completes once', async () => {
      const { ownerId, file } = await indexedFolderWithPhoto();
      await createFacesHandler(deps())(indexJob(file.id), context());
      const rows = await faceRows(file.id);
      const [deletion] = await db
        .insert(faceDeletions)
        .values({ photographerId: ownerId, shareId: randomUUID(), facesMatched: 2 })
        .returning();
      const marked = rows.slice(0, 2);
      await db
        .update(faces)
        .set({ deletionId: deletion!.id })
        .where(
          inArray(
            faces.id,
            marked.map((r) => r.id),
          ),
        );

      const body = serializeQueueMessage('faces', {
        type: 'delete.faces',
        deletionId: deletion!.id,
      });
      // PDPA: runs with face search switched off.
      const handler = createFacesHandler(deps({}, { features: { faceSearch: false } }));
      await handler(body, context());
      const left = await faceRows(file.id);
      expect(left.map((r) => r.id)).toEqual([rows[2]!.id]);
      const stored = provider.storedFaces(faceCollectionId(ownerId)).map((f) => f.faceId);
      expect(stored).toEqual([rows[2]!.rekognitionFaceId]);
      expect((await fileById(db, file.id))?.faceCount).toBe(1);
      const [done] = await db
        .select()
        .from(faceDeletions)
        .where(eq(faceDeletions.id, deletion!.id));
      expect(done).toMatchObject({ facesDeleted: 2, completedAt: expect.any(Date) as Date });

      const deleteCalls = provider.calls.deleteFaces;
      await handler(body, context());
      expect(provider.calls.deleteFaces).toBe(deleteCalls);
      const [again] = await db
        .select()
        .from(faceDeletions)
        .where(eq(faceDeletions.id, deletion!.id));
      expect(again?.completedAt).toEqual(done?.completedAt);
    });

    it('retries when DeleteFaces fails, and completes when the collection is gone', async () => {
      const ownerId = await createPhotographer(db);
      const [deletion] = await db
        .insert(faceDeletions)
        .values({ photographerId: ownerId, shareId: randomUUID(), facesMatched: 0 })
        .returning();
      const body = serializeQueueMessage('faces', {
        type: 'delete.faces',
        deletionId: deletion!.id,
      });
      // No collection exists for this photographer: nothing to delete, still completed.
      await createFacesHandler(deps())(body, context());
      const [done] = await db
        .select()
        .from(faceDeletions)
        .where(eq(faceDeletions.id, deletion!.id));
      expect(done).toMatchObject({ facesDeleted: 0 });
      expect(done?.completedAt).not.toBeNull();

      const { ownerId: other, file } = await indexedFolderWithPhoto();
      await createFacesHandler(deps())(indexJob(file.id), context());
      const [second] = await db
        .insert(faceDeletions)
        .values({ photographerId: other, shareId: randomUUID(), facesMatched: 3 })
        .returning();
      await db.update(faces).set({ deletionId: second!.id }).where(eq(faces.fileId, file.id));
      provider.failNext('deleteFaces', new Error('ThrottlingException'));
      const secondBody = serializeQueueMessage('faces', {
        type: 'delete.faces',
        deletionId: second!.id,
      });
      await expect(createFacesHandler(deps())(secondBody, context())).rejects.toThrow();
      expect(await faceRows(file.id)).toHaveLength(3);
      await createFacesHandler(deps())(secondBody, context());
      expect(await faceRows(file.id)).toEqual([]);
      expect((await fileById(db, file.id))?.faceCount).toBe(0);
    });
  });

  it('rejects messages that are not faces jobs', async () => {
    await expect(createFacesHandler(deps())('{"type":"index.user"}', context())).rejects.toThrow();
    expect(await db.select({ id: users.id }).from(users).limit(1)).toBeDefined();
  });
});
