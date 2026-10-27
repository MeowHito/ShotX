export type { FaceThresholds, QualityFilter } from '@shotx/shared';

/** A box in ratios of the image's width and height (the Rekognition convention). */
export interface BoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A rectangle in whole pixels. */
export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/**
 * How a provider call passes an image: its bytes, sent as Rekognition's `Image.Bytes` (ADR 0008
 * section 5; the S3Object form is gone with tmp/index/).
 */
export interface ImageInput {
  bytes: Uint8Array;
}

export interface IndexedFace {
  faceId: string;
  bbox: BoundingBox;
  confidence: number;
}

export interface UnindexedFace {
  bbox: BoundingBox;
  reasons: string[];
}

export interface IndexFacesResult {
  faces: IndexedFace[];
  unindexed: UnindexedFace[];
}

export interface FaceMatch {
  faceId: string;
  similarity: number;
  /** The id the face was indexed with, which is always the file id. */
  externalImageId?: string | undefined;
}

/** A face in a collection, as ListFaces returns it. */
export interface ListedFace {
  faceId: string;
  /** The id the face was indexed with, which is always the file id. */
  externalImageId?: string | undefined;
}
