import { type FaceProvider, REKOGNITION_DELETE_FACES_BATCH } from '@shotx/face';

/**
 * The part of FaceProvider that deletes faces (purge, expiry, unindexing, "ขอลบใบหน้าของฉัน").
 * Production passes RekognitionFaceProvider (background profile, Redis rate limiters); tests pass
 * FakeFaceProvider.
 */
export type FaceDeleter = Pick<FaceProvider, 'deleteFaces'>;

/**
 * The photographer's collection doesn't exist (never created, or deleted with the account). Its
 * faces are gone with it, so deleting from it has nothing left to do.
 */
export function isCollectionMissing(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

/**
 * Deletes face ids in DeleteFaces-sized batches. Ids that are already gone are fine, and so is a
 * collection that doesn't exist.
 */
export async function deleteFacesInBatches(
  deleter: FaceDeleter,
  collectionId: string,
  faceIds: readonly string[],
): Promise<void> {
  for (let i = 0; i < faceIds.length; i += REKOGNITION_DELETE_FACES_BATCH) {
    try {
      await deleter.deleteFaces(collectionId, faceIds.slice(i, i + REKOGNITION_DELETE_FACES_BATCH));
    } catch (error) {
      if (isCollectionMissing(error)) return;
      throw error;
    }
  }
}
