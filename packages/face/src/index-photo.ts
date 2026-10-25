import { countDistinct, tileBoxToImage, tileRects, touchesInnerEdge } from './geometry';
import { type EncodedImage, encodeJpeg, orientedSize } from './image';
import type { FaceProvider } from './provider';
import type { TempImageStore } from './temp-store';
import type { IndexedFace, IndexFacesResult, QualityFilter } from './types';

export const TILING_MODES = ['never', 'signal', 'always'] as const;
export type TilingMode = (typeof TILING_MODES)[number];

/** Rekognition reasons meaning faces were skipped for being small or too many. */
const TILE_REASONS = new Set(['SMALL_BOUNDING_BOX', 'EXCEEDS_MAX_FACES']);

/** Tile faces this close (in tile ratios) to an inner tile edge count as cut off. */
const INNER_EDGE_EPSILON = 0.01;

/** Cheap local face detector (e.g. OpenCV YuNet) that decides whether small faces need tiles. */
export interface SmallFaceDetector {
  /** Widths of the faces in the image, as ratios of the image width. */
  faceWidths(image: EncodedImage): Promise<number[]>;
}

export interface IndexPhotoDeps {
  provider: FaceProvider;
  tempStore: TempImageStore;
  smallFaceDetector?: SmallFaceDetector | undefined;
}

export interface IndexPhotoOptions {
  collectionId: string;
  /** Used as ExternalImageId, so moving or renaming the file never requires re-indexing. */
  fileId: string;
  /** Key prefix for temporary index images, normally `tmp/index/`. */
  tempKeyPrefix: string;
  longEdge: number;
  jpegQuality: number;
  maxBytes: number;
  maxFaces: number;
  qualityFilter: QualityFilter;
  tiling: TilingMode;
  tileGrid: number;
  tileOverlap: number;
  smallFaceRatio: number;
  dedupeIou: number;
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
  /** Faces kept in the collection. Boxes are relative to the oriented original. */
  faces: PhotoFace[];
  /** Distinct faces, after merging the duplicates that overlapping tiles produce. */
  faceCount: number;
  signal: TileSignal;
  tiled: boolean;
  /** Faces cut off at inner tile edges, which were deleted from the collection again. */
  discardedFaces: number;
  indexCalls: number;
}

/**
 * Indexes one photo: the full image first, then overlapping tiles when small faces are likely to
 * have been missed. Every face that stays in the collection is returned, so the caller can record
 * it; on failure, faces indexed by this attempt are deleted again.
 */
export async function indexPhoto(
  deps: IndexPhotoDeps,
  original: Uint8Array,
  options: IndexPhotoOptions,
): Promise<IndexPhotoResult> {
  const indexedIds: string[] = [];
  const jpeg = {
    longEdge: options.longEdge,
    quality: options.jpegQuality,
    maxBytes: Math.min(options.maxBytes, deps.tempStore.maxBytes),
  };
  try {
    const full = await encodeJpeg(original, jpeg);
    const fullResult = await indexImage(deps, options, full.bytes, '');
    indexedIds.push(...fullResult.faces.map((face) => face.faceId));
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
        const tile = await encodeJpeg(original, jpeg, rect);
        const result = await indexImage(deps, options, tile.bytes, `-t${i}`);
        indexCalls++;
        for (const face of result.faces) {
          indexedIds.push(face.faceId);
          if (touchesInnerEdge(face.bbox, rect, size, INNER_EDGE_EPSILON)) {
            discarded.push(face.faceId);
          } else {
            faces.push({ ...face, bbox: tileBoxToImage(face.bbox, rect, size), tile: i });
          }
        }
      }
      if (discarded.length > 0) await deps.provider.deleteFaces(options.collectionId, discarded);
    }

    return {
      faces,
      faceCount: countDistinct(
        faces.map((face) => face.bbox),
        options.dedupeIou,
      ),
      signal,
      tiled,
      discardedFaces: discarded.length,
      indexCalls,
    };
  } catch (error) {
    // Faces without a row that tracks them would survive purges and face-index expiry.
    if (indexedIds.length > 0) {
      await deps.provider.deleteFaces(options.collectionId, indexedIds).catch(() => undefined);
    }
    throw error;
  }
}

async function indexImage(
  deps: IndexPhotoDeps,
  options: IndexPhotoOptions,
  bytes: Uint8Array,
  suffix: string,
): Promise<IndexFacesResult> {
  const key = `${options.tempKeyPrefix}${options.fileId}${suffix}.jpg`;
  const image = await deps.tempStore.put(key, bytes);
  try {
    return await deps.provider.indexFaces({
      collectionId: options.collectionId,
      image,
      externalImageId: options.fileId,
      maxFaces: options.maxFaces,
      qualityFilter: options.qualityFilter,
    });
  } finally {
    // The tmp/ lifecycle rule cleans up after a failed delete.
    await deps.tempStore.delete(key).catch(() => undefined);
  }
}
