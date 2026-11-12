import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { loadDesignConfig, loadMediaConfig, serializeQueueMessage } from '@shotx/shared';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentLogger } from '../logger';
import { createMediaHandler } from '../media/handler';
import {
  createDesign,
  createDesignAsset,
  createPhotographer,
  designAssetById,
  openTestDatabase,
  type TestDatabase,
  usageOf,
} from '../testing/database';
import { MemoryQueueClient } from '../testing/memory-aws';
import { TEST_DESTINATIONS } from '../testing/jobs';
import { FakeFaceProvider, SyntheticWorld } from '@shotx/face/testing';
import { runDesignAssetPurge } from '../jobs/design-assets-purge';
import { S3ObjectStore } from './object-store';

/**
 * The design.asset job and the orphan purge against LocalStack (or any S3 endpoint):
 * AWS_ENDPOINT_URL=http://localhost:4566 with test credentials. Skipped without an endpoint, so
 * CI without LocalStack stays green.
 */
const endpoint = process.env.AWS_ENDPOINT_URL;

describe.skipIf(!endpoint)('design images against LocalStack (ADR 0013)', () => {
  const region = process.env.AWS_REGION ?? 'ap-southeast-1';
  const credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
  };
  const s3 = new S3Client({ region, endpoint, forcePathStyle: true, credentials });
  const bucket = `shotx-worker-design-${randomUUID().slice(0, 8)}`;
  const store = new S3ObjectStore(s3, bucket);
  let database: TestDatabase;

  beforeAll(async () => {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    database = await openTestDatabase();
  });
  afterAll(async () => {
    await database.close();
  });

  it('processes a PNG with alpha into web.webp, redelivery is a no-op, and the orphan purge deletes both objects', async () => {
    const { db } = database;
    const png = await sharp({
      create: { width: 300, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 45/1 0/1' } })
      .png()
      .toBuffer();
    const ownerId = await createPhotographer(db, { reservedBytes: png.length });
    const asset = await createDesignAsset(db, ownerId, { sizeBytes: png.length });
    await store.put(asset.originalKey, png, 'image/png');

    const handle = createMediaHandler({
      db,
      store,
      queues: new MemoryQueueClient(),
      bucket,
      facesQueueUrl: TEST_DESTINATIONS.faces,
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
      originalsStorageClass: 'STANDARD',
      partBytes: 16 * 1024 * 1024,
    });
    const body = serializeQueueMessage('media', {
      kind: 'design.asset',
      assetId: asset.id,
      photographerId: ownerId,
    });
    const context = {
      messageId: 'm',
      receiveCount: 1,
      signal: new AbortController().signal,
      log: silentLogger,
    };
    await handle(body, context);
    await handle(body, context);

    expect(await designAssetById(db, asset.id)).toMatchObject({
      status: 'ready',
      width: 300,
      height: 200,
    });
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: png.length, reservedBytes: 0 });
    const web = await store.get(asset.webKey);
    const meta = await sharp(web!).metadata();
    expect(meta).toMatchObject({ format: 'webp', hasAlpha: true });
    expect(meta.exif).toBeUndefined();

    // Unreferenced (a design that uses something else) and orphaned past the limit: purged.
    await createDesign(db, ownerId, { imageAssetIds: [randomUUID()] });
    const ctx = {
      db,
      store,
      queues: new MemoryQueueClient(),
      destinations: { ...TEST_DESTINATIONS },
      faces: new FakeFaceProvider(new SyntheticWorld({ persons: [], lookalikes: [] })),
      log: silentLogger,
      now: Date.now,
      batchSize: 10,
      deadline: Date.now() + 3_600_000,
      signal: new AbortController().signal,
    };
    await runDesignAssetPurge(ctx, 30); // marks it
    expect((await designAssetById(db, asset.id))?.orphanedAt).toBeInstanceOf(Date);
    await runDesignAssetPurge({ ...ctx, now: () => Date.now() + 31 * 86_400_000 }, 30);
    expect(await designAssetById(db, asset.id)).toBeUndefined();
    expect(await store.head(asset.originalKey)).toBeNull();
    expect(await store.head(asset.webKey)).toBeNull();
    expect(await usageOf(db, ownerId)).toEqual({ usedBytes: 0, reservedBytes: 0 });
  });
});
