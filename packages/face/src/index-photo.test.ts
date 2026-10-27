import { type Env, loadFaceConfig } from '@shotx/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  indexPhoto,
  type IndexPhotoDeps,
  IndexPhotoError,
  indexPhotoOptions,
  type IndexPhotoTarget,
  TILING_MODES,
  type TilingMode,
} from './index-photo';
import {
  type FaceProvider,
  ImageTooLargeError,
  IndexFacesOutcomeUnknownError,
  type IndexFacesRequest,
  REKOGNITION_INLINE_MAX_BYTES,
} from './provider';
import { reconcileCollection } from './reconcile';
import {
  FakeFaceProvider,
  renderScene,
  type Scene,
  SyntheticSmallFaceDetector,
  SyntheticWorld,
} from './testing';
import type { Clock } from './throttling';

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

let photo: Buffer;
beforeAll(async () => {
  photo = await renderScene(world, scene, 1);
});

/** Records every IndexFaces request the fake receives. */
function recording(fake: FakeFaceProvider): { provider: FaceProvider; sent: IndexFacesRequest[] } {
  const sent: IndexFacesRequest[] = [];
  const provider: FaceProvider = Object.create(fake) as FaceProvider;
  provider.indexFaces = (request) => {
    sent.push(request);
    return fake.indexFaces(request);
  };
  return { provider, sent };
}

async function setup() {
  const fake = new FakeFaceProvider(world);
  await fake.createCollection('pg-test');
  const { provider, sent } = recording(fake);
  const deps: IndexPhotoDeps = {
    provider,
    smallFaceDetector: new SyntheticSmallFaceDetector(world),
  };
  return { fake, sent, deps };
}

/** Options as the worker builds them, with the tiling mode set through FACE_INDEX_TILING. */
function options(
  { tiling, ...target }: Partial<IndexPhotoTarget> & { tiling: TilingMode },
  env: Env = {},
) {
  return indexPhotoOptions(loadFaceConfig({ ...env, FACE_INDEX_TILING: tiling }), {
    collectionId: 'pg-test',
    fileId: 'file-1',
    ...target,
  });
}

async function run(tiling: TilingMode, env: Env = {}) {
  const { fake, sent, deps } = await setup();
  const result = await indexPhoto(deps, photo, options({ tiling }, env));
  return { result, fake, sent };
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
    const { result, fake, sent } = await run('never');
    expect(result.tiled).toBe(false);
    expect(result.indexCalls).toBe(1);
    expect(sent).toHaveLength(1);
    expect(result.faces.map((face) => face.tile)).toEqual([null]);
    expect(fake.storedFaces('pg-test').map((face) => face.personId)).toEqual([v1]);
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
      { collectionId: 'pg-1', fileId: 'f' },
    );
    expect(indexOptions).toMatchObject({
      longEdge: 2400,
      qualityFilter: 'MEDIUM',
      tileEdgeEpsilon: 0.01,
      encode: { qualityStep: 5, minQuality: 60, shrinkFactor: 0.85, minLongEdge: 320 },
    });
  });
});

describe('indexPhotoOptions tiling', () => {
  it('takes the tiling mode from FACE_INDEX_TILING, signal by default', () => {
    const target = { collectionId: 'pg-1', fileId: 'f' };
    expect(indexPhotoOptions(loadFaceConfig({}), target).tiling).toBe('signal');
    for (const mode of TILING_MODES) {
      const config = loadFaceConfig({ FACE_INDEX_TILING: mode });
      expect(indexPhotoOptions(config, target).tiling).toBe(mode);
    }
  });

  it('has no per-photo tiling override', () => {
    const built = indexPhotoOptions(loadFaceConfig({ FACE_INDEX_TILING: 'never' }), {
      collectionId: 'pg-1',
      fileId: 'f',
      // @ts-expect-error tiling is not part of IndexPhotoTarget: it comes from FaceConfig.
      tiling: 'always',
    });
    expect(built.tiling).toBe('never');
  });

  it('tiles according to the configured mode', async () => {
    for (const [mode, tiled] of [
      ['never', false],
      ['signal', true],
      ['always', true],
    ] as const) {
      const { deps } = await setup();
      const config = loadFaceConfig({ FACE_INDEX_TILING: mode });
      const result = await indexPhoto(
        deps,
        photo,
        indexPhotoOptions(config, { collectionId: 'pg-test', fileId: 'file-1' }),
      );
      expect(result.tiled).toBe(tiled);
      expect(result.indexCalls).toBe(tiled ? 5 : 1);
    }
  });
});

