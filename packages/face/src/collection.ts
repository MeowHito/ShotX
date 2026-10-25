/** Rekognition CollectionId rules: 1–255 characters from `[a-zA-Z0-9_.-]`. */
const COLLECTION_ID = /^[a-zA-Z0-9_.-]{1,255}$/;

export function isValidCollectionId(collectionId: string): boolean {
  return COLLECTION_ID.test(collectionId);
}

/**
 * The photographer's Rekognition collection, `pg-{photographerId}` (ADR 0001). Pass an id the
 * server resolved (the file's or share's `owner_id`), never one sent by the client: a wrong id
 * searches or indexes another photographer's faces.
 */
export function faceCollectionId(photographerId: string): string {
  const collectionId = `pg-${photographerId}`;
  if (photographerId.length === 0 || !isValidCollectionId(collectionId)) {
    throw new RangeError(
      `Photographer id ${JSON.stringify(photographerId)} does not make a valid Rekognition collection id`,
    );
  }
  return collectionId;
}
