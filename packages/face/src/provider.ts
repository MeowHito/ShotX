import { ErrorCode } from '@shotx/shared';
import type { FaceMatch, ImageInput, IndexFacesResult, QualityFilter } from './types';

/** Rekognition API limits. */
export const REKOGNITION_INLINE_MAX_BYTES = 5 * 1024 * 1024;
export const REKOGNITION_S3_MAX_BYTES = 15 * 1024 * 1024;
export const REKOGNITION_MAX_SEARCH_FACES = 4096;
export const REKOGNITION_DELETE_FACES_BATCH = 4096;

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

/**
 * Face recognition backend. Production uses Rekognition; tests use the fake in `./testing`.
 * Another backend needs a commercially licensed model approved by ADR.
 */
export interface FaceProvider {
  /** Creates the collection if it doesn't exist. */
  createCollection(collectionId: string): Promise<{ faceModelVersion?: string | undefined }>;
  /** Deletes the collection if it exists. */
  deleteCollection(collectionId: string): Promise<void>;
  indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult>;
  /** Searches with the largest face in the image. Throws NoFaceDetectedError when there is none. */
  searchFacesByImage(request: SearchByImageRequest): Promise<FaceMatch[]>;
  /** Searches with an indexed face. The face itself is not part of the result. */
  searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]>;
  deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void>;
}

export class NoFaceDetectedError extends Error {
  readonly code = ErrorCode.NO_FACE_DETECTED;

  constructor() {
    super('No face detected in the image');
    this.name = 'NoFaceDetectedError';
  }
}
