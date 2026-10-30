import { randomUUID } from 'node:crypto';
import { faces } from '@shotx/db';
import {
  faceCollectionId,
  type FaceEngine,
  l2Normalize,
  PgFaceVectorStore,
  searchBySelfies,
  SelfHostedFaceProvider,
} from '@shotx/face';
import { loadFaceConfig, serializeQueueMessage } from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JobContext } from '../jobs/context';
import { runFacesReconcile } from '../jobs/faces-reconcile';
import { S3OrphanScanStore } from '../jobs/orphan-scans';
import { silentLogger } from '../logger';
import {
  createFileRow,
  createFolder,
  createPhotographer,
  fileById,
  openTestDatabase,
  type TestDatabase,
} from '../testing/database';
import { testJobQueues } from '../testing/jobs';
import { MemoryObjectStore, MemoryQueueClient } from '../testing/memory-aws';
import { CollectionRegistry, type FacesDeps } from './deps';
import { createFacesHandler } from './handler';

const DIMS = 128;
const GRACE = 3 * 3_600_000;
const box = { left: 0.1, top: 0.1, width: 0.2, height: 0.2 };

/** A person's embedding: a unit vector along `axis` (people are orthogonal, so never confused). */
const person = (axis: number) =>
  l2Normalize(
    Float32Array.from({ length: DIMS }, (_, i) => (i === axis ? 1 : i === 100 ? 0.1 : 0)),
  );

/**
 * The ONNX engine replaced by fixed answers: every photo shows persons 1 and 2, every selfie is
 * person 1. The provider, the pgvector store and the migrations are the real ones.
 */
const engine: FaceEngine = {
  model: 'sface-2021dec',
  dimensions: DIMS,
  analyze: () =>
    Promise.resolve({
      faces: [
        { bbox: box, confidence: 99, embedding: person(1) },
        { bbox: { ...box, left: 0.6 }, confidence: 97, embedding: person(2) },
      ],
      unindexed: [],
    }),
  embedLargest: () => Promise.resolve(person(1)),
};

describe('faces consumer with the self-hosted provider (ADR 0009)', () => {
  let database: TestDatabase;
  let provider: SelfHostedFaceProvider;
  const store = new MemoryObjectStore();
  const queues = new MemoryQueueClient();
  const face = loadFaceConfig({ FACE_INDEX_TILING: 'never' });

  beforeAll(async () => {
    database = await openTestDatabase();
    provider = new SelfHostedFaceProvider({
      engine,
      store: new PgFaceVectorStore(database.pool, face.selfHosted.hnsw),
    });
  });
  afterAll(() => database.close());

  function deps(): FacesDeps {
    return {
      db: database.db,
      store,
      queues,
      facesQueueUrl: 'faces',
      provider,
      collections: new CollectionRegistry(provider),
      face,
      features: { faceSearch: true },
      retention: { faceIndexExpiryDays: 90 },
      batchSize: 10,
      maxProcessingMs: 3_600_000,
      now: Date.now,
    };
  }

  it('indexes into face_vectors, finds the photo by selfie, and reconciles orphans', async () => {
    const { db } = database;
    const ownerId = await createPhotographer(db);
    const folder = await createFolder(db, ownerId, {
      faceIndexEnabled: true,
      faceIndexExpiresAt: new Date(Date.now() + 86_400_000),
    });
    const file = await createFileRow(db, ownerId, {
      originalName: `p-${randomUUID()}.jpg`,
      mime: 'image/jpeg',
      sizeBytes: 3,
      status: 'ready',
      verifiedAt: new Date(),
      folderId: folder.id,
    });
    // indexPhoto re-encodes the original, so it must be a real image.
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 640, height: 480, channels: 3, background: '#808080' },
    })
      .jpeg()
      .toBuffer();
    store.seed(file.s3Key, jpeg, 'image/jpeg');

    await createFacesHandler(deps())(
      serializeQueueMessage('faces', { type: 'index.file', fileId: file.id }),
      { messageId: 'm', receiveCount: 1, signal: new AbortController().signal, log: silentLogger },
    );

    const rows = await db.select().from(faces).where(eq(faces.fileId, file.id));
    expect(rows).toHaveLength(2);
    expect((await fileById(db, file.id))?.faceCount).toBe(2);
    const collectionId = faceCollectionId(ownerId);
    const listed = await provider.listFaces({ collectionId, maxResults: 100 });
    expect(new Set(listed.faces.map((f) => f.faceId))).toEqual(
      new Set(rows.map((r) => r.rekognitionFaceId)),
    );

    const { matches } = await searchBySelfies(provider, [Uint8Array.of(1)], {
      collectionId,
      thresholds: face.thresholds,
      expansionSeeds: face.search.expansionSeeds,
      maxFaces: face.search.maxFaces,
      qualityFilter: face.search.qualityFilter,
    });
    expect(matches.map((m) => m.externalImageId)).toEqual([file.id]);
    expect(matches[0]!.similarity).toBeCloseTo(100, 3);

    // A vector no `faces` row tracks (a worker that died before its commit) is an orphan.
    const orphan = await provider.indexFaces({
      collectionId,
      image: { bytes: Uint8Array.of(1) },
      externalImageId: file.id,
      maxFaces: 1,
      qualityFilter: 'AUTO',
    });
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
    const t0 = Date.now();
    await runFacesReconcile(job(t0), { provider, scans, graceMs: GRACE });
    const result = await runFacesReconcile(job(t0 + GRACE + 1), {
      provider,
      scans,
      graceMs: GRACE,
    });
    expect(result.orphansDeleted).toBe(orphan.faces.length);
    const after = await provider.listFaces({ collectionId, maxResults: 100 });
    expect(after.faces).toHaveLength(2);
  });
});
