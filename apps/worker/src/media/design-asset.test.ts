import { randomUUID } from 'node:crypto';
import { designAssets } from '@shotx/db';
import { loadDesignConfig, loadMediaConfig, serializeQueueMessage } from '@shotx/shared';
import { eq, sql } from 'drizzle-orm';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db';
import { memoryLogger, silentLogger } from '../logger';
import type { MessageContext } from '../sqs/consumer';
import {
  createDesignAsset,
  createPhotographer,
  designAssetById,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../testing/database';
import { cameraJpeg, pngBytes } from '../testing/fixtures';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import { createMediaHandler } from './handler';

const design = loadDesignConfig({}).asset;

function context(log = silentLogger): MessageContext {
  return { messageId: 'm-1', receiveCount: 1, signal: new AbortController().signal, log };
}

function body(assetId: string, photographerId: string): string {
  return serializeQueueMessage('media', { kind: 'design.asset', assetId, photographerId });
}

/**
 * A logo-like PNG wider than DESIGN_ASSET_LONG_EDGE: left half opaque red, right half fully
 * transparent, with EXIF (camera, GPS) and XMP attached.
 */
async function logoPng(width = 3000, height = 1500): Promise<Buffer> {
  const red = await sharp({
    create: { width: width / 2, height, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
  })
    .png()
    .toBuffer();
  return sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: red, left: 0, top: 0 }])
    .withExif({
      IFD0: { Make: 'TestCam' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 45/1 0/1' },
    })
    .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF/></x:xmpmeta>')
    .png()
    .toBuffer();
}

