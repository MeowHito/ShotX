import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFaceConfig } from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Dataset, loadDataset } from './dataset';
import {
  addPhotoImages,
  emptyEncodingStats,
  isDeployableSize,
  LEGACY_S3_MAX_BYTES,
  sizeKey,
  sizeLabel,
  surveyEncoding,
} from './encoding';
import { synthesize } from './synth';

describe('byte limits', () => {
  it('labels and keys limits', () => {
    expect(sizeLabel(5 * 1024 * 1024)).toBe('5 MiB');
    expect(sizeLabel(512 * 1024)).toBe('512 KiB');
    expect(sizeLabel(460_800)).toBe('450 KiB');
    expect(sizeLabel(460_801)).toBe('460801 bytes');
    expect(sizeKey(LEGACY_S3_MAX_BYTES)).toBe('15mib');
    expect(sizeKey(24 * 1024)).toBe('24kib');
    expect(sizeKey(460_801)).toBe('460801b');
  });

  it('deploys only limits that Image.Bytes takes', () => {
    expect(isDeployableSize(5_242_880)).toBe(true);
    expect(isDeployableSize(5_242_881)).toBe(false);
    expect(isDeployableSize(LEGACY_S3_MAX_BYTES)).toBe(false);
  });
});

describe('addPhotoImages', () => {
  it('counts degraded images, photos and full images', () => {
    const stats = emptyEncodingStats();
    addPhotoImages(
      stats,
      [
        { tile: null, bytes: 100, quality: 90, downscaled: false },
        { tile: 0, bytes: 50, quality: 80, downscaled: false },
      ],
      90,
    );
    addPhotoImages(stats, [{ tile: null, bytes: 70, quality: 60, downscaled: true }], 90);
    addPhotoImages(stats, [{ tile: null, bytes: 30, quality: 90, downscaled: false }], 90);
    expect(stats).toEqual({
      photos: 3,
      images: 4,
      tiles: 1,
      degradedImages: 2,
      degradedPhotos: 2,
      degradedFullImages: 1,
      downscaledImages: 1,
      minQuality: 60,
      totalBytes: 250,
      largestImageBytes: 100,
    });
  });
});

describe('surveyEncoding', () => {
  let dir: string;
  let dataset: Dataset;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'face-eval-encoding-'));
    await synthesize({
      out: join(dir, 'synthetic'),
      photos: 3,
      volunteers: 2,
      absent: 0,
      bystanders: 2,
      seed: 5,
      width: 1800,
      height: 1200,
    });
    dataset = await loadDataset(join(dir, 'synthetic'));
  }, 60_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts what each limit degrades without calling any provider', async () => {
    const base = loadFaceConfig({});
    // A floor small enough for the 24 KiB limit below.
    const config = { ...base, encode: { ...base.encode, minLongEdge: 64 } };
    const survey = await surveyEncoding({
      dataset,
      config,
      longEdges: [1600],
      sizes: [24 * 1024, 5 * 1024 * 1024, LEGACY_S3_MAX_BYTES],
      concurrency: 2,
      log: () => undefined,
    });
    expect(survey.photos).toBe(3);
    expect(survey.unlimitedFullBytes).toHaveLength(1);
    expect(survey.unlimitedFullBytes[0]!.max).toBeGreaterThan(24 * 1024);
    const [small, five, legacy] = survey.rows;
    expect(small).toMatchObject({ size: '24 KiB', deployable: true });
    expect(legacy).toMatchObject({ size: '15 MiB', deployable: false });
    for (const row of survey.rows) {
      expect(row.full).toMatchObject({ photos: 3, images: 3, tiles: 0 });
      expect(row.tiles).toMatchObject({ photos: 3, images: 12, tiles: 12 });
      expect(row.full.largestImageBytes).toBeLessThanOrEqual(row.maxBytes);
    }
    expect(small!.full.degradedFullImages).toBeGreaterThan(0);
    // Small synthetic photos: 15 MiB and 5 MiB send the same bytes.
    expect(five!.full).toEqual(legacy!.full);
    expect(five!.full.degradedImages).toBe(0);
  }, 60_000);
});
