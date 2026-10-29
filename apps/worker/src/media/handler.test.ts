import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { files } from '@shotx/db';
import {
  derivedKey,
  loadMediaConfig,
  originalCompletedMessage,
  QueueMessageError,
} from '@shotx/shared';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { cameraJpeg, ffmpegAvailable, pngBytes, sampleVideo } from '../testing/fixtures';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import { createMediaHandler } from './handler';

const BUCKET = 'shotx-test-media';
const FACES_URL = 'http://sqs.local/queue/faces';

/** The body S3 sends to SQS for a completed upload (keys URL-encoded, space as +). */
function s3EventBody(key: string, size: number): string {
  const encoded = encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+');
  return JSON.stringify({
    Records: [
      {
        eventVersion: '2.1',
        eventSource: 'aws:s3',
        awsRegion: 'ap-southeast-1',
        eventTime: '2026-10-25T05:12:31.123Z',
        eventName: 'ObjectCreated:CompleteMultipartUpload',
        s3: {
          s3SchemaVersion: '1.0',
          bucket: { name: BUCKET },
          object: { key: encoded, size, sequencer: '0066A1B2C3D4E5F601' },
        },
      },
    ],
  });
}

function context(): MessageContext {
  return {
    messageId: 'm-1',
    receiveCount: 1,
    signal: new AbortController().signal,
    log: silentLogger,
  };
}

