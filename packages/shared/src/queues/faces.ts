import { z } from 'zod';

/**
 * Index one photo. Sent by the worker after media processing when the file's folder has face
 * indexing enabled. The worker loads the file row and takes the photographer from `owner_id`, so
 * the message carries no owner. It skips files that are no longer ready, are trashed, are videos,
 * or whose folder no longer has face indexing enabled.
 */
export const indexFileJobSchema = z.object({
  type: z.literal('index.file'),
  fileId: z.uuid(),
});

/**
 * Index every ready, unindexed photo in a folder subtree. Sent by the API when a photographer
 * enables face indexing on a folder that already has files; the worker fans out one
 * `index.file` job per photo.
 */
export const indexFolderJobSchema = z.object({
  type: z.literal('index.folder'),
  folderId: z.uuid(),
});

/** Body of a `faces` queue message. */
export const facesQueueMessageSchema = z.discriminatedUnion('type', [
  indexFileJobSchema,
  indexFolderJobSchema,
]);
export type FacesQueueMessage = z.output<typeof facesQueueMessageSchema>;
