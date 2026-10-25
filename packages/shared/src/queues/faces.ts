import { z } from 'zod';

/**
 * Index one photo. Sent by the worker after media processing when the file's folder has face
 * indexing enabled. The worker loads the file row and takes the photographer from `owner_id`, so
 * the message carries no owner. It skips files that are no longer ready, are trashed, are videos,
 * or that no active face index covers any more (isCoveredByFaceIndex: the file's folder or an
 * ancestor with face indexing enabled and not expired), and every index job while
 * FACE_SEARCH_ENABLED is false.
 */
export const indexFileJobSchema = z.object({
  type: z.literal('index.file'),
  fileId: z.uuid(),
});

/**
 * Index every ready, unindexed photo in a folder subtree. Sent by the API when a photographer
 * enables face indexing on a folder (`PATCH /drive/folders/:id/face-index`) that had no active
 * index; the worker fans out one `index.file` job per photo the subtree's index covers
 * (isCoveredByFaceIndex). Extending an active index sends nothing: it only moves
 * `face_index_expires_at`.
 */
export const indexFolderJobSchema = z.object({
  type: z.literal('index.folder'),
  folderId: z.uuid(),
});

/**
 * Delete the faces of files in a folder subtree that no active face index covers any more. Sent
 * by the API when a photographer turns face indexing off. The worker loads the folder (and its
 * owner) itself, calls DeleteFaces in batches on the owner's collection, then deletes the `faces`
 * rows and sets `files.face_count` to null. Files still covered by another active folder (an
 * ancestor) keep their faces. Idempotent; does nothing if indexing was turned back on meanwhile.
 * `faces.expire.daily` does the same for folders past `face_index_expires_at`.
 */
export const unindexFolderJobSchema = z.object({
  type: z.literal('unindex.folder'),
  folderId: z.uuid(),
});

/**
 * Carry out a "ขอลบใบหน้าของฉัน" request. The API has already, in one transaction, inserted the
 * `face_deletions` row and set `faces.deletion_id` on the matched faces (which hides them from
 * every search at once). The worker loads the faces with that deletion id, calls DeleteFaces on
 * the owner's collection (ids already gone are ignored), deletes the rows, recomputes
 * `face_count` of the affected files from their remaining faces (IoU de-duplication, as in
 * indexing), and sets `face_deletions.faces_deleted` and `completed_at`. Idempotent: a completed
 * deletion is a no-op.
 */
export const deleteFacesJobSchema = z.object({
  type: z.literal('delete.faces'),
  deletionId: z.uuid(),
});

/** Body of a `faces` queue message. No message ever carries face ids, boxes or images. */
export const facesQueueMessageSchema = z.discriminatedUnion('type', [
  indexFileJobSchema,
  indexFolderJobSchema,
  unindexFolderJobSchema,
  deleteFacesJobSchema,
]);
export type FacesQueueMessage = z.output<typeof facesQueueMessageSchema>;
