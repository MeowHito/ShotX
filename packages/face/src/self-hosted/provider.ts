import { randomUUID } from 'node:crypto';
import {
  type FaceProvider,
  IndexFacesOutcomeUnknownError,
  type IndexFacesRequest,
  type ListFacesPage,
  type ListFacesRequest,
  NoFaceDetectedError,
  REKOGNITION_INLINE_MAX_BYTES,
  ImageTooLargeError,
  type SearchByFaceRequest,
  type SearchByImageRequest,
} from '../provider';
import type { FaceMatch, IndexFacesResult } from '../types';
import { similarityFromCosine } from './embed';
import type { FaceEngine } from './engine';
import type { FaceVectorStore, VectorMatch } from './vector-store';

export interface SelfHostedFaceProviderOptions {
  engine: FaceEngine;
  store: FaceVectorStore;
  /** Fresh face ids; tests may pin them. Defaults to random UUIDs, like Rekognition's FaceIds. */
  newFaceId?: (() => string) | undefined;
  /**
   * Largest image accepted, as for Rekognition (ImageTooLargeError before any work). The encode
   * loop keeps index images under FACE_INDEX_MAX_BYTES, so the same limit holds both providers.
   */
  maxImageBytes?: number | undefined;
}

/**
 * FaceProvider on our own models and Postgres (ADR 0009): detection and embedding by `engine`,
 * collections in `store`. Keeps the Rekognition semantics the rest of the platform relies on:
 * indexFaces adds new face ids every call and reports an uncertain write as
 * IndexFacesOutcomeUnknownError; small and surplus faces come back unindexed with Rekognition's
 * reasons; search images match with their largest face; searchFaces leaves the face itself out;
 * deleting unknown ids is a no-op. Similarity is 100 × cosine.
 */
export class SelfHostedFaceProvider implements FaceProvider {
  private readonly newFaceId: () => string;
  private readonly maxImageBytes: number;

  constructor(private readonly options: SelfHostedFaceProviderOptions) {
    this.newFaceId = options.newFaceId ?? randomUUID;
    this.maxImageBytes = options.maxImageBytes ?? REKOGNITION_INLINE_MAX_BYTES;
  }

  get model(): string {
    return this.options.engine.model;
  }

  /** Collections are just a `collection_id` on the vectors: nothing to create. */
  createCollection(): Promise<{ faceModelVersion?: string | undefined }> {
    return Promise.resolve({ faceModelVersion: this.model });
  }

  deleteCollection(collectionId: string): Promise<void> {
    return this.options.store.deleteCollection(collectionId);
  }

  async indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult> {
    this.assertSize(request.image.bytes);
    // Nothing is stored until the insert below; failures before it added no faces.
    const analysis = await this.options.engine.analyze(request.image.bytes, request.maxFaces);
    const faces = analysis.faces.map((face) => ({ ...face, faceId: this.newFaceId() }));
    try {
      await this.options.store.insert(
        request.collectionId,
        this.model,
        faces.map((f) => ({
          faceId: f.faceId,
          externalImageId: request.externalImageId,
          embedding: f.embedding,
        })),
      );
    } catch (error) {
      // A dropped connection may have committed the insert: same rule as an IndexFaces 5xx.
      throw new IndexFacesOutcomeUnknownError(error);
    }
    return {
      faces: faces.map((f) => ({ faceId: f.faceId, bbox: f.bbox, confidence: f.confidence })),
      unindexed: analysis.unindexed,
    };
  }

  async searchFacesByImage(request: SearchByImageRequest): Promise<FaceMatch[]> {
    this.assertSize(request.image);
    const embedding = await this.options.engine.embedLargest(request.image);
    if (embedding === null) throw new NoFaceDetectedError();
    return this.search(request.collectionId, embedding, request.threshold, request.maxFaces);
  }

  async searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]> {
    const embedding = await this.options.store.get(
      request.collectionId,
      this.model,
      request.faceId,
    );
    if (embedding === undefined) return [];
    return this.search(
      request.collectionId,
      embedding,
      request.threshold,
      request.maxFaces,
      request.faceId,
    );
  }

  deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void> {
    return this.options.store.delete(collectionId, faceIds);
  }

  async listFaces(request: ListFacesRequest): Promise<ListFacesPage> {
    const faces = await this.options.store.list(
      request.collectionId,
      request.maxResults,
      request.nextToken,
    );
    return {
      faces,
      nextToken: faces.length === request.maxResults ? faces.at(-1)?.faceId : undefined,
    };
  }

  private async search(
    collectionId: string,
    embedding: Float32Array,
    threshold: number,
    maxFaces: number,
    excludeFaceId?: string,
  ): Promise<FaceMatch[]> {
    const matches = await this.options.store.search({
      collectionId,
      model: this.model,
      embedding,
      limit: maxFaces,
      minCosine: threshold / 100,
      excludeFaceId,
    });
    return matches.map((m: VectorMatch) => ({
      faceId: m.faceId,
      similarity: similarityFromCosine(m.cosine),
      externalImageId: m.externalImageId,
    }));
  }

  private assertSize(bytes: Uint8Array): void {
    if (bytes.length > this.maxImageBytes) {
      throw new ImageTooLargeError(bytes.length, this.maxImageBytes);
    }
  }
}
