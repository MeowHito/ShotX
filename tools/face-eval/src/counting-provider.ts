import {
  type FaceMatch,
  type FaceProvider,
  type IndexFacesRequest,
  type IndexFacesResult,
  REKOGNITION_DELETE_FACES_BATCH,
  type SearchByFaceRequest,
  type SearchByImageRequest,
} from '@shotx/face';

export interface CallCounts {
  createCollection: number;
  deleteCollection: number;
  indexFaces: number;
  searchFacesByImage: number;
  searchFaces: number;
  deleteFaces: number;
}

export const emptyCounts = (): CallCounts => ({
  createCollection: 0,
  deleteCollection: 0,
  indexFaces: 0,
  searchFacesByImage: 0,
  searchFaces: 0,
  deleteFaces: 0,
});

export function totalCalls(counts: CallCounts): number {
  return (Object.values(counts) as number[]).reduce((sum, n) => sum + n, 0);
}

/** Counts the Rekognition calls the harness makes. DeleteFaces counts one call per batch. */
export class CountingFaceProvider implements FaceProvider {
  readonly counts = emptyCounts();

  constructor(private readonly inner: FaceProvider) {}

  createCollection(collectionId: string) {
    this.counts.createCollection++;
    return this.inner.createCollection(collectionId);
  }

  deleteCollection(collectionId: string): Promise<void> {
    this.counts.deleteCollection++;
    return this.inner.deleteCollection(collectionId);
  }

  indexFaces(request: IndexFacesRequest): Promise<IndexFacesResult> {
    this.counts.indexFaces++;
    return this.inner.indexFaces(request);
  }

  searchFacesByImage(request: SearchByImageRequest): Promise<FaceMatch[]> {
    this.counts.searchFacesByImage++;
    return this.inner.searchFacesByImage(request);
  }

  searchFaces(request: SearchByFaceRequest): Promise<FaceMatch[]> {
    this.counts.searchFaces++;
    return this.inner.searchFaces(request);
  }

  deleteFaces(collectionId: string, faceIds: readonly string[]): Promise<void> {
    this.counts.deleteFaces += Math.ceil(faceIds.length / REKOGNITION_DELETE_FACES_BATCH);
    return this.inner.deleteFaces(collectionId, faceIds);
  }

  snapshot(): CallCounts {
    return { ...this.counts };
  }
}

export function diffCounts(after: CallCounts, before: CallCounts): CallCounts {
  const out = emptyCounts();
  for (const key of Object.keys(out) as Array<keyof CallCounts>)
    out[key] = after[key] - before[key];
  return out;
}
