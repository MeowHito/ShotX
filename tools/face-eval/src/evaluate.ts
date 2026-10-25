import {
  bucketByFile,
  combineMatches,
  type FaceMatch,
  type FaceProvider,
  faceCollectionId,
  indexPhoto,
  IndexPhotoError,
  indexPhotoOptions,
  type IndexTempKey,
  mergeMatches,
  NoFaceDetectedError,
  prepareSelfie,
  type QualityFilter,
  selectSeeds,
  type SmallFaceDetector,
  type TempImageStore,
  type TilingMode,
} from '@shotx/face';
import type { FaceConfig } from '@shotx/shared';
import { CountingFaceProvider, type CallCounts, diffCounts } from './counting-provider';
import { type Dataset, type Person, readPhoto, readSelfies } from './dataset';

/** Options applied when photos are indexed. Each one needs its own collection. */
export interface IndexOption {
  longEdge: number;
  qualityFilter: QualityFilter;
  tiling: TilingMode;
}

/** Options applied when a person scans. They reuse the index. */
export interface SearchOption {
  selfies: number;
  /** 0 turns expansion off. */
  expansionSeeds: number;
}

/**
 * Keys of temporary index images, `tmp/index/{fileId}/{attemptId}/{part}.jpg`: the format of the
 * shared key builder contracts is adding to packages/shared, which replaces this once it lands.
 */
export const evalTempKey: IndexTempKey = ({ fileId, attemptId, part }) =>
  `tmp/index/${fileId}/${attemptId}/${part}.jpg`;

export const indexKey = (o: IndexOption) =>
  `le${o.longEdge}-${o.qualityFilter.toLowerCase()}-${o.tiling}`;
export const searchKey = (o: SearchOption) => `s${o.selfies}-x${o.expansionSeeds}`;

export interface IndexStats {
  photos: number;
  failedPhotos: number;
  tiledPhotos: number;
  /** Faces left in the collection (tile duplicates included). */
  facesStored: number;
  /** Distinct faces after IoU de-duplication, i.e. the sum of `face_count`. */
  distinctFaces: number;
  calls: CallCounts;
}

export interface FileScore {
  photoId: string;
  similarity: number;
}

/** One person's scan with one index and search option, before any threshold is applied. */
export interface PersonScan {
  personId: string;
  /** SearchFacesByImage calls the scan makes: one per selfie sent. */
  selfiesUsed: number;
  selfiesWithoutFace: number;
  /** Similarities of the seeds picked at the lowest strong threshold, best first. */
  seedSimilarities: number[];
  /**
   * `files[k]` holds the files found with the first k seeds, best similarity first, down to the
   * sweep floor. A higher strong threshold uses fewer seeds: those at or above it.
   */
  files: FileScore[][];
  /** Some provider call returned MaxFaces results, so lower matches may be missing. */
  truncated: boolean;
}

export interface ComboResult {
  index: IndexOption;
  search: SearchOption;
  scans: PersonScan[];
}

export interface EvaluationInput {
  dataset: Dataset;
  provider: FaceProvider;
  tempStore: TempImageStore;
  smallFaceDetector?: SmallFaceDetector | undefined;
  config: FaceConfig;
  indexOptions: IndexOption[];
  searchOptions: SearchOption[];
  /** Lowest FACE_MAYBE in the sweep: every search runs at this threshold. */
  sweepFloor: number;
  /** Lowest FACE_STRONG in the sweep: seeds are picked at this threshold. */
  minStrong: number;
  /** Makes collection ids unique per run, e.g. `eval-20261025t1200`. */
  collectionTag: string;
  concurrency: number;
  keepCollections: boolean;
  log: (message: string) => void;
}

export interface EvaluationResult {
  indexStats: Record<string, IndexStats>;
  combos: ComboResult[];
  /** Every call the harness made, for the cost of the evaluation itself. */
  harnessCalls: CallCounts;
  faceModelVersion: string | undefined;
}

async function pool<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) await run(items[next++]!);
  });
  await Promise.all(workers);
}

/**
 * Indexes the dataset once per index option, then scans every person with every search option.
 * Searches run at the sweep floor and keep raw similarities, so any FACE_STRONG / FACE_MAYBE pair
 * at or above the floor can be scored offline without more provider calls.
 */
