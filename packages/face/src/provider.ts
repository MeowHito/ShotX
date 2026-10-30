import { ErrorCode, REKOGNITION_INLINE_IMAGE_MAX_BYTES } from '@shotx/shared';
import type { FaceMatch, ImageInput, IndexFacesResult, ListedFace, QualityFilter } from './types';

/**
 * Rekognition API limits. Every image goes to Rekognition as `Image.Bytes` (ADR 0008 section 5),
 * whose limit is 5 MiB (5,242,880 bytes); packages/shared calls the same number
 * REKOGNITION_INLINE_IMAGE_MAX_BYTES and caps FACE_INDEX_MAX_BYTES with it.
 */
export const REKOGNITION_INLINE_MAX_BYTES: number = REKOGNITION_INLINE_IMAGE_MAX_BYTES;
export const REKOGNITION_MAX_SEARCH_FACES = 4096;
export const REKOGNITION_DELETE_FACES_BATCH = 4096;

/**
 * Rekognition's UnindexedFaces reasons for faces skipped as too small or beyond MaxFaces. The
 * self-hosted provider reports the same names, so `signal` tiling reads both alike.
 */
export const SMALL_BOUNDING_BOX = 'SMALL_BOUNDING_BOX';
export const EXCEEDS_MAX_FACES = 'EXCEEDS_MAX_FACES';
export const REKOGNITION_LIST_FACES_MAX_RESULTS = 4096;

export interface IndexFacesRequest {
  collectionId: string;
  /** The encoded photo or tile, at most REKOGNITION_INLINE_MAX_BYTES. It stays in memory. */
  image: ImageInput;
  externalImageId: string;
  maxFaces: number;
  qualityFilter: QualityFilter;
}

export interface SearchByImageRequest {
  collectionId: string;
  /**
   * Selfie bytes, at most REKOGNITION_INLINE_MAX_BYTES. They stay in memory: selfies are never
   * persisted.
   */
  image: Uint8Array;
  threshold: number;
  maxFaces: number;
  qualityFilter: QualityFilter;
}

export interface SearchByFaceRequest {
  collectionId: string;
  faceId: string;
  threshold: number;
  maxFaces: number;
}

export interface ListFacesRequest {
  collectionId: string;
  /** Page size, 1 to REKOGNITION_LIST_FACES_MAX_RESULTS. */
  maxResults: number;
  /** The previous page's `nextToken`; omit for the first page. */
  nextToken?: string | undefined;
}

export interface ListFacesPage {
  faces: ListedFace[];
  /** Set when more faces follow. Pages may repeat or miss faces indexed or deleted meanwhile. */
  nextToken?: string | undefined;
}

/**
 * Face recognition backend: SelfHostedFaceProvider (ADR 0009) or RekognitionFaceProvider; tests
 * use the fake in `./testing`. A production model needs a commercial licence approved by ADR.
 */
export interface FaceProvider {
  /** Creates the collection if it doesn't exist. */
  createCollection(collectionId: string): Promise<{ faceModelVersion?: string | undefined }>;
  /** Deletes the collection if it exists. */
  deleteCollection(collectionId: string): Promise<void>;
  /**
   * Adds the faces in the image to the collection. Not idempotent: every successful call adds new
   * faces. Throws IndexFacesOutcomeUnknownError when the call may have added faces although no
   * result came back; any other error means it added none. An image larger than the provider
   * accepts fails with ImageTooLargeError before anything is sent.
   */
  indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult>;
  /** Searches with the largest face in the image. Throws NoFaceDetectedError when there is none. */
  searchFacesByImage(request: SearchByImageRequest): Promise<FaceMatch[]>;
  /** Searches with an indexed face. The face itself is not part of the result. */
  searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]>;
  /** Deletes faces. Ids that are not in the collection are ignored, so retrying is safe. */
  deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void>;
  /** One page of the faces in the collection, for finding faces no `faces` row tracks. */
  listFaces(request: ListFacesRequest): Promise<ListFacesPage>;
}

/**
 * The image is larger than the provider accepts (REKOGNITION_INLINE_MAX_BYTES for Rekognition).
 * Raised before the request is sent, so nothing was done and no rate-limit token was used.
 * `encodeJpeg` with FaceConfig's limits never produces such an image.
 */
export class ImageTooLargeError extends RangeError {
  constructor(
    readonly bytes: number,
    readonly maxBytes: number,
  ) {
    super(`Image of ${bytes} bytes is larger than the ${maxBytes} bytes the face provider accepts`);
    this.name = 'ImageTooLargeError';
  }
}

export class NoFaceDetectedError extends Error {
  readonly code = ErrorCode.NO_FACE_DETECTED;

  constructor() {
    super('No face detected in the image');
    this.name = 'NoFaceDetectedError';
  }
}

/**
 * IndexFaces failed after the request may have reached the service (a 5xx, a timeout, a dropped
 * connection), so faces may have been added whose ids never came back. Retrying would index them
 * a second time. Only listing the collection finds them: see `reconcileCollection`.
 */
export class IndexFacesOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super(
      `IndexFaces may have indexed faces without returning them: ${
        cause instanceof Error ? cause.name : String(cause)
      }`,
      { cause },
    );
    this.name = 'IndexFacesOutcomeUnknownError';
  }
}
