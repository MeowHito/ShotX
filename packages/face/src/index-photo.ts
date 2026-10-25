import { randomUUID } from 'node:crypto';
import type { FaceConfig } from '@shotx/shared';
import { countDistinct, tileBoxToImage, tileRects, touchesInnerEdge } from './geometry';
import {
  type EncodedImage,
  type EncodeOptions,
  encodeJpeg,
  type JpegOptions,
  orientedSize,
} from './image';
import { type FaceProvider, IndexFacesOutcomeUnknownError } from './provider';
import type { TempImageStore } from './temp-store';
import type { IndexedFace, IndexFacesResult, QualityFilter } from './types';

export const TILING_MODES = ['never', 'signal', 'always'] as const;
export type TilingMode = (typeof TILING_MODES)[number];

/** Rekognition reasons meaning faces were skipped for being small or too many. */
const TILE_REASONS = new Set(['SMALL_BOUNDING_BOX', 'EXCEEDS_MAX_FACES']);

/** Cheap local face detector (e.g. OpenCV YuNet) that decides whether small faces need tiles. */
export interface SmallFaceDetector {
  /** Widths of the faces in the image, as ratios of the image width. */
  faceWidths(image: EncodedImage): Promise<number[]>;
}

/** Which temporary index image of an attempt: the full image, or tile n. */
export type IndexTempPart = 'full' | `t${number}`;

/**
 * Builds the object key of a temporary index image, `tmp/index/{fileId}/{attemptId}/{part}.jpg`.
 * Production passes the shared key builder. Keys must differ for different attempts and parts, so
 * concurrent attempts for one file never overwrite or delete each other's images.
 */
export type IndexTempKey = (image: {
  fileId: string;
  attemptId: string;
  part: IndexTempPart;
}) => string;

export interface IndexPhotoDeps {
  provider: FaceProvider;
  tempStore: TempImageStore;
  tempKey: IndexTempKey;
  smallFaceDetector?: SmallFaceDetector | undefined;
  /** A fresh id for every indexPhoto call. Defaults to a random UUID; tests may pin it. */
  newAttemptId?: (() => string) | undefined;
}

export interface IndexPhotoOptions {
  collectionId: string;
  /** Used as ExternalImageId, so moving or renaming the file never requires re-indexing. */
  fileId: string;
  /**
   * Faces the file's `faces` rows hold from an earlier indexing, deleted before indexing again.
   * See `indexPhoto` for re-indexing.
   */
  previousFaceIds?: readonly string[] | undefined;
  longEdge: number;
  jpegQuality: number;
  maxBytes: number;
  maxFaces: number;
  qualityFilter: QualityFilter;
  tiling: TilingMode;
  tileGrid: number;
  tileOverlap: number;
  /** Tile faces this close (in tile ratios) to an inner tile edge count as cut off. */
  tileEdgeEpsilon: number;
  smallFaceRatio: number;
  dedupeIou: number;
  encode: EncodeOptions;
}

/** What a caller decides per photo; everything else comes from FaceConfig. */
export interface IndexPhotoTarget {
  collectionId: string;
  fileId: string;
  tiling: TilingMode;
  previousFaceIds?: readonly string[] | undefined;
}

export function indexPhotoOptions(config: FaceConfig, target: IndexPhotoTarget): IndexPhotoOptions {
  const { index } = config;
  return {
    ...target,
    longEdge: index.longEdge,
    jpegQuality: index.jpegQuality,
    maxBytes: index.maxBytes,
    maxFaces: index.maxFaces,
    qualityFilter: index.qualityFilter,
    tileGrid: index.tileGrid,
    tileOverlap: index.tileOverlap,
    tileEdgeEpsilon: index.tileEdgeEpsilon,
    smallFaceRatio: index.smallFaceRatio,
    dedupeIou: index.dedupeIou,
    encode: config.encode,
  };
}

export interface PhotoFace extends IndexedFace {
  /** Index of the tile the face was found in, or null for the full image. */
  tile: number | null;
}

export interface TileSignal {
  /** Rekognition skipped faces as too small or too many. */
  rekognition: boolean;
  /** The local detector saw a face narrower than `smallFaceRatio`; null without a detector. */
  localDetector: boolean | null;
}

export interface IndexPhotoResult {
  attemptId: string;
  /** Faces kept in the collection. Boxes are relative to the oriented original. */
  faces: PhotoFace[];
  /** Distinct faces, after merging the duplicates that overlapping tiles produce. */
  faceCount: number;
  signal: TileSignal;
  tiled: boolean;
  /** Faces cut off at inner tile edges, which were deleted from the collection again. */
  discardedFaces: number;
  /** Faces of `previousFaceIds` deleted before indexing. */
  replacedFaces: number;
  indexCalls: number;
}

