import { folders } from '@shotx/db';
import { parseQueueMessage, serializeQueueMessage } from '@shotx/shared';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from '../logger';
import type { MessageHandler } from '../sqs/consumer';
import { deleteRequestedFaces } from './delete-faces';
import type { FacesDeps } from './deps';
import { indexFile, unindexedPhotosInSubtree } from './index-file';
import { deleteUncoveredFaces } from './uncovered';

/** The faces consumer could not finish within its budget; the retry continues where it stopped. */
export class FacesJobIncompleteError extends Error {
  override readonly name = 'FacesJobIncompleteError';
}

async function loadFolder(deps: FacesDeps, folderId: string) {
  const [folder] = await deps.db
    .select({
      ownerId: folders.ownerId,
      path: sql<string>`${folders.path}::text`,
      deletedAt: folders.deletedAt,
    })
    .from(folders)
    .where(eq(folders.id, folderId));
  return folder ?? null;
}

/**
 * `index.folder`: one `index.file` per ready, unindexed photo the folder subtree's face index
 * covers. Duplicates are harmless (index.file skips indexed files), so a retry may resend.
 */
async function indexFolder(
  deps: FacesDeps,
  folderId: string,
  log: Logger,
  mayContinue: () => boolean,
): Promise<void> {
  if (!deps.features.faceSearch) {
    log.info('face search is disabled; index job acknowledged without indexing');
    return;
  }
  const folder = await loadFolder(deps, folderId);
  if (folder === null || folder.deletedAt !== null) {
    log.info('folder is gone or trashed; nothing to index');
    return;
  }
  let cursor = '00000000-0000-0000-0000-000000000000';
  let queued = 0;
  for (;;) {
    if (!mayContinue()) {
      throw new FacesJobIncompleteError(`index.folder queued ${queued} files before its deadline`);
    }
    const ids = await unindexedPhotosInSubtree(
      deps.db,
      folder,
      new Date(deps.now()),
      cursor,
      deps.batchSize,
    );
    if (ids.length === 0) break;
    cursor = ids.at(-1)!;
    await deps.queues.sendMessages(
      deps.facesQueueUrl,
      ids.map((fileId) => serializeQueueMessage('faces', { type: 'index.file', fileId })),
    );
    queued += ids.length;
  }
  log.info('folder indexing fanned out', { folderId, files: queued });
}

/**
 * `unindex.folder`: deletes the faces of files in the folder subtree that no active face index
 * covers any more. Always runs (PDPA), whatever FACE_SEARCH_ENABLED says.
 */
async function unindexFolder(
  deps: FacesDeps,
  folderId: string,
  log: Logger,
  mayContinue: () => boolean,
): Promise<void> {
  const folder = await loadFolder(deps, folderId);
  if (folder === null) {
    log.info('folder is gone; its faces went with the purge');
    return;
  }
  const result = await deleteUncoveredFaces(
    {
      db: deps.db,
      faces: deps.provider,
      log,
      now: deps.now,
      batchSize: deps.batchSize,
      mayContinue,
    },
    { ownerId: folder.ownerId, path: folder.path },
  );
  log.info('folder unindexed', { folderId, ...result });
  if (!result.complete || result.facesKept > 0) {
    // Retried with backoff; what was done stays done.
    throw new FacesJobIncompleteError(
      `unindex.folder kept ${result.facesKept} faces (complete: ${result.complete})`,
    );
  }
}

/**
 * Consumer of the `faces` queue: `index.file`, `index.folder`, `unindex.folder` and
 * `delete.faces`. While FACE_SEARCH_ENABLED is false the index jobs are acknowledged without
 * indexing; unindexing and deletions always run.
 *
 * Long jobs keep their message through the consumer's heartbeat (ChangeMessageVisibility every
 * timeout/3, up to SQS's 12 h); WORKER_FACES_MAX_PROCESSING_SECONDS bounds one message, and
 * `checkFacesBudget` (main.ts) warns when it is shorter than the worst-case indexing attempt.
 */
export function createFacesHandler(deps: FacesDeps): MessageHandler {
  return async (body, context) => {
    const job = parseQueueMessage('faces', body);
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(deps.maxProcessingMs)]);
    const mayContinue = () => {
      signal.throwIfAborted();
      return true;
    };
    switch (job.type) {
      case 'index.file': {
        const log = context.log.child({ jobType: job.type, fileId: job.fileId });
        const outcome = await indexFile(deps, job.fileId, log, signal);
        log.info('index job finished', { outcome });
        return;
      }
      case 'index.folder':
        return indexFolder(
          deps,
          job.folderId,
          context.log.child({ jobType: job.type, folderId: job.folderId }),
          mayContinue,
        );
      case 'unindex.folder':
        return unindexFolder(
          deps,
          job.folderId,
          context.log.child({ jobType: job.type, folderId: job.folderId }),
          mayContinue,
        );
      case 'delete.faces': {
        const log = context.log.child({ jobType: job.type, deletionId: job.deletionId });
        const outcome = await deleteRequestedFaces(deps, job.deletionId, log);
        if (outcome !== 'done') log.info('face deletion job finished', { outcome });
        return;
      }
    }
  };
}