export async function evaluate(input: EvaluationInput): Promise<EvaluationResult> {
  const { dataset, config, log } = input;
  const provider = new CountingFaceProvider(input.provider);
  const indexStats: Record<string, IndexStats> = {};
  const combos: ComboResult[] = [];
  const maxSelfies = Math.max(...input.searchOptions.map((o) => o.selfies));
  let faceModelVersion: string | undefined;

  for (const indexOption of input.indexOptions) {
    const key = indexKey(indexOption);
    const collectionId = faceCollectionId(`${input.collectionTag}-${key}`);
    const before = provider.snapshot();
    const created = await provider.createCollection(collectionId);
    faceModelVersion ??= created.faceModelVersion;
    try {
      const stats = {
        photos: 0,
        failedPhotos: 0,
        tiledPhotos: 0,
        facesStored: 0,
        distinctFaces: 0,
      };
      const photoOfFace = new Map<string, string>();
      const options = (fileId: string) => ({
        ...indexPhotoOptions(config, { collectionId, fileId, tiling: indexOption.tiling }),
        longEdge: indexOption.longEdge,
        qualityFilter: indexOption.qualityFilter,
      });
      const deps = {
        provider,
        tempStore: input.tempStore,
        tempKey: evalTempKey,
        smallFaceDetector: input.smallFaceDetector,
      };
      await pool(dataset.photos, input.concurrency, async (photo) => {
        stats.photos++;
        try {
          const result = await indexPhoto(deps, await readPhoto(dataset, photo), options(photo.id));
          for (const face of result.faces) photoOfFace.set(face.faceId, photo.id);
          stats.facesStored += result.faces.length;
          stats.distinctFaces += result.faceCount;
          if (result.tiled) stats.tiledPhotos++;
        } catch (error) {
          stats.failedPhotos++;
          log(`  ${photo.path}: ${describeFailure(error)}`);
        }
      });
      const indexCalls = diffCounts(provider.snapshot(), before);
      log(
        `${key}: indexed ${stats.photos} photos, ${stats.facesStored} faces, ` +
          `${stats.tiledPhotos} tiled, ${indexCalls.indexFaces} IndexFaces calls`,
      );

      const scans = new Map<string, PersonScan[]>();
      for (const option of input.searchOptions) scans.set(searchKey(option), []);
      const expansionCache = new Map<string, Promise<FaceMatch[]>>();
      for (const person of dataset.persons) {
        const results = await searchSelfies(input, provider, collectionId, person, maxSelfies);
        for (const option of input.searchOptions) {
          const scan = await scanPerson(input, provider, collectionId, person, option, results, {
            expansionCache,
            photoOfFace,
          });
          scans.get(searchKey(option))!.push(scan);
        }
      }
      for (const option of input.searchOptions) {
        combos.push({ index: indexOption, search: option, scans: scans.get(searchKey(option))! });
      }
      indexStats[key] = { ...stats, calls: indexCalls };
    } finally {
      if (!input.keepCollections) await provider.deleteCollection(collectionId);
    }
  }
  return { indexStats, combos, harnessCalls: provider.snapshot(), faceModelVersion };
}

/**
 * Error names and counts only: messages could carry file names, and the collection is deleted at
 * the end of the run anyway (unless --keep-collections), orphaned faces included.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof IndexPhotoError)) return error instanceof Error ? error.name : 'error';
  const cause = error.cause instanceof Error ? error.cause.name : 'error';
  const left = [
    error.orphanFaceIds.length > 0 ? `${error.orphanFaceIds.length} orphaned faces` : '',
    error.untrackedFacesPossible ? 'faces of unknown ids may remain' : '',
    error.cleanupErrors.length > 0 ? `${error.cleanupErrors.length} cleanup errors` : '',
  ].filter(Boolean);
  return left.length > 0 ? `${cause} (${left.join(', ')})` : cause;
}

/** Each selfie's matches at the sweep floor, or null when it has no face. Bytes stay in memory. */
async function searchSelfies(
  input: EvaluationInput,
  provider: FaceProvider,
  collectionId: string,
  person: Person,
  count: number,
): Promise<Array<FaceMatch[] | null>> {
  const raw = await readSelfies(input.dataset, person, count);
  const selfies = await Promise.all(raw.map((bytes) => prepareSelfie(bytes, input.config)));
  return Promise.all(
    selfies.map((selfie) =>
      provider
        .searchFacesByImage({
          collectionId,
          image: selfie.bytes,
          threshold: input.sweepFloor,
          maxFaces: input.config.search.maxFaces,
          qualityFilter: input.config.search.qualityFilter,
        })
        .catch((error: unknown) => {
          if (error instanceof NoFaceDetectedError) return null;
          throw error;
        }),
    ),
  );
}

async function scanPerson(
  input: EvaluationInput,
  provider: FaceProvider,
  collectionId: string,
  person: Person,
  option: SearchOption,
  selfieResults: Array<FaceMatch[] | null>,
  cache: { expansionCache: Map<string, Promise<FaceMatch[]>>; photoOfFace: Map<string, string> },
): Promise<PersonScan> {
  const { maxFaces } = input.config.search;
  const used = selfieResults.slice(0, option.selfies);
  const lists = used.filter((list): list is FaceMatch[] => list !== null);
  const direct = mergeMatches(lists);
  const seeds = selectSeeds(direct, option.expansionSeeds, input.minStrong);
  const expansions = await Promise.all(
    seeds.map((seed) => {
      let pending = cache.expansionCache.get(seed.faceId);
      if (!pending) {
        pending = provider.searchFaces({
          collectionId,
          faceId: seed.faceId,
          threshold: input.sweepFloor,
          maxFaces,
        });
        cache.expansionCache.set(seed.faceId, pending);
      }
      return pending;
    }),
  );
  // The production code path, with FACE_MAYBE at the sweep floor; higher thresholds filter it.
  const files = Array.from({ length: seeds.length + 1 }, (_, k) =>
    bucketByFile(
      combineMatches(direct, expansions.slice(0, k)),
      (faceId) => cache.photoOfFace.get(faceId),
      { strong: 100, maybe: input.sweepFloor },
    ).map((hit): FileScore => ({ photoId: hit.fileId, similarity: hit.similarity })),
  );
  return {
    personId: person.id,
    selfiesUsed: used.length,
    selfiesWithoutFace: used.length - lists.length,
    seedSimilarities: seeds.map((seed) => seed.similarity),
    files,
    truncated: [...lists, ...expansions].some((list) => list.length >= maxFaces),
  };
}