/** A temporary index image could not be deleted. The `tmp/` lifecycle rule is only a backstop. */
export class TempImageCleanupError extends Error {
  constructor(
    readonly key: string,
    cause: unknown,
  ) {
    super(`Temporary index image ${key} could not be deleted`, { cause });
    this.name = 'TempImageCleanupError';
  }
}

export interface IndexPhotoFailure {
  collectionId: string;
  fileId: string;
  attemptId: string;
  orphanFaceIds: readonly string[];
  untrackedFacesPossible: boolean;
  cleanupErrors: readonly unknown[];
}

/**
 * indexPhoto failed; `cause` says why. Every failure has this type, and nothing it left behind is
 * hidden:
 *
 * - `orphanFaceIds`: faces this attempt indexed that are still in the collection because deleting
 *   them failed too. No row tracks them. Record them and retry `deleteFaces` (ids that are already
 *   gone are ignored), or leave them to `reconcileCollection`.
 * - `untrackedFacesPossible`: an IndexFaces call may have indexed faces whose ids never came back
 *   (IndexFacesOutcomeUnknownError). Only `reconcileCollection` finds them; schedule it for the
 *   collection.
 * - `cleanupErrors`: every cleanup step that failed after `cause` (DeleteFaces, temporary images).
 */
export class IndexPhotoError extends Error implements IndexPhotoFailure {
  readonly collectionId: string;
  readonly fileId: string;
  readonly attemptId: string;
  readonly orphanFaceIds: readonly string[];
  readonly untrackedFacesPossible: boolean;
  readonly cleanupErrors: readonly unknown[];

  constructor(failure: IndexPhotoFailure, cause: unknown) {
    const left = [
      failure.orphanFaceIds.length > 0
        ? `${failure.orphanFaceIds.length} indexed faces that could not be deleted`
        : '',
      failure.untrackedFacesPossible
        ? 'faces IndexFaces may have indexed without returning them'
        : '',
    ].filter(Boolean);
    super(
      `Indexing file ${failure.fileId} (attempt ${failure.attemptId}) failed: ${
        cause instanceof Error ? cause.name : String(cause)
      }${left.length > 0 ? `. Left in ${failure.collectionId}: ${left.join(', ')}` : ''}`,
      { cause },
    );
    this.name = 'IndexPhotoError';
    this.collectionId = failure.collectionId;
    this.fileId = failure.fileId;
    this.attemptId = failure.attemptId;
    this.orphanFaceIds = failure.orphanFaceIds;
    this.untrackedFacesPossible = failure.untrackedFacesPossible;
    this.cleanupErrors = failure.cleanupErrors;
  }

  /** The collection may hold faces from this attempt that no `faces` row tracks. */
  get leftFaces(): boolean {
    return this.orphanFaceIds.length > 0 || this.untrackedFacesPossible;
  }
}

/**
 * Indexes one photo: the full image first, then overlapping tiles when small faces are likely to
 * have been missed. Every face that stays in the collection is returned, so the caller can record
 * it. On failure, faces indexed by this attempt are deleted again and an IndexPhotoError reports
 * whatever could not be cleaned up.
 *
 * Each call is a new attempt with its own id and its own temporary image keys, so concurrent or
 * retried attempts for one file never touch each other's images.
 *
 * Re-indexing a file: pass the face ids its rows hold as `previousFaceIds`. They are deleted
 * before anything is indexed, so if that fails the rows still track every face. After success,
 * replace the file's rows in one transaction. Rows left pointing at deleted faces are harmless:
 * searches never return those faces and deleting them again is a no-op.
 *
 * The worker must record the returned faces before `recordFacesDeadline` (see
 * `reconcileCollection`), or not at all.
 */
export async function indexPhoto(
  deps: IndexPhotoDeps,
  original: Uint8Array,
  options: IndexPhotoOptions,
): Promise<IndexPhotoResult> {
  const attempt = new IndexAttempt(deps, options, (deps.newAttemptId ?? randomUUID)());
  try {
    const replacedFaces = await attempt.deletePreviousFaces();
    const { full, fullResult } = await attempt.indexFull(original);
    const faces: PhotoFace[] = fullResult.faces.map((face) => ({ ...face, tile: null }));

    const signal: TileSignal = {
      rekognition: fullResult.unindexed.some((face) =>
        face.reasons.some((reason) => TILE_REASONS.has(reason)),
      ),
      localDetector: deps.smallFaceDetector
        ? (await deps.smallFaceDetector.faceWidths(full)).some((w) => w < options.smallFaceRatio)
        : null,
    };
    const tiled =
      options.tiling === 'always' ||
      (options.tiling === 'signal' && (signal.rekognition || signal.localDetector === true));

    let indexCalls = 1;
    const discarded: string[] = [];
    if (tiled) {
      const size = await orientedSize(original);
      for (const [i, rect] of tileRects(size, options.tileGrid, options.tileOverlap).entries()) {
        const tile = await encodeJpeg(original, attempt.jpeg, rect);
        const result = await attempt.indexImage(tile.bytes, `t${i}`);
        indexCalls++;
        for (const face of result.faces) {
          if (touchesInnerEdge(face.bbox, rect, size, options.tileEdgeEpsilon)) {
            discarded.push(face.faceId);
          } else {
            faces.push({ ...face, bbox: tileBoxToImage(face.bbox, rect, size), tile: i });
          }
        }
      }
      if (discarded.length > 0) await deps.provider.deleteFaces(options.collectionId, discarded);
    }

    return {
      attemptId: attempt.id,
      faces,
      faceCount: countDistinct(
        faces.map((face) => face.bbox),
        options.dedupeIou,
      ),
      signal,
      tiled,
      discardedFaces: discarded.length,
      replacedFaces,
      indexCalls,
    };
  } catch (error) {
    throw await attempt.fail(error);
  }
}

