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

/** How a provider call references an image: inline bytes or an S3 object in the same region. */
export type ImageInput = { bytes: Uint8Array } | { s3: { bucket: string; key: string } };

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
