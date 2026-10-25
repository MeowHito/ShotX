import { type FaceProvider, REKOGNITION_DELETE_FACES_BATCH } from '@shotx/face';

/**
 * The part of FaceProvider the purge needs (DeleteFaces). Tests pass FakeFaceProvider; Phase 3
 * wires RekognitionFaceProvider (background profile, Redis rate limiters) in main.ts.
 */
export type FaceDeleter = Pick<FaceProvider, 'deleteFaces'>;

export class FaceProviderUnavailableError extends Error {
  override readonly name = 'FaceProviderUnavailableError';
  constructor() {
    super('No face provider is configured in this phase');
  }
}

/**
 * Phase 2 has no face indexing, so no `faces` rows should exist. If some do, the purge keeps those
 * files (faces would otherwise outlive every record of them) and retries in the next run.
 */
export const unavailableFaceDeleter: FaceDeleter = {
  deleteFaces: () => Promise.reject(new FaceProviderUnavailableError()),
};

/** Deletes face ids in DeleteFaces-sized batches. Ids that are already gone are fine. */
export async function deleteFacesInBatches(
  deleter: FaceDeleter,
  collectionId: string,
  faceIds: readonly string[],
): Promise<void> {
  for (let i = 0; i < faceIds.length; i += REKOGNITION_DELETE_FACES_BATCH) {
    await deleter.deleteFaces(collectionId, faceIds.slice(i, i + REKOGNITION_DELETE_FACES_BATCH));
  }
}
