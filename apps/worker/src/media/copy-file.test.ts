import { createHash, randomUUID } from 'node:crypto';
import { faceDeletions, faces, files } from '@shotx/db';
import {
  derivedKey,
  type DerivedVariant,
  loadDesignConfig,
  loadMediaConfig,
  serializeQueueMessage,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { memoryLogger, silentLogger } from '../logger';
import type { MessageContext } from '../queue/handler';
import {
  createFileRow,
  createFolder,
  createPhotographer,
  fileById,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../testing/database';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import { createMediaHandler } from './handler';

const FACES_URL = 'test://faces';
const SIZE = 4096;

function context(log = silentLogger): MessageContext {
  return { messageId: 'm', receiveCount: 1, signal: new AbortController().signal, log };
}

describe('media consumer: file.copy', () => {
  let database: TestDatabase;
  let db: Db;
  let store: MemoryObjectStore;
  let queues: MemoryQueueClient;
  let handle: ReturnType<typeof createMediaHandler>;

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });
  beforeEach(() => {
    store = new MemoryObjectStore();
    queues = new MemoryQueueClient();
    handle = createMediaHandler({
      db,
      store,
      queues,
      bucket: 'shotx-test-media',
      facesQueueUrl: FACES_URL,
      media: loadMediaConfig({}),
      designAssets: loadDesignConfig({}).asset,
      video: {
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        x264Preset: 'ultrafast',
        audioBitrateKbps: 96,
      },
      exifDefaultUtcOffset: '+07:00',
      faceIndexExpiryDays: 90,
      maxProcessingMs: 60_000,
      originalsStorageClass: 'INTELLIGENT_TIERING',
      partBytes: 16 * 1024 * 1024,
    });
  });

  /**
   * A ready source (image or video) with its objects, and the copy row as the API leaves it:
   * `processing`, bytes reserved, `copied_from_file_id`, no derivative keys.
   */
  async function sourceAndCopy(
    options: { video?: boolean; folderId?: string | null; ownerId?: string } = {},
  ) {
    const ownerId =
      options.ownerId ?? (await createPhotographer(db, { usedBytes: SIZE, reservedBytes: SIZE }));
    const sourceId = randomUUID();
    const parts = { photographerId: ownerId, fileId: sourceId };
    const variants: DerivedVariant[] =
      options.video === true ? ['thumb', 'poster', 'videoPreview'] : ['thumb', 'preview', 'web'];
    const keys = Object.fromEntries(variants.map((v) => [v, derivedKey(parts, v)])) as Record<
      DerivedVariant,
      string
    >;
    const bytes = Buffer.alloc(SIZE, 7);
    const source = await createFileRow(db, ownerId, {
      id: sourceId,
      originalName: options.video === true ? `clip-${sourceId}.mp4` : `src-${sourceId}.jpg`,
      mime: options.video === true ? 'video/mp4' : 'image/jpeg',
      sizeBytes: SIZE,
      status: 'ready',
      verifiedAt: new Date(),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: 2000,
      height: 3000,
      takenAt: new Date('2026-10-20T01:30:00Z'),
      thumbKey: keys.thumb,
      previewKey: options.video === true ? keys.videoPreview : keys.preview,
      webKey: options.video === true ? null : keys.web,
      posterKey: options.video === true ? keys.poster : null,
      webSizeBytes: 1234,
      folderId: options.folderId ?? null,
      faceCount: 4, // the source is indexed; the copy must not inherit it
    });
    store.seed(source.s3Key, bytes, options.video === true ? 'video/mp4' : 'image/jpeg');
    for (const key of Object.values(keys)) store.seed(key, Buffer.from(key), 'image/webp');
    const copy = await createFileRow(db, ownerId, {
      originalName: options.video === true ? `copy-${sourceId}.mp4` : `copy-${sourceId}.jpg`,
      mime: options.video === true ? 'video/mp4' : 'image/jpeg',
      sizeBytes: SIZE,
      status: 'processing',
      copiedFromFileId: sourceId,
      folderId: options.folderId ?? null,
    });
    const body = serializeQueueMessage('media', {
      kind: 'file.copy',
      fileId: copy.id,
      sourceFileId: sourceId,
      photographerId: ownerId,
    });
    return { ownerId, source, copy, keys, bytes, body };
  }

  it('copies the original and derivatives server-side, verifies and marks the copy ready', async () => {
    const ownerId = await createPhotographer(db, { usedBytes: SIZE, reservedBytes: SIZE });
    const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const { source, copy, bytes, body } = await sourceAndCopy({ ownerId, folderId: folder.id });
    const log = memoryLogger();
    await handle(body, context(log));

    const row = await fileById(db, copy.id);
    const parts = { photographerId: ownerId, fileId: copy.id };
    expect(row).toMatchObject({
      status: 'ready',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      width: 2000,
      height: 3000,
      thumbKey: derivedKey(parts, 'thumb'),
      previewKey: derivedKey(parts, 'preview'),
      webKey: derivedKey(parts, 'web'),
      posterKey: null,
      webSizeBytes: 1234,
      faceCount: null, // faces are never copied
    });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(row?.takenAt?.toISOString()).toBe('2026-10-20T01:30:00.000Z');
    // Server-side copies; the original with the originals storage class.
    expect(store.calls.copies).toContainEqual({
      source: source.s3Key,
      target: copy.s3Key,
      storageClass: 'INTELLIGENT_TIERING',
    });
    expect(store.calls.copies).toHaveLength(4);
    expect(store.objects.get(copy.s3Key)?.body.equals(bytes)).toBe(true);
    expect(store.objects.get(derivedKey(parts, 'web'))?.contentType).toBe('image/webp');
    // Bytes reserved -> used once.
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 2 * SIZE, reservedBytes: 0 });
    // Indexed like a new photo: outbox mark and index.file.
    expect(row?.facesQueuedAt).toBeInstanceOf(Date);
    expect(queues.sent).toEqual([
      { queueUrl: FACES_URL, body: JSON.stringify({ type: 'index.file', fileId: copy.id }) },
    ]);
    expect(log.entries.find((e) => e.msg === 'file copy processed')?.fields).toMatchObject({
      outcome: 'ready',
    });
    expect(JSON.stringify(log.entries)).not.toContain('originals/');

    // Redelivery: a no-op.
    await handle(body, context());
    expect(store.calls.copies).toHaveLength(4);
    expect(queues.sent).toHaveLength(1);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 2 * SIZE, reservedBytes: 0 });
  });

  it('withholds the copy and sends no index.file when the source is withheld', async () => {
    const ownerId = await createPhotographer(db, { usedBytes: SIZE, reservedBytes: SIZE });
    const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const { source, copy, body } = await sourceAndCopy({ ownerId, folderId: folder.id });
    // A deletion completed after the copy was requested (the API copied a null mark).
    await db.update(files).set({ facesWithheldAt: new Date() }).where(eq(files.id, source.id));
    await handle(body, context());
    const row = await fileById(db, copy.id);
    expect(row).toMatchObject({ status: 'ready', facesQueuedAt: null });
    expect(row?.facesWithheldAt).toBeInstanceOf(Date);
    expect(queues.sent).toEqual([]);
  });

  it('withholds the copy when the source has a face deletion pending', async () => {
    const ownerId = await createPhotographer(db, { usedBytes: SIZE, reservedBytes: SIZE });
    const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const { source, copy, body } = await sourceAndCopy({ ownerId, folderId: folder.id });
    const [deletion] = await db
      .insert(faceDeletions)
      .values({ photographerId: ownerId, shareId: randomUUID(), facesMatched: 1 })
      .returning({ id: faceDeletions.id });
    await db.insert(faces).values({
      fileId: source.id,
      ownerId,
      rekognitionFaceId: randomUUID(),
      bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
      confidence: 99,
      deletionId: deletion!.id,
    });
    await handle(body, context());
    expect((await fileById(db, copy.id))?.facesWithheldAt).toBeInstanceOf(Date);
    expect(queues.sent).toEqual([]);
  });

  it('keeps a mark the API copied from the source: no index.file', async () => {
    const ownerId = await createPhotographer(db, { usedBytes: SIZE, reservedBytes: SIZE });
    const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const { copy, body } = await sourceAndCopy({ ownerId, folderId: folder.id });
    const inherited = new Date(Date.now() - 60_000);
    await db.update(files).set({ facesWithheldAt: inherited }).where(eq(files.id, copy.id));
    await handle(body, context());
    expect(await fileById(db, copy.id)).toMatchObject({
      status: 'ready',
      facesQueuedAt: null,
      facesWithheldAt: inherited,
    });
    expect(queues.sent).toEqual([]);
  });

  it('copies videos (poster, preview.mp4) and never queues faces for them', async () => {
    const ownerId = await createPhotographer(db, { usedBytes: SIZE, reservedBytes: SIZE });
    const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const { copy, body } = await sourceAndCopy({ ownerId, video: true, folderId: folder.id });
    await handle(body, context());
    const parts = { photographerId: ownerId, fileId: copy.id };
    expect(await fileById(db, copy.id)).toMatchObject({
      status: 'ready',
      posterKey: derivedKey(parts, 'poster'),
      previewKey: derivedKey(parts, 'videoPreview'),
      webKey: null,
      facesQueuedAt: null,
    });
    expect(queues.sent).toEqual([]);
  });

  it('fails the copy and releases the reservation when the source is gone', async () => {
    const { ownerId, source, copy, body } = await sourceAndCopy();
    // Purged: the row and its objects are gone.
    await db.delete(files).where(eq(files.id, source.id));
    await handle(body, context());
    expect(await fileById(db, copy.id)).toMatchObject({ status: 'failed', verifiedAt: null });
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: SIZE, reservedBytes: 0 });
    expect(store.objects.has(copy.s3Key)).toBe(false);
    // Redelivered after the failure: nothing changes.
    await handle(body, context());
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: SIZE, reservedBytes: 0 });
  });

  it('fails the copy when the source objects vanished mid-way, deleting what it copied', async () => {
    const { ownerId, copy, keys, body } = await sourceAndCopy();
    store.objects.delete(keys.web); // purge in progress
    await handle(body, context());
    expect((await fileById(db, copy.id))?.status).toBe('failed');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: SIZE, reservedBytes: 0 });
    const parts = { photographerId: ownerId, fileId: copy.id };
    expect(store.objects.has(copy.s3Key)).toBe(false);
    expect(store.objects.has(derivedKey(parts, 'thumb'))).toBe(false);
  });

  it('fails a copy whose source is purge-requested or not ready', async () => {
    const { source, copy, body } = await sourceAndCopy();
    await db
      .update(files)
      .set({ deletedAt: new Date(), purgeRequestedAt: new Date() })
      .where(eq(files.id, source.id));
    await handle(body, context());
    expect((await fileById(db, copy.id))?.status).toBe('failed');
    expect(store.calls.copies).toEqual([]);
  });

  it('leaves rows that do not match the message, and cleans up purge-requested copies', async () => {
    const { ownerId, copy, body } = await sourceAndCopy();
    const other = JSON.parse(body) as Record<string, string>;
    const log = memoryLogger();
    await handle(JSON.stringify({ ...other, sourceFileId: randomUUID() }), context(log));
    expect((await fileById(db, copy.id))?.status).toBe('processing');
    expect(log.entries.some((e) => e.level === 'error')).toBe(true);

    await db
      .update(files)
      .set({ deletedAt: new Date(), purgeRequestedAt: new Date() })
      .where(eq(files.id, copy.id));
    store.seed(copy.s3Key, Buffer.from('partial'));
    await handle(body, context());
    expect(store.objects.has(copy.s3Key)).toBe(false);
    expect((await usageOf(db, ownerId))?.reservedBytes).toBe(SIZE); // the purge releases it
  });

  it('fails a verified copy (crash before ready) whose source went, keeping its counted bytes', async () => {
    const { ownerId, source, copy, body } = await sourceAndCopy();
    await handle(body, context());
    // Simulate the crash: verified but not ready.
    await db.update(files).set({ status: 'processing' }).where(eq(files.id, copy.id));
    await db.delete(files).where(eq(files.id, source.id));
    await handle(body, context());
    expect(await fileById(db, copy.id)).toMatchObject({ status: 'failed' });
    expect((await fileById(db, copy.id))?.verifiedAt).toBeInstanceOf(Date);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 2 * SIZE, reservedBytes: 0 });
    expect(store.objects.has(copy.s3Key)).toBe(true);
  });
});
