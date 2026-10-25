import { type Env, loadFaceConfig } from '@shotx/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  indexPhoto,
  type IndexPhotoDeps,
  IndexPhotoError,
  indexPhotoOptions,
  type IndexPhotoTarget,
  type IndexTempKey,
  TempImageCleanupError,
  type TilingMode,
} from './index-photo';
import { IndexFacesOutcomeUnknownError } from './provider';
import { reconcileCollection } from './reconcile';
import {
  FakeFaceProvider,
  MemoryTempImageStore,
  renderScene,
  type Scene,
  SyntheticSmallFaceDetector,
  SyntheticWorld,
} from './testing';
import type { Clock } from './throttling';
import type { ImageInput } from './types';

const world = SyntheticWorld.create({ volunteers: 4, bystanders: 2, seed: 11 });
const [v1, v2, v3] = world.persons.map((person) => person.id) as [string, string, string];

// 3000×2000 with a 2×2 grid and 15% overlap: tile 0 spans x 0–1622 and tile 1 spans x 1378–3000.
// Rekognition-like detection needs about 68 px in the full image but only 40 px in a tile.
const scene: Scene = {
  width: 3000,
  height: 2000,
  faces: [
    { personId: v1, pose: 'front', left: 300, top: 300, size: 400 },
    { personId: v2, pose: 'front', left: 600, top: 1400, size: 55 },
    // Inside both tiles, 4.4% of a tile width from tile 0's inner edge.
    { personId: v3, pose: 'left', left: 1500, top: 1500, size: 50 },
  ],
};

/** The key format contracts is adding to packages/shared. */
const tempKey: IndexTempKey = ({ fileId, attemptId, part }) =>
  `tmp/index/${fileId}/${attemptId}/${part}.jpg`;

let photo: Buffer;
beforeAll(async () => {
  photo = await renderScene(world, scene, 1);
});

async function setup() {
  const tempStore = new MemoryTempImageStore();
  const fake = new FakeFaceProvider(world, tempStore);
  await fake.createCollection('pg-test');
  const deps: IndexPhotoDeps = {
    provider: fake,
    tempStore,
    tempKey,
    smallFaceDetector: new SyntheticSmallFaceDetector(world),
  };
  return { fake, tempStore, deps };
}

function options(target: Partial<IndexPhotoTarget> & { tiling: TilingMode }, env: Env = {}) {
  return indexPhotoOptions(loadFaceConfig(env), {
    collectionId: 'pg-test',
    fileId: 'file-1',
    ...target,
  });
}

async function run(tiling: TilingMode, env: Env = {}) {
  const { fake, tempStore, deps } = await setup();
  const result = await indexPhoto(deps, photo, options({ tiling }, env));
  return { result, fake, tempStore };
}

