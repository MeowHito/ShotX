import { type Env, loadFaceConfig } from '@shotx/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { indexPhoto, indexPhotoOptions, type TilingMode } from './index-photo';
import {
  FakeFaceProvider,
  MemoryTempImageStore,
  renderScene,
  type Scene,
  SyntheticSmallFaceDetector,
  SyntheticWorld,
} from './testing';

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

async function run(tiling: TilingMode, env: Env = {}) {
  const tempStore = new MemoryTempImageStore();
  const fake = new FakeFaceProvider(world, tempStore);
  await fake.createCollection('pg-test');
  const options = indexPhotoOptions(loadFaceConfig(env), {
    collectionId: 'pg-test',
    fileId: 'file-1',
    tempKeyPrefix: 'tmp/index/',
    tiling,
  });
  const result = await indexPhoto(
    { provider: fake, tempStore, smallFaceDetector: new SyntheticSmallFaceDetector(world) },
    photo,
    options,
  );
  return { result, fake, tempStore };
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
    const options = indexPhotoOptions(
      loadFaceConfig({ FACE_INDEX_LONG_EDGE: '2400', FACE_INDEX_QUALITY_FILTER: 'MEDIUM' }),
      { collectionId: 'pg-1', fileId: 'f', tempKeyPrefix: 'tmp/index/', tiling: 'signal' },
    );
    expect(options).toMatchObject({
      longEdge: 2400,
      qualityFilter: 'MEDIUM',
      tileEdgeEpsilon: 0.01,
      encode: { qualityStep: 5, minQuality: 60, shrinkFactor: 0.85, minLongEdge: 320 },
    });
  });
});
