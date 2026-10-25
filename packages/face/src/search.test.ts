import { describe, expect, it, vi } from 'vitest';
import { loadFaceConfig } from '@shotx/shared';
import {
  type FaceProvider,
  NoFaceDetectedError,
  type SearchByFaceRequest,
  type SearchByImageRequest,
} from './provider';
import {
  bucketByFile,
  combineMatches,
  mergeMatches,
  searchBySelfies,
  selectSeeds,
  selfieSearchOptions,
  type SourcedMatch,
} from './search';
import type { FaceMatch } from './types';

const match = (faceId: string, similarity: number, file = `file-${faceId}`): FaceMatch => ({
  faceId,
  similarity,
  externalImageId: file,
});

describe('mergeMatches', () => {
  it('keeps the best similarity per face, sorted best first with ties by id', () => {
    const merged = mergeMatches([
      [match('a', 90), match('b', 97)],
      [match('a', 93), match('c', 97)],
    ]);
    expect(merged.map((m) => [m.faceId, m.similarity])).toEqual([
      ['b', 97],
      ['c', 97],
      ['a', 93],
    ]);
  });
});

describe('selectSeeds', () => {
  it('takes the best strong matches, one per file', () => {
    const matches = [match('a', 99, 'f1'), match('b', 98.5, 'f1'), match('c', 96, 'f2')];
    expect(selectSeeds(matches, 2, 95).map((m) => m.faceId)).toEqual(['a', 'c']);
  });

  it('stops below the strong threshold and at the requested count', () => {
    const matches = [match('a', 99), match('b', 97), match('c', 94)];
    expect(selectSeeds(matches, 5, 95).map((m) => m.faceId)).toEqual(['a', 'b']);
    expect(selectSeeds(matches, 1, 95).map((m) => m.faceId)).toEqual(['a']);
    expect(selectSeeds(matches, 0, 95)).toEqual([]);
  });
});

describe('combineMatches', () => {
  it('marks faces only expansion found and keeps the best similarity', () => {
    const combined = combineMatches(
      [match('a', 99), match('b', 86)],
      [[match('b', 91), match('c', 88)]],
    );
    expect(combined.map((m) => [m.faceId, m.similarity, m.via])).toEqual([
      ['a', 99, 'selfie'],
      ['b', 91, 'selfie'],
      ['c', 88, 'expansion'],
    ]);
  });
});

describe('bucketByFile', () => {
  const thresholds = { strong: 95, maybe: 85 };
  const sourced = (faceId: string, similarity: number, via: 'selfie' | 'expansion' = 'selfie') =>
    ({ faceId, similarity, via }) satisfies SourcedMatch;
  const files: Record<string, string> = { a: 'f1', b: 'f1', c: 'f2', d: 'f3', e: 'f4' };

  it('buckets inclusive of both thresholds and drops the rest', () => {
    const hits = bucketByFile(
      [sourced('a', 95), sourced('c', 85), sourced('d', 84.99)],
      (id) => files[id],
      thresholds,
    );
    expect(hits).toEqual([
      { fileId: 'f1', similarity: 95, bucket: 'strong', via: 'selfie' },
      { fileId: 'f2', similarity: 85, bucket: 'maybe', via: 'selfie' },
    ]);
  });

  it('groups faces by file with the best similarity', () => {
    const hits = bucketByFile(
      [sourced('a', 88, 'expansion'), sourced('b', 96, 'expansion')],
      (id) => files[id],
      thresholds,
    );
    expect(hits).toEqual([{ fileId: 'f1', similarity: 96, bucket: 'strong', via: 'expansion' }]);
  });

  it('counts a file as a selfie hit when any of its faces matched a selfie', () => {
    const hits = bucketByFile(
      [sourced('a', 97, 'expansion'), sourced('b', 86, 'selfie')],
      (id) => files[id],
      thresholds,
    );
    expect(hits[0]).toMatchObject({ fileId: 'f1', similarity: 97, via: 'selfie' });
  });

  it('drops faces the resolver rejects (outside the share, deleted, not ready)', () => {
    const hits = bucketByFile(
      [sourced('e', 99), sourced('x', 99)],
      (id) => (id === 'e' ? undefined : files[id]),
      thresholds,
    );
    expect(hits).toEqual([]);
  });
});