function manualClock(): Clock {
  let time = 0;
  return {
    now: () => time,
    sleep: (ms) => {
      time += ms;
      return Promise.resolve();
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<IndexPhotoError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(IndexPhotoError);
  return error as IndexPhotoError;
}

describe('indexPhoto', () => {
  it('indexes only the full image without tiling', async () => {
    const { result, fake, tempStore } = await run('never');
    expect(result.tiled).toBe(false);
    expect(result.indexCalls).toBe(1);
    expect(result.faces.map((face) => face.tile)).toEqual([null]);
    expect(fake.storedFaces('pg-test').map((face) => face.personId)).toEqual([v1]);
    expect(tempStore.keys()).toEqual([]);
  });

  it('tiles when the local detector sees small faces and finds them', async () => {
    const { result, fake } = await run('signal');
    expect(result.signal.localDetector).toBe(true);
    expect(result.tiled).toBe(true);
    expect(result.indexCalls).toBe(5);
    const persons = new Set(fake.storedFaces('pg-test').map((face) => face.personId));
    expect(persons).toEqual(new Set([v1, v2, v3]));
    expect(result.faceCount).toBe(3);
    for (const face of result.faces) {
      expect(face.bbox.left).toBeGreaterThanOrEqual(0);
      expect(face.bbox.left + face.bbox.width).toBeLessThanOrEqual(1);
    }
  });

  it('discards tile faces near inner edges using the configured epsilon', async () => {
    const narrow = await run('always', { FACE_TILE_EDGE_EPSILON: '0.01' });
    const wide = await run('always', { FACE_TILE_EDGE_EPSILON: '0.05' });
    expect(wide.result.discardedFaces).toBeGreaterThan(narrow.result.discardedFaces);
    expect(wide.result.faces.length).toBeLessThan(narrow.result.faces.length);
    // Discarded faces are deleted from the collection again.
    expect(wide.fake.storedFaces('pg-test')).toHaveLength(wide.result.faces.length);
  });

  it('takes the index settings from FaceConfig', () => {
    const indexOptions = indexPhotoOptions(
      loadFaceConfig({ FACE_INDEX_LONG_EDGE: '2400', FACE_INDEX_QUALITY_FILTER: 'MEDIUM' }),
      { collectionId: 'pg-1', fileId: 'f', tiling: 'signal' },
    );
    expect(indexOptions).toMatchObject({
      longEdge: 2400,
      qualityFilter: 'MEDIUM',
      tileEdgeEpsilon: 0.01,
      encode: { qualityStep: 5, minQuality: 60, shrinkFactor: 0.85, minLongEdge: 320 },
    });
  });
});

describe('indexPhoto temporary images', () => {
  it('builds every key with the injected function and a fresh attempt id', async () => {
    const { tempStore, deps } = await setup();
    const ids = ['attempt-a', 'attempt-b'];
    const pinned = { ...deps, newAttemptId: () => ids.shift()! };
    const first = await indexPhoto(pinned, photo, options({ tiling: 'always' }));
    const second = await indexPhoto(pinned, photo, options({ tiling: 'never' }));
    expect(first.attemptId).toBe('attempt-a');
    expect(second.attemptId).toBe('attempt-b');
    expect(tempStore.putKeys).toEqual([
      'tmp/index/file-1/attempt-a/full.jpg',
      'tmp/index/file-1/attempt-a/t0.jpg',
      'tmp/index/file-1/attempt-a/t1.jpg',
      'tmp/index/file-1/attempt-a/t2.jpg',
      'tmp/index/file-1/attempt-a/t3.jpg',
      'tmp/index/file-1/attempt-b/full.jpg',
    ]);
    expect(tempStore.keys()).toEqual([]);
  });

  it('uses a different attempt id for every call by default', async () => {
    const { deps } = await setup();
    const results = await Promise.all(
      Array.from({ length: 3 }, () => indexPhoto(deps, photo, options({ tiling: 'never' }))),
    );
    expect(new Set(results.map((r) => r.attemptId)).size).toBe(3);
  });

  // Before attempt ids, both attempts used tmp/index/file-1.jpg, and whichever finished first
  // deleted the image the other one was still indexing.
  it('keeps concurrent attempts for one file apart', async () => {
    const { deps } = await setup();
    const store = new MemoryTempImageStore();
    const provider = new FakeFaceProvider(world, store);
    await provider.createCollection('pg-test');
    // Hold every put until both attempts have stored their full image, so they overlap.
    let release!: () => void;
    const bothStored = new Promise<void>((resolve) => (release = resolve));
    const overlapping = {
      maxBytes: store.maxBytes,
      put: async (key: string, bytes: Uint8Array): Promise<ImageInput> => {
        const image = await store.put(key, bytes);
        if (store.keys().length >= 2) release();
        await bothStored;
        return image;
      },
      delete: (key: string) => store.delete(key),
    };
    const results = await Promise.all(
      [0, 1].map(() =>
        indexPhoto(
          { ...deps, provider, tempStore: overlapping },
          photo,
          options({ tiling: 'always' }),
        ),
      ),
    );
    const [a, b] = results.map((r) => r.attemptId);
    expect(a).not.toBe(b);
    expect(new Set(store.putKeys).size).toBe(store.putKeys.length);
    expect(store.putKeys.filter((key) => key.endsWith('/full.jpg'))).toHaveLength(2);
    expect(store.keys()).toEqual([]);
    // Both attempts indexed every image they stored.
    expect(provider.calls.indexFaces).toBe(10);
  });

  it('refuses a key function that ignores the attempt id', async () => {
    const { deps, fake } = await setup();
    const shared: IndexTempKey = ({ fileId, part }) => `tmp/index/${fileId}-${part}.jpg`;
    const error = await failure(
      indexPhoto({ ...deps, tempKey: shared }, photo, options({ tiling: 'never' })),
    );
    expect(String(error.cause)).toMatch(/tempKey must give every attempt and part its own key/);
    expect(fake.calls.indexFaces).toBe(0);
  });

  it('fails the attempt and deletes its faces when a temporary image cannot be deleted', async () => {
    const { fake, tempStore, deps } = await setup();
    const s3Down = new Error('S3 DeleteObject failed');
    tempStore.failNext('delete', s3Down);
    const error = await failure(indexPhoto(deps, photo, options({ tiling: 'never' })));
    expect(error.cause).toBeInstanceOf(TempImageCleanupError);
    expect((error.cause as TempImageCleanupError).key).toBe(
      `tmp/index/file-1/${error.attemptId}/full.jpg`,
    );
    expect((error.cause as TempImageCleanupError).cause).toBe(s3Down);
    expect(fake.storedFaces('pg-test')).toEqual([]);
    expect(error.orphanFaceIds).toEqual([]);
    expect(error.leftFaces).toBe(false);
  });

  it('reports a failed temporary image delete next to the error that failed the attempt', async () => {
    const { fake, tempStore, deps } = await setup();
    const invalid = Object.assign(new Error('Invalid image'), {
      name: 'InvalidImageFormatException',
    });
    fake.failNext('indexFaces', invalid);
    tempStore.failNext('delete', new Error('S3 DeleteObject failed'));
    const error = await failure(indexPhoto(deps, photo, options({ tiling: 'never' })));
    expect(error.cause).toBe(invalid);
    expect(error.cleanupErrors).toHaveLength(1);
    expect(error.cleanupErrors[0]).toBeInstanceOf(TempImageCleanupError);
  });

  it('still deletes the temporary image after a failed put, which may have stored it', async () => {
    const { tempStore, deps } = await setup();
    tempStore.failNext('put', new Error('S3 PutObject timed out'));
    const error = await failure(indexPhoto(deps, photo, options({ tiling: 'never' })));
    expect((error.cause as Error).message).toBe('S3 PutObject timed out');
    expect(tempStore.deleteKeys).toEqual(tempStore.putKeys);
  });
});

describe('indexPhoto failures', () => {
  it('deletes the faces of a failed attempt', async () => {
    const { fake, tempStore, deps } = await setup();
    const internal = Object.assign(new Error('boom'), { name: 'AccessDeniedException' });
    // The full image and tile 0 succeed, tile 1 fails.
    fake.failNext('indexFaces', internal, { after: 2 });
    const error = await failure(indexPhoto(deps, photo, options({ tiling: 'always' })));
    expect(error.cause).toBe(internal);
    expect(error).toMatchObject({
      collectionId: 'pg-test',
      fileId: 'file-1',
      orphanFaceIds: [],
      untrackedFacesPossible: false,
      cleanupErrors: [],
      leftFaces: false,
    });
    expect(fake.storedFaces('pg-test')).toEqual([]);
    expect(tempStore.keys()).toEqual([]);
  });

  it('reports the faces it could not delete instead of hiding the failure', async () => {
    const { fake, deps } = await setup();
    const internal = Object.assign(new Error('boom'), { name: 'AccessDeniedException' });
    const deleteDown = Object.assign(new Error('DeleteFaces failed'), {
      name: 'InternalServerError',
    });
    fake.failNext('indexFaces', internal, { after: 2 });
    fake.failNext('deleteFaces', deleteDown);
    const error = await failure(indexPhoto(deps, photo, options({ tiling: 'always' })));
    expect(error.cause).toBe(internal);
    expect(error.cleanupErrors).toEqual([deleteDown]);
    expect(error.leftFaces).toBe(true);
    expect(error.message).toContain('indexed faces that could not be deleted');
    // Exactly the faces left in the collection, so the worker can record and delete them later.
    const stored = fake.storedFaces('pg-test').map((face) => face.faceId);
    expect(stored.length).toBeGreaterThan(0);
    expect([...error.orphanFaceIds].sort()).toEqual([...stored].sort());
    await fake.deleteFaces('pg-test', error.orphanFaceIds);
    expect(fake.storedFaces('pg-test')).toEqual([]);
  });

  it('reports orphans when deleting discarded tile faces fails and cleanup fails too', async () => {
    const { fake, deps } = await setup();
    fake.failNext('deleteFaces', new Error('DeleteFaces failed'), { times: 2 });
    const error = await failure(
      indexPhoto(deps, photo, options({ tiling: 'always' }, { FACE_TILE_EDGE_EPSILON: '0.05' })),
    );
    const stored = fake.storedFaces('pg-test').map((face) => face.faceId);
    expect([...error.orphanFaceIds].sort()).toEqual([...stored].sort());
  });

  it('flags faces IndexFaces may have indexed without returning them', async () => {
    const { fake, deps } = await setup();
    const lost = new IndexFacesOutcomeUnknownError(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );
    // Tile 0 is indexed, but the response never arrives.
    fake.failNext('indexFaces', { error: lost, afterEffect: true }, { after: 1 });
    const error = await failure(indexPhoto(deps, photo, options({ tiling: 'always' })));
    expect(error.cause).toBe(lost);
    expect(error.untrackedFacesPossible).toBe(true);
    expect(error.orphanFaceIds).toEqual([]);
    expect(error.leftFaces).toBe(true);
    // The faces it did learn about were deleted; the lost ones are still there, and only
    // reconciliation can find them.
    const left = fake.storedFaces('pg-test');
    expect(left.length).toBeGreaterThan(0);
    expect(left.every((face) => face.externalImageId === 'file-1')).toBe(true);

    const result = await reconcileCollection(fake, {
      collectionId: 'pg-test',
      knownFaceIds: () => Promise.resolve([]),
      graceMs: 60_000,
      clock: manualClock(),
    });
    expect(result.deleted).toBe(left.length);
    expect(fake.storedFaces('pg-test')).toEqual([]);
  });

  it('wraps failures before any indexing too', async () => {
    const { fake, deps } = await setup();
    const error = await failure(
      indexPhoto(deps, new Uint8Array([1, 2, 3]), options({ tiling: 'never' })),
    );
    expect((error.cause as Error).name).toBe('UnreadableImageError');
    expect(error.leftFaces).toBe(false);
    expect(fake.calls.indexFaces).toBe(0);
  });
});

describe('indexPhoto re-indexing', () => {
  it('deletes the previous faces before indexing again', async () => {
    const { fake, deps } = await setup();
    const first = await indexPhoto(deps, photo, options({ tiling: 'signal' }));
    const previousFaceIds = first.faces.map((face) => face.faceId);
    const second = await indexPhoto(deps, photo, options({ tiling: 'never', previousFaceIds }));
    expect(second.replacedFaces).toBe(previousFaceIds.length);
    const stored = fake.storedFaces('pg-test').map((face) => face.faceId);
    expect(stored).toEqual(second.faces.map((face) => face.faceId));
    expect(stored.some((id) => previousFaceIds.includes(id))).toBe(false);
  });

  it('indexes nothing when the previous faces cannot be deleted', async () => {
    const { fake, deps } = await setup();
    const first = await indexPhoto(deps, photo, options({ tiling: 'never' }));
    const previousFaceIds = first.faces.map((face) => face.faceId);
    const calls = fake.calls.indexFaces;
    fake.failNext('deleteFaces', new Error('DeleteFaces failed'));
    const error = await failure(
      indexPhoto(deps, photo, options({ tiling: 'never', previousFaceIds })),
    );
    expect(error.leftFaces).toBe(false);
    expect(fake.calls.indexFaces).toBe(calls);
    // The rows still track every face in the collection.
    expect(fake.storedFaces('pg-test').map((face) => face.faceId)).toEqual(previousFaceIds);
  });
});
