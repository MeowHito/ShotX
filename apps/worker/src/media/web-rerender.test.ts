import { randomUUID } from 'node:crypto';
import { files } from '@shotx/db';
import { loadDesignConfig, loadMediaConfig, serializeQueueMessage } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { silentLogger } from '../logger';
import type { MessageContext } from '../sqs/consumer';
import {
  createFileRow,
  createPhotographer,
  fileById,
  openTestDatabase,
  type TestDatabase,
} from '../testing/database';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import { createMediaHandler } from './handler';

/** A cap small enough for a test image to be over it (ADR 0028's default is 1.5 MB). */
const CAP = 120_000;
const media = loadMediaConfig({});

function context(): MessageContext {
  return {
    messageId: 'm-1',
    receiveCount: 1,
    signal: new AbortController().signal,
    log: silentLogger,
  };
}

/** Noise barely compresses: a 1600 x 1200 JPEG well over CAP at any quality. */
async function noisyJpeg(): Promise<Buffer> {
  const raw = Buffer.alloc(1600 * 1200 * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
  return sharp(raw, { raw: { width: 1600, height: 1200, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

describe('web.rerender (ADR 0028)', () => {
  let database: TestDatabase;
  let db: Db;
  let store: MemoryObjectStore;
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
    handle = createMediaHandler({
      db,
      store,
      queues: new MemoryQueueClient(),
      bucket: 'shotx-test-media',
      facesQueueUrl: 'test://faces',
      media: { ...media, web: { ...media.web, maxBytes: CAP } },
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

  /** A ready image whose stored web.jpg is over the cap. */
  async function oversized(extra: Parameters<typeof createFileRow>[2] = {}) {
    const ownerId = await createPhotographer(db);
    const original = await noisyJpeg();
    const id = randomUUID();
    const webKey = `derived/${ownerId}/${id}/web.jpg`;
    const row = await createFileRow(db, ownerId, {
      id,
      status: 'ready',
      verifiedAt: new Date(),
      sizeBytes: original.length,
      webKey,
      webSizeBytes: CAP * 3,
      ...extra,
    });
    store.seed(row.s3Key, original, 'image/jpeg');
    store.seed(webKey, Buffer.alloc(CAP * 3, 1), 'image/jpeg');
    const message = serializeQueueMessage('media', {
      kind: 'web.rerender',
      fileId: id,
      photographerId: ownerId,
    });
    return { ownerId, id, webKey, message };
  }

  it('renders web.jpg again under the cap and records its size; a redelivery is a no-op', async () => {
    const { id, webKey, message } = await oversized();
    await handle(message, context());
    const web = store.objects.get(webKey);
    expect(web?.contentType).toBe('image/jpeg');
    expect(web!.body.length).toBeLessThanOrEqual(CAP);
    expect((await sharp(web!.body).metadata()).format).toBe('jpeg');
    expect((await fileById(db, id))?.webSizeBytes).toBe(web!.body.length);

    await handle(message, context());
    expect(store.objects.get(webKey)?.body.equals(web!.body)).toBe(true);
  });

  it('leaves purge-requested, non-ready and foreign rows alone', async () => {
    const purged = await oversized({ purgeRequestedAt: new Date(), deletedAt: new Date() });
    await handle(purged.message, context());
    expect(store.objects.get(purged.webKey)?.body.length).toBe(CAP * 3);

    const processing = await oversized({ status: 'processing' });
    await handle(processing.message, context());
    expect(store.objects.get(processing.webKey)?.body.length).toBe(CAP * 3);

    const foreign = await oversized();
    const other = await createPhotographer(db);
    await handle(
      serializeQueueMessage('media', {
        kind: 'web.rerender',
        fileId: foreign.id,
        photographerId: other,
      }),
      context(),
    );
    expect(store.objects.get(foreign.webKey)?.body.length).toBe(CAP * 3);
    const [row] = await db.select().from(files).where(eq(files.id, foreign.id));
    expect(row?.webSizeBytes).toBe(CAP * 3);
  });
});
