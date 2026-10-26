import { randomBytes, randomUUID } from 'node:crypto';
import { files, shares, zipJobEntries, zipJobs } from '@shotx/db';
import { derivedKey, serializeQueueMessage, zipKey } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import yauzl from 'yauzl';
import type { ZipConfig } from '../config';
import type { Db } from '../db';
import { memoryLogger, silentLogger } from '../logger';
import type { MessageContext } from '../sqs/consumer';
import {
  createFileRow,
  createPhotographer,
  openTestDatabase,
  type TestDatabase,
} from '../testing/database';
import { MemoryObjectStore } from '../testing/memory-aws';
import { createZipHandler } from './handler';

const MiB = 1024 * 1024;
const ZIP: ZipConfig = { maxFiles: 10, maxBytes: 4 * MiB, resultTtlSeconds: 86_400 };

interface ReadEntry {
  name: string;
  compressionMethod: number;
  data: Buffer;
}

function readZip(buffer: Buffer): Promise<ReadEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (error, zip) => {
      if (error) return reject(error);
      const out: ReadEntry[] = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(out));
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            out.push({
              name: entry.fileName,
              compressionMethod: entry.compressionMethod,
              data: Buffer.concat(chunks),
            });
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}

let tokenSeq = 0;

describe('zip consumer', () => {
  let database: TestDatabase;
  let db: Db;
  let store: MemoryObjectStore;

  beforeAll(async () => {
    database = await openTestDatabase();
    db = database.db;
  });
  afterAll(async () => {
    await database.close();
  });
  beforeEach(() => {
    store = new MemoryObjectStore();
  });

  const context = (receiveCount = 1, log = silentLogger, signal = new AbortController().signal) =>
    ({ messageId: 'm', receiveCount, signal, log }) satisfies MessageContext;

  const handler = (zip: ZipConfig = ZIP) =>
    createZipHandler({ db, store, zip, partBytes: 5 * MiB, maxProcessingMs: 600_000 });

  /** A ready photo with its original and web.jpg in the store. */
  async function photo(ownerId: string, name: string, bytes: number) {
    const file = await createFileRow(db, ownerId, {
      originalName: name,
      sizeBytes: bytes,
      status: 'ready',
      verifiedAt: new Date(),
    });
    const webKey = derivedKey({ photographerId: ownerId, fileId: file.id }, 'web');
    const original = randomBytes(bytes);
    const web = randomBytes(Math.floor(bytes / 2));
    store.seed(file.s3Key, original, 'image/jpeg');
    store.seed(webKey, web, 'image/jpeg');
    await db
      .update(files)
      .set({ webKey, webSizeBytes: web.length, takenAt: new Date('2026-10-20T01:30:00Z') })
      .where(eq(files.id, file.id));
    return { id: file.id, original, web, name };
  }

  async function job(
    sizes: number[] = [300_000, 200_000],
    options: { downloadSize?: 'web' | 'original'; names?: string[] } = {},
  ) {
    const ownerId = await createPhotographer(db);
    const photos = [];
    for (const [i, bytes] of sizes.entries()) {
      photos.push(await photo(ownerId, options.names?.[i] ?? `IMG_${i}.jpg`, bytes));
    }
    const [share] = await db
      .insert(shares)
      .values({
        ownerId,
        targetType: 'file',
        targetFileId: photos[0]!.id,
        token: `Zip${String(++tokenSeq).padStart(19, '0')}`,
      })
      .returning({ id: shares.id });
    const [created] = await db
      .insert(zipJobs)
      .values({
        photographerId: ownerId,
        shareId: share!.id,
        anonId: randomUUID(),
        downloadSize: options.downloadSize ?? 'original',
        fileCount: photos.length,
        totalBytes: sizes.reduce((a, b) => a + b, 0),
      })
      .returning({ id: zipJobs.id });
    await db.insert(zipJobEntries).values(
      photos.map((p, position) => ({
        jobId: created!.id,
        photographerId: ownerId,
        position,
        fileId: p.id,
        name: p.name,
      })),
    );
    const body = serializeQueueMessage('zip', { type: 'zip.create', jobId: created!.id });
    return { ownerId, jobId: created!.id, photos, body };
  }

  async function jobRow(id: string) {
    const [row] = await db.select().from(zipJobs).where(eq(zipJobs.id, id));
    return row!;
  }

  it('streams the originals into tmp/zips/{jobId}.zip with STORE and marks it ready', async () => {
    const { jobId, photos, body } = await job([300_000, 200_000, 150_000], {
      names: ['งานวิ่ง 0001.jpg', 'IMG_0002.JPG', 'finish line.jpg'],
    });
    await handler()(body, context());

    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'ready', resultKey: zipKey(jobId), attempts: 1 });
    expect(row.errorCode).toBeNull();
    // expires_at = completed_at + ZIP_RESULT_TTL_SECONDS
    expect(row.expiresAt!.getTime() - row.completedAt!.getTime()).toBe(86_400_000);

    const archive = store.objects.get(zipKey(jobId))!;
    expect(archive.contentType).toBe('application/zip');
    expect(row.resultBytes).toBe(archive.body.length);
    const entries = await readZip(archive.body);
    expect(entries.map((e) => e.name)).toEqual(photos.map((p) => p.name));
    expect(entries.every((e) => e.compressionMethod === 0)).toBe(true); // STORE
    entries.forEach((e, i) => expect(e.data.equals(photos[i]!.original)).toBe(true));
    // STORE: the archive is the data plus headers, nothing compressed.
    expect(archive.body.length).toBeGreaterThan(650_000);
    expect(archive.body.length).toBeLessThan(650_000 + 2000);
  });

  it('streams: one source object open at a time, data passed on in chunks, parts sized', async () => {
    const { jobId, body } = await job([2_500_000, 2_200_000, 2_000_000]);
    await handler({ ...ZIP, maxBytes: 16 * MiB })(body, context());
    expect((await jobRow(jobId)).status).toBe('ready');
    expect(store.calls.streamsOpened).toBe(3);
    expect(store.calls.maxOpenStreams).toBe(1);
    const [upload] = store.calls.uploads;
    expect(upload).toMatchObject({ key: zipKey(jobId), partBytes: 5 * MiB });
    // The upload received the archive in pieces, never an object whole.
    // Chunks of about archiver's highWaterMark (1 MiB), smaller than any of the objects.
    expect(upload!.maxChunk).toBeLessThan(2_000_000);
    expect(upload!.bytes).toBeGreaterThan(6_700_000);
  });

  it('zips web.jpg for web-size jobs', async () => {
    const { jobId, photos, body } = await job([100_000, 80_000], { downloadSize: 'web' });
    await handler()(body, context());
    const entries = await readZip(store.objects.get(zipKey(jobId))!.body);
    entries.forEach((e, i) => expect(e.data.equals(photos[i]!.web)).toBe(true));
  });

  it('is idempotent: finished jobs are acknowledged, live attempts are left alone', async () => {
    const { jobId, body } = await job();
    const zip = handler();
    await zip(body, context());
    await zip(body, context(2));
    expect(store.calls.uploads).toHaveLength(1);
    expect((await jobRow(jobId)).attempts).toBe(1);

    // A duplicate first delivery while another attempt runs: left to that attempt.
    const second = await job();
    await db
      .update(zipJobs)
      .set({ status: 'running', attempts: 1, startedAt: new Date() })
      .where(eq(zipJobs.id, second.jobId));
    const log = memoryLogger();
    await zip(second.body, context(1, log));
    expect(log.entries.at(-1)).toMatchObject({ fields: { outcome: 'busy' } });
    expect((await jobRow(second.jobId)).status).toBe('running');

    // A redelivery means the previous holder died: taken over.
    await zip(second.body, context(2));
    expect(await jobRow(second.jobId)).toMatchObject({ status: 'ready', attempts: 2 });

    // A running attempt older than WORKER_ZIP_MAX_PROCESSING_SECONDS is taken over too.
    const third = await job();
    await db
      .update(zipJobs)
      .set({ status: 'running', attempts: 1, startedAt: new Date(Date.now() - 3_600_000) })
      .where(eq(zipJobs.id, third.jobId));
    await zip(third.body, context(1));
    expect(await jobRow(third.jobId)).toMatchObject({ status: 'ready', attempts: 2 });

    // Missing jobs (share purged) are acknowledged.
    await zip(serializeQueueMessage('zip', { type: 'zip.create', jobId: randomUUID() }), context());
  });

  it('fails jobs over ZIP_MAX_FILES or ZIP_MAX_BYTES without writing an archive', async () => {
    const tooMany = await job([1000, 1000, 1000]);
    await handler({ ...ZIP, maxFiles: 2 })(tooMany.body, context());
    expect(await jobRow(tooMany.jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'ZIP_TOO_LARGE',
      resultKey: null,
    });

    const tooBig = await job([3 * MiB, 2 * MiB]);
    await handler()(tooBig.body, context());
    expect(await jobRow(tooBig.jobId)).toMatchObject({
      status: 'failed',
      errorCode: 'ZIP_TOO_LARGE',
    });
    expect(store.calls.uploads).toEqual([]);
    expect(store.objects.has(zipKey(tooBig.jobId))).toBe(false);
  });

  it('fails with NOT_FOUND when files were purged or trashed since the job was created', async () => {
    const purged = await job();
    await db.delete(zipJobEntries).where(eq(zipJobEntries.fileId, purged.photos[1]!.id));
    await handler()(purged.body, context());
    expect(await jobRow(purged.jobId)).toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' });

    const trashed = await job();
    await db
      .update(files)
      .set({ deletedAt: new Date() })
      .where(eq(files.id, trashed.photos[0]!.id));
    await handler()(trashed.body, context());
    expect(await jobRow(trashed.jobId)).toMatchObject({ status: 'failed', errorCode: 'NOT_FOUND' });
  });

  it('aborts the upload when a source stream breaks: failed, and no partial archive', async () => {
    const { jobId, photos, body } = await job([300_000, 300_000]);
    store.failStreams.add(
      (await db.select().from(files).where(eq(files.id, photos[1]!.id)))[0]!.s3Key,
    );
    await handler()(body, context());
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'failed', errorCode: 'INTERNAL_ERROR', resultKey: null });
    expect(row.errorMessage).not.toContain(photos[1]!.name);
    expect(store.objects.has(zipKey(jobId))).toBe(false);
  });

  it('fails the job instead of hanging when the upload fails', async () => {
    const { jobId, body } = await job([300_000, 300_000]);
    store.failUploads = true;
    try {
      await handler()(body, context());
    } finally {
      store.failUploads = false;
    }
    const row = await jobRow(jobId);
    expect(row).toMatchObject({ status: 'failed', resultKey: null });
    // The S3 error, not the AbortError of the archive lib-storage stopped reading.
    expect(row.errorMessage).toBe('Streaming failed: NoSuchBucket');
    expect(store.objects.has(zipKey(jobId))).toBe(false);
  }, 10_000);

  it('leaves the job to the next delivery when the message is lost or the worker stops', async () => {
    const { jobId, body } = await job();
    const abort = new AbortController();
    abort.abort(new Error('lost'));
    await expect(handler()(body, context(1, silentLogger, abort.signal))).rejects.toThrow();
    expect((await jobRow(jobId)).status).toBe('running');
    await handler()(body, context(2));
    expect((await jobRow(jobId)).status).toBe('ready');
  });
});
