import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bucketByFile,
  faceCollectionId,
  NoFaceDetectedError,
  prepareSelfie,
  searchBySelfies,
} from '@shotx/face';
import {
  FakeFaceProvider,
  MemoryTempImageStore,
  SyntheticSmallFaceDetector,
  SyntheticWorld,
} from '@shotx/face/testing';
import { loadFaceConfig } from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Dataset, loadDataset, readSelfies } from './dataset';
import { evaluate, type EvaluationResult, indexKey, type IndexOption } from './evaluate';
import { synthesize } from './synth';

const config = loadFaceConfig({});
const indexOption: IndexOption = { longEdge: 1600, qualityFilter: 'LOW', tiling: 'always' };
const searchOptions = [
  { selfies: 3, expansionSeeds: 2 },
  { selfies: 1, expansionSeeds: 0 },
];

let dir: string;
let dataset: Dataset;
let fake: FakeFaceProvider;
let result: EvaluationResult;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'face-eval-evaluate-'));
  await synthesize({
    out: join(dir, 'synthetic'),
    photos: 8,
    volunteers: 5,
    absent: 1,
    bystanders: 5,
    seed: 3,
    width: 1800,
    height: 1200,
  });
  dataset = await loadDataset(join(dir, 'synthetic'));
  const world = new SyntheticWorld(dataset.synthetic!.world);
  const tempStore = new MemoryTempImageStore();
  fake = new FakeFaceProvider(world, tempStore);
  result = await evaluate({
    dataset,
    provider: fake,
    tempStore,
    smallFaceDetector: new SyntheticSmallFaceDetector(world),
    config,
    indexOptions: [indexOption],
    searchOptions,
    sweepFloor: 70,
    minStrong: 80,
    collectionTag: 'eval-test',
    concurrency: 2,
    keepCollections: true,
    log: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('evaluate', () => {
  it('indexes every photo once per index option and scans every person per search option', () => {
    const stats = result.indexStats[indexKey(indexOption)]!;
    expect(stats.photos).toBe(8);
    expect(stats.failedPhotos).toBe(0);
    expect(stats.calls.indexFaces).toBe(8 * 5);
    expect(result.combos).toHaveLength(2);
    for (const combo of result.combos) expect(combo.scans).toHaveLength(5);
    // The comparison below only means something if expansion actually ran.
    expect(result.combos[0]!.scans.some((scan) => scan.seedSimilarities.length > 0)).toBe(true);
  });

  // The harness searches once at the sweep floor and applies thresholds offline. That must give
  // the same photos and the same number of calls as the production search at each threshold pair.
  it('matches the production search path at every threshold pair', async () => {
    const collectionId = faceCollectionId(`eval-test-${indexKey(indexOption)}`);
    const fileOf = new Map(
      fake.storedFaces(collectionId).map((f) => [f.faceId, f.externalImageId]),
    );
    let compared = 0;
    for (const combo of result.combos) {
      for (const scan of combo.scans) {
        const person = dataset.persons.find((p) => p.id === scan.personId)!;
        const raw = await readSelfies(dataset, person, combo.search.selfies);
        const selfies = await Promise.all(raw.map((b) => prepareSelfie(b, config)));
        for (const [strong, maybe] of [
          [80, 70],
          [88, 84],
          [92, 86],
          [95, 85],
        ] as const) {
          const thresholds = { strong, maybe };
          const production = await searchBySelfies(
            fake,
            selfies.map((s) => s.bytes),
            {
              collectionId,
              thresholds,
              expansionSeeds: combo.search.expansionSeeds,
              maxFaces: config.search.maxFaces,
              qualityFilter: config.search.qualityFilter,
            },
          ).catch((error: unknown) => {
            if (error instanceof NoFaceDetectedError) return { matches: [], seeds: 0 };
            throw error;
          });
          const hits = bucketByFile(production.matches, (id) => fileOf.get(id), thresholds);

          const seeds = scan.seedSimilarities.filter((s) => s >= strong).length;
          const files = scan.files[seeds]!;
          expect(seeds).toBe(production.seeds);
          expect(files.filter((f) => f.similarity >= maybe).map((f) => f.photoId)).toEqual(
            hits.map((h) => h.fileId),
          );
          expect(files.filter((f) => f.similarity >= strong).map((f) => f.photoId)).toEqual(
            hits.filter((h) => h.bucket === 'strong').map((h) => h.fileId),
          );
          compared += hits.length;
        }
      }
    }
    expect(compared).toBeGreaterThan(0);
  }, 60_000);
});
