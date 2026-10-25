import { ErrorCode } from '@shotx/shared';
import type { FaceMatch, ImageInput, IndexFacesResult, ListedFace, QualityFilter } from './types';

/** Rekognition API limits. */
export const REKOGNITION_INLINE_MAX_BYTES = 5 * 1024 * 1024;
export const REKOGNITION_S3_MAX_BYTES = 15 * 1024 * 1024;
export const REKOGNITION_MAX_SEARCH_FACES = 4096;
export const REKOGNITION_DELETE_FACES_BATCH = 4096;
export const REKOGNITION_LIST_FACES_MAX_RESULTS = 4096;

export interface IndexFacesRequest {
  collectionId: string;
  image: ImageInput;
  externalImageId: string;
  maxFaces: number;
  qualityFilter: QualityFilter;
}

export interface SearchByImageRequest {
  collectionId: string;
  /** Selfie bytes. They stay in memory: selfies are never persisted. */
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
 * Face recognition backend. Production uses Rekognition; tests use the fake in `./testing`.
 * Another backend needs a commercially licensed model approved by ADR.
 */
export interface FaceProvider {
  /** Creates the collection if it doesn't exist. */
  createCollection(collectionId: string): Promise<{ faceModelVersion?: string | undefined }>;
  /** Deletes the collection if it exists. */
  deleteCollection(collectionId: string): Promise<void>;
  /**
   * Adds the faces in the image to the collection. Not idempotent: every successful call adds new
   * faces. Throws IndexFacesOutcomeUnknownError when the call may have added faces although no
   * result came back; any other error means it added none.
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