/** One indexPhoto call: its temporary images, the faces it indexed, and what cleanup failed. */
class IndexAttempt {
  /** Faces this attempt indexed, in the order IndexFaces returned them. */
  private readonly indexedIds: string[] = [];
  private readonly keys = new Set<string>();
  private readonly cleanupErrors: unknown[] = [];
  private untrackedFacesPossible = false;
  readonly jpeg: JpegOptions;

  constructor(
    private readonly deps: IndexPhotoDeps,
    private readonly options: IndexPhotoOptions,
    readonly id: string,
  ) {
    this.jpeg = {
      longEdge: options.longEdge,
      quality: options.jpegQuality,
      maxBytes: Math.min(options.maxBytes, deps.tempStore.maxBytes),
      encode: options.encode,
    };
  }

  async deletePreviousFaces(): Promise<number> {
    const previous = this.options.previousFaceIds ?? [];
    if (previous.length > 0) {
      await this.deps.provider.deleteFaces(this.options.collectionId, previous);
    }
    return previous.length;
  }

  async indexFull(original: Uint8Array) {
    const full = await encodeJpeg(original, this.jpeg);
    return { full, fullResult: await this.indexImage(full.bytes, 'full') };
  }

  /**
   * Indexes one image through a temporary object and deletes the object again. A failed delete
   * fails the attempt even when IndexFaces succeeded: the object is a copy of an event photo, and
   * the `tmp/` lifecycle rule is only a backstop.
   */
  async indexImage(bytes: Uint8Array, part: IndexTempPart): Promise<IndexFacesResult> {
    const key = this.tempKey(part);
    let outcome: { result: IndexFacesResult } | { error: unknown };
    try {
      const image = await this.deps.tempStore.put(key, bytes);
      const result = await this.deps.provider.indexFaces({
        collectionId: this.options.collectionId,
        image,
        externalImageId: this.options.fileId,
        maxFaces: this.options.maxFaces,
        qualityFilter: this.options.qualityFilter,
      });
      this.indexedIds.push(...result.faces.map((face) => face.faceId));
      outcome = { result };
    } catch (error) {
      if (error instanceof IndexFacesOutcomeUnknownError) this.untrackedFacesPossible = true;
      outcome = { error };
    }
    // Also after a failed put: the object may have been written before the error.
    try {
      await this.deps.tempStore.delete(key);
    } catch (deleteError) {
      const cleanupError = new TempImageCleanupError(key, deleteError);
      if ('result' in outcome) throw cleanupError;
      this.cleanupErrors.push(cleanupError);
    }
    if ('error' in outcome) throw outcome.error;
    return outcome.result;
  }

  /** Deletes what this attempt indexed and describes what is left behind. */
  async fail(cause: unknown): Promise<IndexPhotoError> {
    let orphanFaceIds: string[] = [];
    if (this.indexedIds.length > 0) {
      try {
        await this.deps.provider.deleteFaces(this.options.collectionId, this.indexedIds);
      } catch (deleteError) {
        // Some may be gone already (e.g. discarded tile faces); deleting them again is a no-op.
        orphanFaceIds = [...this.indexedIds];
        this.cleanupErrors.push(deleteError);
      }
    }
    return new IndexPhotoError(
      {
        collectionId: this.options.collectionId,
        fileId: this.options.fileId,
        attemptId: this.id,
        orphanFaceIds,
        untrackedFacesPossible: this.untrackedFacesPossible,
        cleanupErrors: this.cleanupErrors,
      },
      cause,
    );
  }

  private tempKey(part: IndexTempPart): string {
    const key = this.deps.tempKey({ fileId: this.options.fileId, attemptId: this.id, part });
    // Shared keys let concurrent attempts delete each other's images.
    if (!key.includes(this.id) || this.keys.has(key)) {
      throw new Error(`tempKey must give every attempt and part its own key, got ${key}`);
    }
    this.keys.add(key);
    return key;
  }
}