describe('searchBySelfies', () => {
  const options = {
    collectionId: 'pg-1',
    thresholds: { strong: 95, maybe: 85 },
    expansionSeeds: 2,
    maxFaces: 1000,
    qualityFilter: 'AUTO' as const,
  };

  function stubProvider(bySelfie: Array<FaceMatch[] | Error>, byFace: Record<string, FaceMatch[]>) {
    const searchFacesByImage = vi.fn((request: SearchByImageRequest) => {
      const result = bySelfie[request.image[0]!]!;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    });
    const searchFaces = vi.fn((request: SearchByFaceRequest) =>
      Promise.resolve(byFace[request.faceId] ?? []),
    );
    const provider: FaceProvider = {
      createCollection: vi.fn(),
      deleteCollection: vi.fn(),
      indexFaces: vi.fn(),
      deleteFaces: vi.fn(),
      listFaces: vi.fn(),
      searchFacesByImage,
      searchFaces,
    };
    return { provider, searchFacesByImage, searchFaces };
  }
  const selfie = (n: number) => new Uint8Array([n]);

  it('searches every selfie at the maybe threshold and expands from strong seeds', async () => {
    const { provider, searchFacesByImage, searchFaces } = stubProvider(
      [[match('a', 99, 'f1'), match('b', 90, 'f2')], [match('c', 97, 'f3')]],
      { a: [match('d', 92, 'f4')], c: [match('e', 87, 'f5')] },
    );
    const result = await searchBySelfies(provider, [selfie(0), selfie(1)], options);
    expect(searchFacesByImage).toHaveBeenCalledWith(
      expect.objectContaining({ threshold: 85, maxFaces: 1000 }),
    );
    expect(searchFaces.mock.calls.map(([request]) => request.faceId)).toEqual(['a', 'c']);
    expect(result.seeds).toBe(2);
    expect(result.matches.map((m) => [m.faceId, m.via])).toEqual([
      ['a', 'selfie'],
      ['c', 'selfie'],
      ['d', 'expansion'],
      ['b', 'selfie'],
      ['e', 'expansion'],
    ]);
  });

  it('skips selfies without a face', async () => {
    const { provider } = stubProvider([new NoFaceDetectedError(), [match('a', 90)]], {});
    const result = await searchBySelfies(provider, [selfie(0), selfie(1)], options);
    expect(result.selfiesWithoutFace).toBe(1);
    expect(result.seeds).toBe(0);
    expect(result.matches).toHaveLength(1);
  });

  it('throws NoFaceDetectedError when no selfie has a face', async () => {
    const { provider } = stubProvider([new NoFaceDetectedError()], {});
    await expect(searchBySelfies(provider, [selfie(0)], options)).rejects.toBeInstanceOf(
      NoFaceDetectedError,
    );
  });

  it('propagates other provider errors', async () => {
    const { provider } = stubProvider([new Error('throttled'), [match('a', 99)]], {});
    await expect(searchBySelfies(provider, [selfie(0), selfie(1)], options)).rejects.toThrow(
      'throttled',
    );
  });
});

describe('selfieSearchOptions', () => {
  it('takes thresholds and search settings from FaceConfig', () => {
    const config = loadFaceConfig({ FACE_STRONG: '96', FACE_EXPANSION_SEEDS: '0' });
    expect(selfieSearchOptions(config, 'pg-7')).toEqual({
      collectionId: 'pg-7',
      thresholds: { strong: 96, maybe: 85 },
      expansionSeeds: 0,
      maxFaces: 1000,
      qualityFilter: 'AUTO',
    });
  });
});