describe('indexPhoto images', () => {
  it('sends the full image and every tile as bytes and reports how each was encoded', async () => {
    const { result, sent } = await run('always');
    expect(sent).toHaveLength(5);
    expect(result.images.map((image) => image.tile)).toEqual([null, 0, 1, 2, 3]);
    for (const [i, request] of sent.entries()) {
      expect(Object.keys(request.image)).toEqual(['bytes']);
      const image = result.images[i]!;
      expect(request.image.bytes.length).toBe(image.bytes);
      expect(image.bytes).toBeLessThanOrEqual(REKOGNITION_INLINE_MAX_BYTES);
      const meta = await sharp(request.image.bytes).metadata();
      expect(meta.format).toBe('jpeg');
      expect([meta.width, meta.height]).toEqual([image.width, image.height]);
      // A small synthetic photo fits at the configured quality and size.
      expect(image).toMatchObject({ quality: 90, downscaled: false });
    }
    // The full image keeps its size; tiles are about half of it plus the overlap.
    expect([result.images[0]!.width, result.images[0]!.height]).toEqual([3000, 2000]);
    expect(result.images[1]!.width).toBe(1622);
  });

  it('keeps every image under FACE_INDEX_MAX_BYTES', async () => {
    const maxBytes = 120_000;
    const { result, sent } = await run('always', {
      FACE_INDEX_MAX_BYTES: String(maxBytes),
      // FaceConfig refuses a limit the smallest size might not fit in.
      FACE_ENCODE_MIN_LONG_EDGE: '160',
    });
    expect(sent.every((request) => request.image.bytes.length <= maxBytes)).toBe(true);
    expect(result.images.every((image) => image.bytes <= maxBytes)).toBe(true);
    expect(result.images.some((image) => image.quality < 90 || image.downscaled)).toBe(true);
  });

  it('caps the limit at what the provider accepts', async () => {
    const { deps, sent } = await setup();
    const indexOptions = { ...options({ tiling: 'never' }), maxBytes: 50 * 1024 * 1024 };
    const result = await indexPhoto({ ...deps, maxImageBytes: 100_000 }, photo, indexOptions);
    expect(result.images[0]!.bytes).toBeLessThanOrEqual(100_000);
    expect(sent[0]!.image.bytes.length).toBeLessThanOrEqual(100_000);
  });

  it('lets the evaluation harness raise the provider limit, which the fake then enforces', async () => {
    const fake = new FakeFaceProvider(world, { maxImageBytes: 100_000 });
    await fake.createCollection('pg-test');
    const big = { ...options({ tiling: 'never' }), maxBytes: 150_000 };
    const error = await failure(indexPhoto({ provider: fake, maxImageBytes: 150_000 }, photo, big));
    expect(error.cause).toBeInstanceOf(ImageTooLargeError);
    expect(error.leftFaces).toBe(false);
  });

  it('builds a fresh attempt id for every call, or the injected one', async () => {
    const { deps } = await setup();
    const ids = ['attempt-a', 'attempt-b'];
    const pinned = { ...deps, newAttemptId: () => ids.shift()! };
    expect((await indexPhoto(pinned, photo, options({ tiling: 'never' }))).attemptId).toBe(
      'attempt-a',
    );
    expect((await indexPhoto(pinned, photo, options({ tiling: 'never' }))).attemptId).toBe(
      'attempt-b',
    );
    const results = await Promise.all(
      Array.from({ length: 3 }, () => indexPhoto(deps, photo, options({ tiling: 'never' }))),
    );
    expect(new Set(results.map((r) => r.attemptId)).size).toBe(3);
  });

  it('keeps concurrent attempts for one file apart', async () => {
    const { fake, deps } = await setup();
    const results = await Promise.all(
      [0, 1].map(() => indexPhoto(deps, photo, options({ tiling: 'always' }))),
    );
    expect(results[0]!.attemptId).not.toBe(results[1]!.attemptId);
    expect(fake.calls.indexFaces).toBe(10);
    const ids = results.flatMap((r) => r.faces.map((face) => face.faceId));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('indexPhoto failures', () => {
  it('deletes the faces of a failed attempt', async () => {
    const { fake, deps } = await setup();
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