describe('design.asset (ADR 0013)', () => {
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
      media: loadMediaConfig({}),
      designAssets: design,
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

  /** A photographer with one completed (`processing`) design image whose bytes are stored. */
  async function asset(bytes: Uint8Array, options: { mime?: string; sizeBytes?: number } = {}) {
    const sizeBytes = options.sizeBytes ?? bytes.length;
    const ownerId = await createPhotographer(db, { reservedBytes: sizeBytes });
    const row = await createDesignAsset(db, ownerId, {
      mime: options.mime ?? 'image/png',
      sizeBytes,
    });
    store.seed(row.originalKey, bytes);
    return { ownerId, ...row, body: body(row.id, ownerId) };
  }

  it('writes web.webp with alpha kept and every metadata block stripped, and marks it ready', async () => {
    const png = await logoPng();
    const before = await sharp(png).metadata();
    // The fixture really carries what must go.
    expect(exifReader(before.exif!).GPSInfo?.GPSLatitude).toEqual([13, 45, 0]);
    expect(before.xmp).toBeDefined();
    const { ownerId, id, originalKey, webKey, body } = await asset(png);

    await handle(body, context());

    const row = await designAssetById(db, id);
    expect(row).toMatchObject({ status: 'ready', width: 2560, height: 1280 });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: png.length, reservedBytes: 0 });
    expect(store.objects.has(originalKey)).toBe(true);
    const web = store.objects.get(webKey);
    expect(web?.contentType).toBe('image/webp');
    const meta = await sharp(web!.body).metadata();
    expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual({
      format: 'webp',
      width: 2560,
      height: 1280,
    });
    expect(meta.hasAlpha).toBe(true);
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.iptc).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    // The transparent half stays transparent, the opaque half opaque.
    const { data, info } = await sharp(web!.body)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    expect(alphaAt(10, 10)).toBe(255);
    expect(alphaAt(info.width - 10, 10)).toBe(0);
  });

  it('applies EXIF orientation, fits the long edge and never enlarges', async () => {
    const jpeg = await cameraJpeg(); // stored 3000x2000, Orientation 6: displayed 2000x3000
    const rotated = await asset(jpeg, { mime: 'image/jpeg' });
    await handle(rotated.body, context());
    expect(await designAssetById(db, rotated.id)).toMatchObject({
      status: 'ready',
      width: 1707,
      height: 2560,
    });
    const meta = await sharp(store.objects.get(rotated.webKey)!.body).metadata();
    expect([meta.width, meta.height]).toEqual([1707, 2560]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation).toBeUndefined();

    const small = await asset(await pngBytes()); // 64x48
    await handle(small.body, context());
    expect(await designAssetById(db, small.id)).toMatchObject({ width: 64, height: 48 });
  });

  it('is idempotent: redelivery moves no bytes and writes nothing again', async () => {
    const png = await pngBytes();
    const { ownerId, id, body } = await asset(png);
    await handle(body, context());
    const puts = store.calls.put;
    const first = await designAssetById(db, id);
    await handle(body, context());
    await handle(body, context());
    expect(store.calls.put).toBe(puts);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: png.length, reservedBytes: 0 });
    expect(await designAssetById(db, id)).toEqual(first);
  });

  it('finishes an asset an earlier attempt verified but did not mark ready, without moving bytes again', async () => {
    const png = await pngBytes();
    const { ownerId, id, body } = await asset(png);
    await db.update(designAssets).set({ verifiedAt: new Date() }).where(eq(designAssets.id, id));
    await db.execute(
      sql`UPDATE storage_usage SET used_bytes = ${png.length}, reserved_bytes = 0 WHERE photographer_id = ${ownerId}`,
    );
    await handle(body, context());
    expect((await designAssetById(db, id))?.status).toBe('ready');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: png.length, reservedBytes: 0 });
  });

  it('rejects bytes whose magic number does not match: object deleted, failed, reservation released', async () => {
    const jpeg = await cameraJpeg({ width: 40, height: 20 });
    const { ownerId, id, originalKey, webKey, body } = await asset(jpeg, { mime: 'image/png' });
    await handle(body, context());
    expect(await designAssetById(db, id)).toMatchObject({ status: 'failed', verifiedAt: null });
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(originalKey)).toBe(false);
    expect(store.objects.has(webKey)).toBe(false);

    // Redelivery releases nothing more and deletes a leftover object again.
    store.seed(originalKey, jpeg);
    await handle(body, context());
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(originalKey)).toBe(false);
    expect(store.calls.put).toBe(0);
  });

  it('rejects an SVG or script declared as an image, a missing object and a size mismatch', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>x</script></svg>');
    const script = await asset(svg, { mime: 'image/png' });
    await handle(script.body, context());
    expect((await designAssetById(db, script.id))?.status).toBe('failed');
    expect(await usageOf(db, script.ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });

    const png = await pngBytes();
    const missing = await asset(png);
    store.objects.delete(missing.originalKey);
    await handle(missing.body, context());
    expect((await designAssetById(db, missing.id))?.status).toBe('failed');
    expect(await usageOf(db, missing.ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });

    const wrongSize = await asset(png, { sizeBytes: png.length + 1 });
    await handle(wrongSize.body, context());
    expect((await designAssetById(db, wrongSize.id))?.status).toBe('failed');
    expect(await usageOf(db, wrongSize.ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(wrongSize.originalKey)).toBe(false);
  });

  it('fails an image that does not decode after verifying it (bytes stay used)', async () => {
    const png = await pngBytes();
    const truncated = png.subarray(0, 80); // the PNG signature, then garbage
    const { ownerId, id, originalKey, body } = await asset(truncated);
    await handle(body, context());
    const row = await designAssetById(db, id);
    expect(row).toMatchObject({ status: 'failed' });
    expect(row?.verifiedAt).toBeInstanceOf(Date);
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: truncated.length, reservedBytes: 0 });
    // Kept for the orphan purge, which deletes it with the row.
    expect(store.objects.has(originalKey)).toBe(true);
    await handle(body, context());
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: truncated.length, reservedBytes: 0 });
  });

  it('rejects bytes replaced with another format after the magic-byte check (re-PUT), releasing them', async () => {
    const png = await pngBytes();
    const gif = await sharp({
      create: { width: 64, height: 48, channels: 3, background: '#00ff00' },
    })
      .gif()
      .toBuffer();
    // Same length, so HeadObject and the download size can't tell them apart.
    const size = Math.max(png.length, gif.length);
    const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(size - b.length)]);
    const { ownerId, id, originalKey, webKey, body } = await asset(pad(png));
    // The photographer re-PUTs with the still-valid URL between the verify and the render.
    const download = store.download.bind(store);
    store.download = async (key: string, path: string) => {
      store.seed(key, pad(gif));
      return download(key, path);
    };
    const log = memoryLogger();
    await handle(body, context(log));

    expect(await designAssetById(db, id)).toMatchObject({ status: 'failed', verifiedAt: null });
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(originalKey)).toBe(false);
    expect(store.objects.has(webKey)).toBe(false);
    expect(log.entries.find((e) => e.msg === 'rejected design asset')?.fields).toMatchObject({
      reason: 'FORMAT_MISMATCH',
      format: 'gif',
    });

    // Redelivery: nothing moves again.
    store.download = download;
    await handle(body, context());
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.calls.put).toBe(0);
  });

  it('checks the format on redelivery of a verified asset too, and deletes a web.webp left behind', async () => {
    // An earlier attempt verified a PNG, wrote web.webp and crashed; the bytes are now a TIFF.
    const tiff = await sharp({
      create: { width: 32, height: 32, channels: 3, background: '#0000ff' },
    })
      .tiff()
      .toBuffer();
    const ownerId = await createPhotographer(db, { usedBytes: tiff.length });
    const row = await createDesignAsset(db, ownerId, {
      sizeBytes: tiff.length,
      verifiedAt: new Date(),
    });
    store.seed(row.originalKey, tiff);
    store.seed(row.webKey, new Uint8Array(10), 'image/webp');
    await handle(body(row.id, ownerId), context());
    expect(await designAssetById(db, row.id)).toMatchObject({ status: 'failed', verifiedAt: null });
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
    expect(store.objects.has(row.originalKey)).toBe(false);
    expect(store.objects.has(row.webKey)).toBe(false);
  });

  it('does nothing for purge-requested, uploading, missing and foreign rows', async () => {
    const png = await pngBytes();
    const purged = await asset(png);
    await db
      .update(designAssets)
      .set({ purgeRequestedAt: new Date() })
      .where(eq(designAssets.id, purged.id));
    await handle(purged.body, context());
    expect(store.objects.has(purged.webKey)).toBe(false);
    expect(await usageOf(db, purged.ownerId)).toEqual({ usedBytes: 0, reservedBytes: png.length });

    const ownerId = await createPhotographer(db, { reservedBytes: png.length });
    const uploading = await createDesignAsset(db, ownerId, {
      status: 'uploading',
      sizeBytes: png.length,
    });
    await handle(body(uploading.id, ownerId), context());
    expect((await designAssetById(db, uploading.id))?.status).toBe('uploading');
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: png.length });

    await handle(body(randomUUID(), ownerId), context());

    const foreign = await asset(png);
    const log = memoryLogger();
    await handle(body(foreign.id, ownerId), context(log));
    expect((await designAssetById(db, foreign.id))?.status).toBe('processing');
    expect(log.entries.some((e) => e.level === 'error')).toBe(true);
    expect(store.calls.put).toBe(0);
  });

  it('cleans up web.webp when the purge takes the asset while it renders', async () => {
    const png = await pngBytes();
    const { id, originalKey, webKey, body } = await asset(png);
    // The orphan purge requests and deletes the objects while the worker renders.
    const put = store.put.bind(store);
    store.put = async (key, bytes, contentType) => {
      await db
        .update(designAssets)
        .set({ purgeRequestedAt: new Date() })
        .where(eq(designAssets.id, id));
      store.objects.delete(originalKey);
      await put(key, bytes, contentType);
    };
    await handle(body, context());
    expect((await designAssetById(db, id))?.status).toBe('processing');
    expect(store.objects.has(webKey)).toBe(false);
    expect(store.objects.has(originalKey)).toBe(false);
  });

  it('never logs object keys', async () => {
    const png = await pngBytes();
    const { originalKey, webKey, body } = await asset(png);
    const log = memoryLogger();
    await handle(body, context(log));
    const text = JSON.stringify(log.entries);
    expect(text).not.toContain(originalKey);
    expect(text).not.toContain(webKey);
    expect(log.entries.find((e) => e.msg === 'design asset processed')?.fields).toMatchObject({
      outcome: 'ready',
    });
  });
});
