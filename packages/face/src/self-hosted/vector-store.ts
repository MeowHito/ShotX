import { cosine } from './embed';

export interface StoredFace {
  faceId: string;
  externalImageId: string;
  embedding: Float32Array;
}

export interface VectorMatch {
  faceId: string;
  externalImageId: string;
  /** Cosine similarity of the unit embeddings, −1 to 1. */
  cosine: number;
}

export interface VectorQuery {
  collectionId: string;
  model: string;
  embedding: Float32Array;
  /** Nearest faces considered, at most. */
  limit: number;
  /** Only faces at or above this cosine. */
  minCosine: number;
  /** Leaves this face out (searching with a stored face). */
  excludeFaceId?: string | undefined;
}

/**
 * Where the self-hosted provider keeps a collection's embeddings (ADR 0009 section 4).
 * Production: PgFaceVectorStore (pgvector). Tests and face-eval: InMemoryFaceVectorStore.
 */
export interface FaceVectorStore {
  /** Adds faces in one atomic write; none is added when it throws. */
  insert(collectionId: string, model: string, faces: readonly StoredFace[]): Promise<void>;
  /** Best first; HNSW stores may miss a few true neighbours, exact stores never do. */
  search(query: VectorQuery): Promise<VectorMatch[]>;
  /** A stored face's embedding of `model`, or undefined. */
  get(collectionId: string, model: string, faceId: string): Promise<Float32Array | undefined>;
  /** Deletes faces of any model; ids that aren't stored are ignored. */
  delete(collectionId: string, faceIds: readonly string[]): Promise<void>;
  deleteCollection(collectionId: string): Promise<void>;
  /** A page of the collection's faces of every model, by face id; `after` is the last id seen. */
  list(
    collectionId: string,
    limit: number,
    after?: string,
  ): Promise<{ faceId: string; externalImageId: string }[]>;
}

interface MemoryFace extends StoredFace {
  model: string;
}

/** Exact cosine search in memory: unit tests and face-eval, never production. */
export class InMemoryFaceVectorStore implements FaceVectorStore {
  private readonly collections = new Map<string, Map<string, MemoryFace>>();

  private collection(collectionId: string): Map<string, MemoryFace> {
    let faces = this.collections.get(collectionId);
    if (faces === undefined) {
      faces = new Map();
      this.collections.set(collectionId, faces);
    }
    return faces;
  }

  /** Faces stored in every collection. */
  get size(): number {
    let total = 0;
    for (const faces of this.collections.values()) total += faces.size;
    return total;
  }

  insert(collectionId: string, model: string, faces: readonly StoredFace[]): Promise<void> {
    const target = this.collection(collectionId);
    for (const face of faces) {
      if (target.has(face.faceId)) return Promise.reject(new Error('Duplicate face id'));
    }
    for (const face of faces) target.set(face.faceId, { ...face, model });
    return Promise.resolve();
  }

  search(query: VectorQuery): Promise<VectorMatch[]> {
    const matches: VectorMatch[] = [];
    for (const face of this.collections.get(query.collectionId)?.values() ?? []) {
      if (face.model !== query.model || face.faceId === query.excludeFaceId) continue;
      const value = cosine(face.embedding, query.embedding);
      if (value >= query.minCosine) {
        matches.push({ faceId: face.faceId, externalImageId: face.externalImageId, cosine: value });
      }
    }
    matches.sort((a, b) => b.cosine - a.cosine || (a.faceId < b.faceId ? -1 : 1));
    return Promise.resolve(matches.slice(0, query.limit));
  }

  get(collectionId: string, model: string, faceId: string): Promise<Float32Array | undefined> {
    const face = this.collections.get(collectionId)?.get(faceId);
    return Promise.resolve(face?.model === model ? face.embedding : undefined);
  }

  delete(collectionId: string, faceIds: readonly string[]): Promise<void> {
    const faces = this.collections.get(collectionId);
    for (const id of faceIds) faces?.delete(id);
    return Promise.resolve();
  }

  deleteCollection(collectionId: string): Promise<void> {
    this.collections.delete(collectionId);
    return Promise.resolve();
  }

  list(collectionId: string, limit: number, after?: string) {
    const ids = [...(this.collections.get(collectionId)?.values() ?? [])]
      .filter((f) => after === undefined || f.faceId > after)
      .sort((a, b) => (a.faceId < b.faceId ? -1 : 1))
      .slice(0, limit);
    return Promise.resolve(
      ids.map((f) => ({ faceId: f.faceId, externalImageId: f.externalImageId })),
    );
  }
}