describe('media consumer', () => {
  let database: TestDatabase;
  let db: Db;
  let store: MemoryObjectStore;
  let queues: MemoryQueueClient;
  let handle: ReturnType<typeof createMediaHandler>;
  let jpeg: Buffer;

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
    jpeg = await cameraJpeg();
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
      bucket: BUCKET,
      facesQueueUrl: FACES_URL,
      media: loadMediaConfig({}),
      video: {
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        x264Preset: 'ultrafast',
        audioBitrateKbps: 96,
      },
      exifDefaultUtcOffset: '+07:00',
      maxProcessingMs: 60_000,
      originalsStorageClass: 'INTELLIGENT_TIERING',
      partBytes: 16 * 1024 * 1024,
    });
  });

  /** A photographer with one reserved upload whose object is in S3. */
  async function upload(
    bytes: Uint8Array,
    options: {
      mime?: string;
      sizeBytes?: number;
      name?: string;
      folderId?: string | null;
      uploading?: boolean;
      ownerId?: string;
    } = {},
  ) {
    const sizeBytes = options.sizeBytes ?? bytes.length;
    const ownerId = options.ownerId ?? (await createPhotographer(db, { reservedBytes: sizeBytes }));
    const file = await createFileRow(db, ownerId, {
      mime: options.mime ?? 'image/jpeg',
      sizeBytes,
      originalName: options.name ?? 'งานวิ่ง IMG 0001.jpg',
      folderId: options.folderId ?? null,
      status: options.uploading === true ? 'uploading' : 'processing',
      ...(options.uploading === true
        ? { uploadId: 'mpu-1', uploadExpiresAt: new Date(Date.now() + 3_600_000) }
        : {}),
    });
    store.seed(file.s3Key, bytes);
    return { ownerId, ...file, body: s3EventBody(file.s3Key, bytes.length) };
  }

  it('verifies, moves the bytes, writes derivatives and marks the file ready', async () => {
    const { ownerId, id, s3Key, body } = await upload(jpeg, { uploading: true });
    await handle(body, context());

    const row = await fileById(db, id);
    expect(row).toMatchObject({
      status: 'ready',
      uploadId: null,
      width: 2000,
      height: 3000,
      sha256: createHash('sha256').update(jpeg).digest('hex'),
      thumbKey: derivedKey({ photographerId: ownerId, fileId: id }, 'thumb'),
      previewKey: derivedKey({ photographerId: ownerId, fileId: id }, 'preview'),
      webKey: derivedKey({ photographerId: ownerId, fileId: id }, 'web'),
      posterKey: null,
    });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(row?.takenAt?.toISOString()).toBe('2026-10-20T01:30:00.000Z');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: jpeg.length, reservedBytes: 0 });
    expect(store.objects.has(s3Key)).toBe(true);
    const web = store.objects.get(row!.webKey!);
    expect(web?.contentType).toBe('image/jpeg');
    // web_size_bytes: the size of the web download variant, for download bytes and zip totals.
    expect(row?.webSizeBytes).toBe(web!.body.length);
    expect((await sharp(web!.body).metadata()).exif).toBeUndefined();
    expect(queues.sent).toEqual([]); // root file: no folder, no face indexing
  });

  it('is idempotent: the same message twice moves the bytes once and does not fail', async () => {
    const { ownerId, id, body } = await upload(jpeg);
    await handle(body, context());
    const puts = store.calls.put;
    await handle(body, context());
    expect(store.calls.put).toBe(puts);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: jpeg.length, reservedBytes: 0 });
    expect((await fileById(db, id))?.status).toBe('ready');
  });

  it('finishes a file an earlier attempt verified but did not mark ready, without moving bytes again', async () => {
    const { ownerId, id, body } = await upload(jpeg);
    // The earlier attempt committed the verify transaction and then crashed.
    await db.update(files).set({ verifiedAt: new Date() }).where(eq(files.id, id));
    await db.execute(
      sql`UPDATE storage_usage SET used_bytes = ${jpeg.length}, reserved_bytes = 0 WHERE photographer_id = ${ownerId}`,
    );
    await handle(body, context());
    expect((await fileById(db, id))?.status).toBe('ready');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: jpeg.length, reservedBytes: 0 });
  });

  it('rejects bytes whose magic number does not match the declared type', async () => {
    const png = await pngBytes();
    const { ownerId, id, s3Key, body } = await upload(png, { mime: 'image/jpeg', uploading: true });
    await handle(body, context());
    expect(await fileById(db, id)).toMatchObject({
      status: 'failed',
      verifiedAt: null,
      uploadId: null,
    });
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(s3Key)).toBe(false);
    expect(store.calls.put).toBe(0);
    // Redelivery changes nothing.
    store.seed(s3Key, png);
    await handle(body, context());
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(s3Key)).toBe(false);
  });

  it('rejects an executable renamed to .jpg', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(998)]);
    const { ownerId, id, body } = await upload(exe);
    await handle(body, context());
    expect((await fileById(db, id))?.status).toBe('failed');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });

  it('rejects an object whose size differs from the reservation', async () => {
    const { ownerId, id, s3Key, body } = await upload(jpeg, { sizeBytes: jpeg.length - 1 });
    await handle(body, context());
    expect((await fileById(db, id))?.status).toBe('failed');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(s3Key)).toBe(false);
  });

  it('rejects a JPEG that does not decode, before counting its bytes', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 9)]);
    const { ownerId, id, body } = await upload(broken);
    await handle(body, context());
    expect((await fileById(db, id))?.status).toBe('failed');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });

  it('deletes objects that have no file row (aborted or expired uploads)', async () => {
    const ownerId = await createPhotographer(db);
    const key = `originals/${ownerId}/${randomUUID()}/orphan.jpg`;
    store.seed(key, jpeg);
    await handle(s3EventBody(key, jpeg.length), context());
    expect(store.objects.has(key)).toBe(false);
  });

  it('deletes the object when a purge was requested and leaves the quota alone', async () => {
    const { ownerId, id, s3Key, body } = await upload(jpeg);
    await db
      .update(files)
      .set({ deletedAt: new Date(), purgeRequestedAt: new Date() })
      .where(eq(files.id, id));
    await db.execute(
      sql`UPDATE storage_usage SET reserved_bytes = 0 WHERE photographer_id = ${ownerId}`,
    );
    await handle(body, context());
    expect(store.objects.has(s3Key)).toBe(false);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect((await fileById(db, id))?.verifiedAt).toBeNull();
  });

  it('leaves objects whose key belongs to another photographer than the row', async () => {
    const { id, s3Key } = await upload(jpeg);
    const other = await createPhotographer(db);
    const forged = s3Key.replace(/^originals\/[^/]+/, `originals/${other}`);
    store.seed(forged, jpeg);
    await handle(s3EventBody(forged, jpeg.length), context());
    // No row has the forged key, so it is a stray and goes; the real file is untouched.
    expect(store.objects.has(forged)).toBe(false);
    expect((await fileById(db, id))?.status).toBe('processing');
  });

  it('queues face indexing for photos in a folder with face indexing on', async () => {
    const ownerId = await createPhotographer(db, { reservedBytes: jpeg.length });
    const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const { id, body } = await upload(jpeg, { ownerId, folderId: folder.id });
    await handle(body, context());
    expect(queues.sent).toEqual([
      { queueUrl: FACES_URL, body: JSON.stringify({ type: 'index.file', fileId: id }) },
    ]);
    // The outbox mark is set with ready; a redelivery is a no-op (faces.sweep re-sends from the
    // mark if this send was lost).
    expect((await fileById(db, id))?.facesQueuedAt).toBeInstanceOf(Date);
    await handle(body, context());
    expect(queues.sent).toHaveLength(1);
  });

  it('queues face indexing for photos in a subfolder of a face-indexed folder', async () => {
    const ownerId = await createPhotographer(db, { reservedBytes: jpeg.length });
    const parent = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const child = await createFolder(db, ownerId, { parent });
    const { id, body } = await upload(jpeg, { ownerId, folderId: child.id });
    await handle(body, context());
    expect(queues.sent).toEqual([
      { queueUrl: FACES_URL, body: JSON.stringify({ type: 'index.file', fileId: id }) },
    ]);
  });

  it("does not queue face indexing when the folder's index expired", async () => {
    const ownerId = await createPhotographer(db, { reservedBytes: jpeg.length });
    const folder = await createFolder(db, ownerId, {
      faceIndexEnabled: true,
      faceIndexExpiresAt: new Date(Date.now() - 1000),
    });
    const { body } = await upload(jpeg, { ownerId, folderId: folder.id });
    await handle(body, context());
    expect(queues.sent).toEqual([]);
  });

  it('does not queue face indexing when the folder has it off', async () => {
    const ownerId = await createPhotographer(db, { reservedBytes: jpeg.length });
    const folder = await createFolder(db, ownerId);
    const { body } = await upload(jpeg, { ownerId, folderId: folder.id });
    await handle(body, context());
    expect(queues.sent).toEqual([]);
  });

  it('processes original.completed like the S3 event; later duplicates of either are no-ops', async () => {
    const ownerId = await createPhotographer(db, { reservedBytes: jpeg.length });
    const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
    const { id, s3Key, body: s3Body } = await upload(jpeg, { ownerId, folderId: folder.id });
    const completed = JSON.stringify(
      originalCompletedMessage({ fileId: id, photographerId: ownerId, key: s3Key }),
    );
    const log = memoryLogger();
    await handle(completed, { ...context(), log });
    const row = await fileById(db, id);
    expect(row?.status).toBe('ready');
    // The index.file outbox mark is set with ready, then the job is sent.
    expect(row?.facesQueuedAt).toBeInstanceOf(Date);
    expect(queues.sent).toEqual([
      { queueUrl: FACES_URL, body: JSON.stringify({ type: 'index.file', fileId: id }) },
    ]);
    expect(log.entries.find((e) => e.msg === 'original processed')?.fields).toMatchObject({
      source: 'original.completed',
      outcome: 'ready',
    });
    const puts = store.calls.put;

    // AWS also delivers the S3 event for the same upload: nothing is counted or rendered twice.
    await handle(s3Body, context());
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: jpeg.length, reservedBytes: 0 });
    expect(store.calls.put).toBe(puts);
    expect((await fileById(db, id))?.status).toBe('ready');
    // A late duplicate of either variant for a ready file is a no-op: no second faces job.
    expect(queues.sent).toHaveLength(1);
    await handle(completed, context());
    expect(queues.sent).toHaveLength(1);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: jpeg.length, reservedBytes: 0 });
  });

  it('sets no faces outbox mark for files no face index covers', async () => {
    const { id, body } = await upload(jpeg);
    await handle(body, context());
    expect((await fileById(db, id))?.facesQueuedAt).toBeNull();
    expect(queues.sent).toEqual([]);
  });

  it('ignores S3 records of another bucket without logging keys', async () => {
    const { id, s3Key } = await upload(jpeg);
    const log = memoryLogger();
    await handle(s3EventBody(s3Key, jpeg.length).replace(BUCKET, 'other-bucket'), {
      ...context(),
      log,
    });
    expect((await fileById(db, id))?.status).toBe('processing');
    expect(store.objects.has(s3Key)).toBe(true);
    expect(log.entries.find((e) => e.level === 'warn')?.fields).toMatchObject({
      reason: 'other-bucket',
      count: 1,
    });
    expect(JSON.stringify(log.entries)).not.toContain('originals/');
  });

  it('acknowledges the S3 test event and throws QueueMessageError for invalid bodies', async () => {
    const log = memoryLogger();
    await handle(
      JSON.stringify({ Service: 'Amazon S3', Event: 's3:TestEvent', Time: 'x', Bucket: BUCKET }),
      { ...context(), log },
    );
    expect(log.entries.map((e) => e.msg)).toEqual(['S3 test event; nothing to do']);
    await expect(handle('{"Records":[]}', context())).rejects.toBeInstanceOf(QueueMessageError);
  });

  it('never logs the original key or file name', async () => {
    const log = memoryLogger();
    const { body } = await upload(await pngBytes(), { name: 'สมชาย ใจดี.jpg' });
    await handle(body, { ...context(), log });
    const text = JSON.stringify(log.entries);
    expect(text).not.toContain('สมชาย');
    expect(text).not.toContain('originals/');
  });

  it.skipIf(!ffmpegAvailable)(
    'processes videos into poster, thumb and preview.mp4 and never queues faces',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'worker-video-'));
      const video = await sampleVideo(dir).finally(() => rm(dir, { recursive: true, force: true }));
      const ownerId = await createPhotographer(db, { reservedBytes: video.length });
      const folder = await createFolder(db, ownerId, { faceIndexEnabled: true });
      const { id, body } = await upload(video, {
        ownerId,
        mime: 'video/mp4',
        name: 'clip.mp4',
        folderId: folder.id,
      });
      await handle(body, context());
      const row = await fileById(db, id);
      expect(row).toMatchObject({
        status: 'ready',
        width: 720,
        height: 1280,
        webKey: null,
        posterKey: derivedKey({ photographerId: ownerId, fileId: id }, 'poster'),
        previewKey: derivedKey({ photographerId: ownerId, fileId: id }, 'videoPreview'),
      });
      expect(store.objects.get(row!.previewKey!)?.contentType).toBe('video/mp4');
      expect(row?.webSizeBytes).toBe(store.objects.get(row!.previewKey!)!.body.length);
      expect(store.objects.get(row!.posterKey!)?.contentType).toBe('image/jpeg');
      expect(queues.sent).toEqual([]);
      expect(await usageOf(db, ownerId)).toEqual({ usedBytes: video.length, reservedBytes: 0 });
    },
  );
});
