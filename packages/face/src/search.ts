import type { FaceConfig } from '@shotx/shared';
import { type FaceProvider, NoFaceDetectedError } from './provider';
import type { FaceMatch, FaceThresholds, QualityFilter } from './types';

export type MatchSource = 'selfie' | 'expansion';
export type Bucket = 'strong' | 'maybe';

export interface SourcedMatch extends FaceMatch {
  /** `selfie` when a selfie matched the face directly, `expansion` when only a seed did. */
  via: MatchSource;
}

export interface FileHit {
  fileId: string;
  similarity: number;
  bucket: Bucket;
  via: MatchSource;
}

/** Best similarity first, ties broken by face id so results are deterministic. */
export function compareMatches(a: FaceMatch, b: FaceMatch): number {
  return b.similarity - a.similarity || compareIds(a.faceId, b.faceId);
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Unions match lists, keeping each face's best similarity. Sorted best first. */
export function mergeMatches(lists: readonly (readonly FaceMatch[])[]): FaceMatch[] {
  const best = new Map<string, FaceMatch>();
  for (const list of lists) {
    for (const match of list) {
      const current = best.get(match.faceId);
      if (!current || match.similarity > current.similarity) best.set(match.faceId, match);
    }
  }
  return [...best.values()].sort(compareMatches);
}

/**
 * Picks expansion seeds from `matches` (sorted best first): the best matches at or above
 * `strong`, at most one per file. Tiling can index the same face twice, and two seeds from one
 * photo would mostly find the same faces.
 */
export function selectSeeds(
  matches: readonly FaceMatch[],
  count: number,
  strong: number,
): FaceMatch[] {
  const seeds: FaceMatch[] = [];
  const files = new Set<string>();
  for (const match of matches) {
    if (seeds.length >= count || match.similarity < strong) break;
    const file = match.externalImageId ?? match.faceId;
    if (files.has(file)) continue;
    files.add(file);
    seeds.push(match);
  }
  return seeds;
}

/** Unions direct selfie matches with expansion results; each face keeps its best similarity. */
export function combineMatches(
  direct: readonly FaceMatch[],
  expansions: readonly (readonly FaceMatch[])[],
): SourcedMatch[] {
  const combined = new Map<string, SourcedMatch>();
  for (const match of direct) {
    const current = combined.get(match.faceId);
    if (!current || match.similarity > current.similarity) {
      combined.set(match.faceId, { ...match, via: 'selfie' });
    }
  }
  for (const list of expansions) {
    for (const match of list) {
      const current = combined.get(match.faceId);
      if (!current) combined.set(match.faceId, { ...match, via: 'expansion' });
      else if (match.similarity > current.similarity) {
        combined.set(match.faceId, { ...match, via: current.via });
      }
    }
  }
  return [...combined.values()].sort(compareMatches);
}

/**
 * Groups matches by file with the best similarity and buckets the files. `resolveFile` returns a
 * face's file id, or undefined to drop the face (file not ready, deleted or outside the share).
 */
export function bucketByFile(
  matches: readonly SourcedMatch[],
  resolveFile: (faceId: string) => string | undefined,
  thresholds: FaceThresholds,
): FileHit[] {
  const files = new Map<string, { similarity: number; via: MatchSource }>();
  for (const match of matches) {
    if (match.similarity < thresholds.maybe) continue;
    const fileId = resolveFile(match.faceId);
    if (fileId === undefined) continue;
    const current = files.get(fileId);
    files.set(fileId, {
      similarity: Math.max(current?.similarity ?? -Infinity, match.similarity),
      via: current?.via === 'selfie' || match.via === 'selfie' ? 'selfie' : 'expansion',
    });
  }
  return [...files]
    .map(([fileId, { similarity, via }]): FileHit => {
      const bucket = similarity >= thresholds.strong ? 'strong' : 'maybe';
      return { fileId, similarity, bucket, via };
    })
    .sort((a, b) => b.similarity - a.similarity || compareIds(a.fileId, b.fileId));
}

export interface SelfieSearchOptions {
  collectionId: string;
  thresholds: FaceThresholds;
  expansionSeeds: number;
  maxFaces: number;
  qualityFilter: QualityFilter;
}

export function selfieSearchOptions(config: FaceConfig, collectionId: string): SelfieSearchOptions {
  return {
    collectionId,
    thresholds: config.thresholds,
    expansionSeeds: config.search.expansionSeeds,
    maxFaces: config.search.maxFaces,
    qualityFilter: config.search.qualityFilter,
  };
}

export interface SelfieSearchResult {
  matches: SourcedMatch[];
  selfiesWithoutFace: number;
  seeds: number;
}

/**
 * Searches a collection with each selfie, then searches again from the strongest matches to
 * recover profile and far-away shots that a selfie misses. Throws NoFaceDetectedError when no
 * selfie contains a face.
 */
export async function searchBySelfies(
  provider: FaceProvider,
  selfies: readonly Uint8Array[],
  options: SelfieSearchOptions,
): Promise<SelfieSearchResult> {
  const { collectionId, thresholds, maxFaces } = options;
  const results = await Promise.allSettled(
    selfies.map((image) =>
      provider.searchFacesByImage({
        collectionId,
        image,
        threshold: thresholds.maybe,
        maxFaces,
        qualityFilter: options.qualityFilter,
      }),
    ),
  );
  const lists: FaceMatch[][] = [];
  let selfiesWithoutFace = 0;
  for (const result of results) {
    if (result.status === 'fulfilled') lists.push(result.value);
    else if (result.reason instanceof NoFaceDetectedError) selfiesWithoutFace++;
    else throw result.reason;
  }
  if (lists.length === 0) throw new NoFaceDetectedError();

  const direct = mergeMatches(lists);
  const seeds = selectSeeds(direct, options.expansionSeeds, thresholds.strong);
  const expansions = await Promise.all(
    seeds.map((seed) =>
      provider.searchFaces({
        collectionId,
        faceId: seed.faceId,
        threshold: thresholds.maybe,
        maxFaces,
      }),
    ),
  );
  return { matches: combineMatches(direct, expansions), selfiesWithoutFace, seeds: seeds.length };
}
