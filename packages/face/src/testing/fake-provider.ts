import { createHash } from 'node:crypto';
import type { EncodedImage } from '../image';
import type { SmallFaceDetector } from '../index-photo';
import {
  type FaceProvider,
  type IndexFacesRequest,
  type ListFacesPage,
  type ListFacesRequest,
  NoFaceDetectedError,
  REKOGNITION_LIST_FACES_MAX_RESULTS,
  type SearchByFaceRequest,
  type SearchByImageRequest,
} from '../provider';
import { compareMatches } from '../search';
import type {
  BoundingBox,
  FaceMatch,
  ImageInput,
  IndexFacesResult,
  PixelRect,
  QualityFilter,
  Size,
} from '../types';
import type { ObjectReader } from './memory-store';
import { type DetectedFace, detectSyntheticFaces } from './synthetic';
import { faceQuality, type Observation, type Pose, type SyntheticWorld } from './world';

export interface StoredFace {
  faceId: string;
  externalImageId: string;
  personId: string;
  pose: Pose;
  widthPx: number;
}

/** What each QualityFilter level rejects, loosely modelled on Rekognition. */
const QUALITY_RULES: Record<QualityFilter, { minSizeFactor: number; minQuality: number } | null> = {
  NONE: null,
  AUTO: { minSizeFactor: 1.15, minQuality: 0.05 },
  LOW: { minSizeFactor: 1.15, minQuality: 0.05 },
  MEDIUM: { minSizeFactor: 1.3, minQuality: 0.15 },
  HIGH: { minSizeFactor: 1.5, minQuality: 0.3 },
};

/** Smallest face Rekognition finds: 40 px in a 1920×1080 image, proportionally more above that. */
export function minFaceWidth(size: Size): number {
  return 40 * Math.max(1, Math.sqrt((size.width * size.height) / (1920 * 1080)));
}

type Detection = { size: Size; faces: DetectedFace[] };

export type FakeOperation =
  | 'createCollection'
  | 'deleteCollection'
  | 'indexFaces'
  | 'searchFacesByImage'
  | 'searchFaces'
  | 'deleteFaces'
  | 'listFaces';

/** A failure `failNext` injects into one call. */
export interface FakeFailure {
  /** The error the call rejects with. A function builds a fresh error for every failing call. */
  error: Error | (() => Error);
  /**
   * Do the call's work first, then fail: the response got lost after the service acted, e.g.
   * IndexFaces indexed the faces but timed out (inject IndexFacesOutcomeUnknownError for that).
   */
  afterEffect?: boolean;
}

/**
 * Deterministic FaceProvider for synthetic images (see `./synthetic`). It detects faces from
 * pixels, applies Rekognition-like size and quality limits, and scores matches with the world's
 * similarity model.
 */
export class FakeFaceProvider implements FaceProvider {
  readonly calls = {
    createCollection: 0,
    deleteCollection: 0,
    indexFaces: 0,
    searchFacesByImage: 0,
    searchFaces: 0,
    deleteFaces: 0,
    listFaces: 0,
  };
  /** Per operation, what the next calls do: fail, or succeed (null). */
  private readonly failures = new Map<FakeOperation, Array<FakeFailure | null>>();
  private readonly collections = new Map<string, Map<string, StoredFace>>();
  private readonly issued = new Set<string>();
  private readonly detections = new Map<string, Promise<Detection>>();

  constructor(
    private readonly world: SyntheticWorld,
    private readonly objects?: ObjectReader,
  ) {}

  /**
   * Makes calls of `operation` fail: after `after` more calls succeed, the next `times` fail.
   * Calls queue up per operation, so tests can script sequences such as "the third IndexFaces call
   * fails, then the next DeleteFaces call".
   */
  failNext(
    operation: FakeOperation,
    failure: FakeFailure | Error,
    { after = 0, times = 1 }: { after?: number; times?: number } = {},
  ): this {
    const entry = failure instanceof Error ? { error: failure } : failure;
    const queue = this.failures.get(operation) ?? [];
    for (let i = 0; i < after; i++) queue.push(null);
    for (let i = 0; i < times; i++) queue.push(entry);
    this.failures.set(operation, queue);
    return this;
  }

