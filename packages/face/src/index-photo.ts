import { randomUUID } from 'node:crypto';
import type { FaceConfig, TilingMode } from '@shotx/shared';
import { countDistinct, tileBoxToImage, tileRects, touchesInnerEdge } from './geometry';
import {
  type EncodedImage,
  type EncodeOptions,
  encodeJpeg,
  type JpegOptions,
  orientedSize,
} from './image';
import {
  EXCEEDS_MAX_FACES,
  type FaceProvider,
  ImageTooLargeError,
  IndexFacesOutcomeUnknownError,
  REKOGNITION_INLINE_MAX_BYTES,
  SMALL_BOUNDING_BOX,
} from './provider';
import type { IndexedFace, IndexFacesResult, QualityFilter } from './types';

// Defined once in packages/shared (FACE_INDEX_TILING); re-exported so `@shotx/face` keeps them.
export { TILING_MODES, type TilingMode } from '@shotx/shared';

/** Rekognition reasons meaning faces were skipped for being small or too many. */
const TILE_REASONS = new Set([SMALL_BOUNDING_BOX, EXCEEDS_MAX_FACES]);

/** Cheap local face detector (e.g. OpenCV YuNet) that decides whether small faces need tiles. */
export interface SmallFaceDetector {
  /** Widths of the faces in the image, as ratios of the image width. */
  faceWidths(image: EncodedImage): Promise<number[]>;
}

export interface IndexPhotoDeps {
  provider: FaceProvider;
  smallFaceDetector?: SmallFaceDetector | undefined;
  /**
   * A fresh id for every indexPhoto call, for logs and IndexPhotoError. Defaults to a random UUID;
   * tests may pin it.
   */
  newAttemptId?: (() => string) | undefined;
  /**
   * Largest image the provider accepts; `maxBytes` is capped at it. Defaults to
   * REKOGNITION_INLINE_MAX_BYTES (Rekognition `Image.Bytes`). Only the evaluation harness raises
   * it, to replay the old 15 MiB S3 path against FakeFaceProvider; Rekognition itself refuses
   * larger images (ImageTooLargeError).
   */
  maxImageBytes?: number | undefined;
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
  /**
   * Largest encoded image or tile (FACE_INDEX_MAX_BYTES). Images are sent as bytes, so this is
   * capped at the provider's limit (`IndexPhotoDeps.maxImageBytes`).
   */
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

/**
 * What a caller decides per photo; everything else, tiling included (`FACE_INDEX_TILING`), comes
 * from FaceConfig. The evaluation harness varies pipeline options by overriding fields of the
 * returned options, not through the target.
 */
export interface IndexPhotoTarget {
  collectionId: string;
  fileId: string;
  previousFaceIds?: readonly string[] | undefined;
}

export function indexPhotoOptions(config: FaceConfig, target: IndexPhotoTarget): IndexPhotoOptions {
  const { index } = config;
  return {
    collectionId: target.collectionId,
    fileId: target.fileId,
    previousFaceIds: target.previousFaceIds,
    longEdge: index.longEdge,
    jpegQuality: index.jpegQuality,
    maxBytes: index.maxBytes,
    maxFaces: index.maxFaces,
    qualityFilter: index.qualityFilter,
    tiling: index.tiling,
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

/** One image sent to IndexFaces: the full photo or a tile, as encoded. */
export interface IndexImage {
  /** Index of the tile, or null for the full image. */
  tile: number | null;
  /** Encoded size; never more than the attempt's byte limit. */
  bytes: number;
  width: number;
  height: number;
  /** JPEG quality used; below FACE_INDEX_JPEG_QUALITY when the image had to fit the limit. */
  quality: number;
  /** The long edge had to shrink below FACE_INDEX_LONG_EDGE (or the tile size) to fit. */
  downscaled: boolean;
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
  /** Every image sent to IndexFaces, in call order: the full image, then the tiles. */
  images: IndexImage[];
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
 * - `cleanupErrors`: every cleanup step that failed after `cause` (DeleteFaces).
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
 * Every image (the full photo and each tile) is encoded in memory under `maxBytes`, capped at the
 * provider's limit (5 MiB for Rekognition `Image.Bytes`), and sent as bytes: nothing is written to
 * storage. Each call is a new attempt with its own id, which IndexPhotoError reports.
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
        const result = await attempt.indexImage(tile, i);
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
      images: attempt.images,
    };
  } catch (error) {
    throw await attempt.fail(error);
  }
}

/** One indexPhoto call: the images it sent, the faces it indexed, and what cleanup failed. */
class IndexAttempt {
  /** Faces this attempt indexed, in the order IndexFaces returned them. */
  private readonly indexedIds: string[] = [];
  readonly images: IndexImage[] = [];
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
      maxBytes: Math.min(options.maxBytes, deps.maxImageBytes ?? REKOGNITION_INLINE_MAX_BYTES),
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
    return { full, fullResult: await this.indexImage(full, null) };
  }

  /** Sends one encoded image (the full photo, or tile `tile`) to IndexFaces as bytes. */
  async indexImage(image: EncodedImage, tile: number | null): Promise<IndexFacesResult> {
    // encodeJpeg guarantees this; checked again because the bytes go straight to the provider.
    if (image.bytes.length > this.jpeg.maxBytes) {
      throw new ImageTooLargeError(image.bytes.length, this.jpeg.maxBytes);
    }
    this.images.push({
      tile,
      bytes: image.bytes.length,
      width: image.width,
      height: image.height,
      quality: image.quality,
      downscaled: image.downscaled,
    });
    try {
      const result = await this.deps.provider.indexFaces({
        collectionId: this.options.collectionId,
        image: { bytes: image.bytes },
        externalImageId: this.options.fileId,
        maxFaces: this.options.maxFaces,
        qualityFilter: this.options.qualityFilter,
      });
      this.indexedIds.push(...result.faces.map((face) => face.faceId));
      return result;
    } catch (error) {
      if (error instanceof IndexFacesOutcomeUnknownError) this.untrackedFacesPossible = true;
      throw error;
    }
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
}
