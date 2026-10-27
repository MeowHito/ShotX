import { files, folders } from '@shotx/db';
import { parseQueueMessage, serializeQueueMessage } from '@shotx/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
      // As text: compared back exactly (microseconds) when the mark is cleared.
      queuedAt: sql<string | null>`${folders.faceIndexQueuedAt}::text`,
    })
    .from(folders)
    .where(eq(folders.id, folderId));
  return folder ?? null;
}

/**
 * `index.folder`: one `index.file` per ready, unindexed photo the folder subtree's face index
 * covers. Each batch sets the files' outbox marks (`faces_queued_at`) before it is sent, so a lost
 * message is re-sent by faces.sweep. Duplicates are harmless (index.file skips indexed files), so a
 * retry may resend. When the fan-out is done (or there is nothing to do) the folder's own mark
 * (`face_index_queued_at`, set by the API) is cleared, unless it changed meanwhile, or face search
 * is off (FACE_SEARCH_ENABLED=false: the job is acknowledged and the mark kept).
 */
async function indexFolder(
  deps: FacesDeps,
  folderId: string,
  log: Logger,
  mayContinue: () => boolean,
): Promise<void> {
  const folder = await loadFolder(deps, folderId);
  if (!deps.features.faceSearch) {
    log.info('face search is disabled; index job acknowledged without indexing');
  } else if (folder === null || folder.deletedAt !== null) {
    log.info('folder is gone or trashed; nothing to index');
  } else {
    let cursor = '00000000-0000-0000-0000-000000000000';
    let queued = 0;
    for (;;) {
      if (!mayContinue()) {
        throw new FacesJobIncompleteError(
          `index.folder queued ${queued} files before its deadline`,
        );
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
      await deps.db
        .update(files)
        .set({ facesQueuedAt: sql`now()` })
        .where(inArray(files.id, ids));
      await deps.queues.sendMessages(
        deps.facesQueueUrl,
        ids.map((fileId) => serializeQueueMessage('faces', { type: 'index.file', fileId })),
      );
      queued += ids.length;
    }
    log.info('folder indexing fanned out', { folderId, files: queued });
  }
  // While FACE_SEARCH_ENABLED is false nothing was fanned out: the mark stays, and faces.sweep
  // re-sends it once indexing is back on.
  if (deps.features.faceSearch && folder?.queuedAt != null) {
    await deps.db
      .update(folders)
      .set({ faceIndexQueuedAt: null })
      .where(
        and(
          eq(folders.id, folderId),
          sql`${folders.faceIndexQueuedAt} = ${folder.queuedAt}::timestamptz`,
        ),
      );
  }
}

/** The `index.file` outbox mark of a file, as text (null: none, or no such file). */
async function fileMark(deps: FacesDeps, fileId: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ queuedAt: sql<string | null>`${files.facesQueuedAt}::text` })
    .from(files)
    .where(eq(files.id, fileId));
  return row?.queuedAt ?? null;
}

/**
 * Clears the mark read when the job started, with its requeue counter; a mark set meanwhile (a
 * newer send) stays for the job that send started.
 */
async function clearFileMark(deps: FacesDeps, fileId: string, mark: string): Promise<void> {
  await deps.db
    .update(files)
    .set({ facesQueuedAt: null, facesRequeues: 0 })
    .where(and(eq(files.id, fileId), sql`${files.facesQueuedAt} = ${mark}::timestamptz`));
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
        const mark = await fileMark(deps, job.fileId);
        const outcome = await indexFile(deps, job.fileId, log, signal);
        // The job ended (any outcome but flag-off, which indexed nothing: that mark stays for
        // faces.sweep to re-send when indexing is back on; a throw keeps it for a retry).
        if (mark !== null && outcome !== 'flag-off') await clearFileMark(deps, job.fileId, mark);
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
