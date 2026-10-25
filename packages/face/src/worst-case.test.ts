import { loadFaceConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { recordFacesDeadline } from './reconcile';
import { rekognitionRetryOptions } from './rekognition-provider';
import { withRetry } from './throttling';
import { indexPhotoWorstCase, rekognitionCallWorstCase } from './worst-case';

const defaults = loadFaceConfig({});

describe('rekognitionCallWorstCase', () => {
  it('adds every attempt’s rate-limit wait and request timeout to the backoff caps', () => {
    // 8 × (30 000 + 10 000) + (200 + 400 + 800 + 1600 + 3200 + 6400 + 10 000)
    expect(rekognitionCallWorstCase(defaults.rekognition, 'background')).toEqual({
      attempts: 8,
      rateLimitWaitMs: 30_000,
      requestTimeoutMs: 10_000,
      backoffMs: 22_600,
      totalMs: 342_600,
    });
    // 3 × (2000 + 10 000) + (100 + 200)
    expect(rekognitionCallWorstCase(defaults.rekognition, 'interactive').totalMs).toBe(36_300);
  });

  it('follows the request timeout from FaceConfig', () => {
    const config = loadFaceConfig({ FACE_REKOGNITION_REQUEST_TIMEOUT_MS: '2000' });
    expect(rekognitionCallWorstCase(config.rekognition, 'background').totalMs).toBe(
      8 * (30_000 + 2000) + 22_600,
    );
  });

  it('bounds the backoff withRetry actually sleeps', async () => {
    const retry = rekognitionRetryOptions(defaults.rekognition, 'background');
    const sleeps: number[] = [];
    await withRetry(
      () => Promise.reject(new Error('throttled')),
      () => true,
      {
        ...retry,
        random: () => 1 - Number.EPSILON,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    ).catch(() => undefined);
    const { backoffMs } = rekognitionCallWorstCase(defaults.rekognition, 'background');
    const slept = sleeps.reduce((a, b) => a + b, 0);
    expect(sleeps).toHaveLength(retry.maxAttempts - 1);
    expect(slept).toBeLessThanOrEqual(backoffMs);
    expect(slept).toBeGreaterThanOrEqual(backoffMs - sleeps.length);
  });
});

describe('indexPhotoWorstCase', () => {
  it('counts 1 + grid² IndexFaces and the DeleteFaces batches of one attempt', () => {
    expect(indexPhotoWorstCase(defaults)).toEqual({
      perCallMs: 342_600,
      indexFacesCalls: 5,
      deleteFacesCalls: 2,
      totalCalls: 7,
      rekognitionMs: 2_398_200,
      minOrphanGraceMs: 4_796_400,
    });
    // Re-indexing deletes previousFaceIds first: one more batch.
    expect(indexPhotoWorstCase(defaults, { previousFaces: 500 })).toMatchObject({
      deleteFacesCalls: 3,
      totalCalls: 8,
      rekognitionMs: 2_740_800,
      minOrphanGraceMs: 5_481_600,
    });
  });

  it('puts the record deadline of the minimum grace at the end of the worst attempt', () => {
    const worst = indexPhotoWorstCase(defaults, { previousFaces: 500 });
    expect(recordFacesDeadline(0, worst.minOrphanGraceMs)).toBe(worst.rekognitionMs);
  });

  it('follows the tile grid and face limit', () => {
    const config = loadFaceConfig({ FACE_TILE_GRID: '3', FACE_INDEX_MAX_FACES: '100' });
    expect(indexPhotoWorstCase(config)).toMatchObject({ indexFacesCalls: 10, deleteFacesCalls: 2 });
  });
});