  createCollection(collectionId: string): Promise<{ faceModelVersion: string }> {
    this.calls.createCollection++;
    return this.run('createCollection', () => {
      if (!this.collections.has(collectionId)) this.collections.set(collectionId, new Map());
      return { faceModelVersion: 'fake' };
    });
  }

  deleteCollection(collectionId: string): Promise<void> {
    this.calls.deleteCollection++;
    return this.run('deleteCollection', () => {
      this.collections.delete(collectionId);
    });
  }

  indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult> {
    this.calls.indexFaces++;
    return this.run('indexFaces', () => this.index(request));
  }

  searchFacesByImage(request: SearchByImageRequest): Promise<FaceMatch[]> {
    this.calls.searchFacesByImage++;
    return this.run('searchFacesByImage', async () => {
      const collection = this.collection(request.collectionId);
      const { faces } = await this.detect(request.image);
      const query = faces.reduce<DetectedFace | undefined>(
        (best, face) => (!best || face.box.width > best.box.width ? face : best),
        undefined,
      );
      if (!query) throw new NoFaceDetectedError();
      const observation: Observation = {
        personId: query.personId,
        pose: query.pose,
        widthPx: query.box.width,
        selfie: true,
        key: `selfie:${sha256(request.image).slice(0, 16)}`,
      };
      return this.search(collection, observation, request.threshold, request.maxFaces);
    });
  }

  searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]> {
    this.calls.searchFaces++;
    return this.run('searchFaces', () => {
      const collection = this.collection(request.collectionId);
      const face = collection.get(request.faceId);
      if (!face) throw new Error(`Face ${request.faceId} is not in the collection`);
      return this.search(
        collection,
        observe(face),
        request.threshold,
        request.maxFaces,
        face.faceId,
      );
    });
  }

  deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void> {
    this.calls.deleteFaces++;
    return this.run('deleteFaces', () => {
      const collection = this.collection(collectionId);
      for (const faceId of faceIds) collection.delete(faceId);
    });
  }

  /** Pages through faces in face id order; the token is the last face id of the page. */
  listFaces(request: ListFacesRequest): Promise<ListFacesPage> {
    this.calls.listFaces++;
    return this.run('listFaces', () => {
      const { maxResults, nextToken } = request;
      if (!(
        Number.isInteger(maxResults) &&
        maxResults >= 1 &&
        maxResults <= REKOGNITION_LIST_FACES_MAX_RESULTS
      )) {
        throw new RangeError(`MaxResults must be 1 to ${REKOGNITION_LIST_FACES_MAX_RESULTS}`);
      }
      const collection = this.collection(request.collectionId);
      // An id cursor, unlike an offset, survives faces deleted between pages.
      const ids = [...collection.keys()]
        .sort()
        .filter((id) => nextToken === undefined || id > nextToken);
      const page = ids.slice(0, maxResults);
      return {
        faces: page.map((faceId) => ({
          faceId,
          externalImageId: collection.get(faceId)?.externalImageId,
        })),
        nextToken: ids.length > page.length ? page.at(-1) : undefined,
      };
    });
  }

  /** Faces currently in a collection, for assertions. */
  storedFaces(collectionId: string): StoredFace[] {
    return [...this.collection(collectionId).values()];
  }

  private async index(request: IndexFacesRequest): Promise<IndexFacesResult> {
    const collection = this.collection(request.collectionId);
    const { size, faces } = await this.detect(this.resolve(request.image));
    const minWidth = minFaceWidth(size);
    const rule = QUALITY_RULES[request.qualityFilter];
    const result: IndexFacesResult = { faces: [], unindexed: [] };
    const largestFirst = faces
      .filter((face) => face.box.width >= minWidth)
      .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
    for (const face of largestFirst) {
      const bbox = toRatios(face.box, size);
      const reasons: string[] = [];
      if (rule && face.box.width < minWidth * rule.minSizeFactor)
        reasons.push('SMALL_BOUNDING_BOX');
      if (rule && faceQuality(face.box.width) < rule.minQuality) reasons.push('LOW_FACE_QUALITY');
      if (reasons.length === 0 && result.faces.length >= request.maxFaces) {
        reasons.push('EXCEEDS_MAX_FACES');
      }
      if (reasons.length > 0) {
        result.unindexed.push({ bbox, reasons });
        continue;
      }
      const faceId = newFaceId(this.issued, request.collectionId, request.externalImageId, face);
      collection.set(faceId, {
        faceId,
        externalImageId: request.externalImageId,
        personId: face.personId,
        pose: face.pose,
        widthPx: face.box.width,
      });
      result.faces.push({ faceId, bbox, confidence: 90 + 9.9 * faceQuality(face.box.width) });
    }
    return result;
  }

  /** Runs one call, applying the next injected failure for its operation, if any. */
  private async run<T>(operation: FakeOperation, work: () => T | Promise<T>): Promise<T> {
    const failure = this.failures.get(operation)?.shift();
    if (!failure) return work();
    if (failure.afterEffect) await work();
    throw typeof failure.error === 'function' ? failure.error() : failure.error;
  }

  private search(
    collection: Map<string, StoredFace>,
    query: Observation,
    threshold: number,
    maxFaces: number,
    exclude?: string,
  ): FaceMatch[] {
    const matches: FaceMatch[] = [];
    for (const face of collection.values()) {
      if (face.faceId === exclude) continue;
      const similarity = this.world.similarity(query, observe(face));
      if (similarity >= threshold) {
        matches.push({ faceId: face.faceId, similarity, externalImageId: face.externalImageId });
      }
    }
    return matches.sort(compareMatches).slice(0, maxFaces);
  }

  private collection(collectionId: string): Map<string, StoredFace> {
    const collection = this.collections.get(collectionId);
    if (!collection) {
      const error = new Error(`Collection ${collectionId} does not exist`);
      error.name = 'ResourceNotFoundException';
      throw error;
    }
    return collection;
  }

  private resolve(image: ImageInput): Uint8Array {
    if ('bytes' in image) return image.bytes;
    const bytes = this.objects?.get(image.s3.key);
    if (!bytes) throw new Error(`Object ${image.s3.key} not found`);
    return bytes;
  }

  private detect(bytes: Uint8Array): Promise<Detection> {
    const key = sha256(bytes);
    let detection = this.detections.get(key);
    if (!detection) {
      detection = detectSyntheticFaces(this.world, bytes);
      this.detections.set(key, detection);
    }
    return detection;
  }
}

/** Plays the local small-face detector for synthetic images; it sees faces of any size. */
export class SyntheticSmallFaceDetector implements SmallFaceDetector {
  constructor(private readonly world: SyntheticWorld) {}

  async faceWidths(image: EncodedImage): Promise<number[]> {
    const { size, faces } = await detectSyntheticFaces(this.world, image.bytes);
    return faces.map((face) => face.box.width / size.width);
  }
}

function observe(face: StoredFace): Observation {
  return {
    personId: face.personId,
    pose: face.pose,
    widthPx: face.widthPx,
    selfie: false,
    key: face.faceId,
  };
}

function toRatios(box: PixelRect, size: Size): BoundingBox {
  return {
    left: box.left / size.width,
    top: box.top / size.height,
    width: box.width / size.width,
    height: box.height / size.height,
  };
}

/**
 * Face ids derive from content, so they don't depend on the order of concurrent calls. Like
 * Rekognition, an id is never handed out twice, not even after its face was deleted.
 */
function newFaceId(
  issued: Set<string>,
  collectionId: string,
  externalImageId: string,
  face: DetectedFace,
): string {
  const { left, top, width, height } = face.box;
  const base = `${collectionId}|${externalImageId}|${face.personId}|${left},${top},${width},${height}`;
  for (let n = 0; ; n++) {
    const hex = sha256(n === 0 ? base : `${base}#${n}`);
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
    if (!issued.has(id)) {
      issued.add(id);
      return id;
    }
  }
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
