import { faceDeletions, files, folders } from '@shotx/db';
import {
  FACE_DELETION_ALERT_EVENT,
  serializeQueueMessage,
  type WorkerSweepSettings,
} from '@shotx/shared';
import { sql } from 'drizzle-orm';
import { rows } from '../db';
import { type JobContext, mayContinue } from './context';

export interface FacesSweepResult {
  /** `delete.faces` re-sent for open deletions (no cap: PDPA). */
  deletionsResent: number;
  /** Of those, deletions open for more than a day (logged as face_deletion.alert). */
  deletionsOverdue: number;
  /** `index.file` re-sent for outstanding marks. */
  filesRequeued: number;
  /** Outstanding `index.file` marks past FACES_SWEEP_MAX_REQUEUES (left for the operator). */
  filesOverCap: number;
  /** `index.folder` re-sent for outstanding marks of folders with indexing on. */
  foldersRequeued: number;
  /** Stale marks of folders with indexing off or trashed, cleared without a send. */
  foldersCleared: number;
  complete: boolean;
}

/** An open deletion this old is an alert (SCHEDULED_JOB_TYPES `faces.sweep`: "older than a day"). */
export const FACE_DELETION_OVERDUE_SECONDS = 86_400;

/** Ids per error log line for the operator (the count is always complete). */
const MAX_LOGGED_IDS = 20;

type Settings = WorkerSweepSettings['faces'];

/**
 * Open deletions older than FACES_SWEEP_DELETION_AGE_SECONDS: send `delete.faces` again, always
 * (no cap). The deletion row has no mark to bump, so every run re-sends until the faces consumer
 * completes it; the consumer is idempotent.
 */
async function resendDeletions(ctx: JobContext, settings: Settings) {
  const open = await rows<{ id: string; photographer_id: string; age_seconds: number }>(
    ctx.db,
    sql`SELECT ${faceDeletions.id} AS "id", ${faceDeletions.photographerId} AS "photographer_id",
        floor(extract(epoch FROM now() - ${faceDeletions.createdAt}))::int AS "age_seconds"
      FROM ${faceDeletions}
      WHERE ${faceDeletions.completedAt} IS NULL
        AND ${faceDeletions.createdAt} < now() - make_interval(secs => ${settings.deletionAgeSeconds})
      ORDER BY ${faceDeletions.createdAt}
      LIMIT ${settings.batchSize}`,
  );
  if (open.length > 0) {
    await ctx.queues.sendMessages(
      ctx.destinations.faces,
      open.map((d) => serializeQueueMessage('faces', { type: 'delete.faces', deletionId: d.id })),
    );
  }
  const overdue = open.filter((d) => d.age_seconds >= FACE_DELETION_OVERDUE_SECONDS);
  if (overdue.length > 0) {
    // Structured alert (ADR 0007, ADR 0008 section 7): ids and counts only.
    ctx.log.error(FACE_DELETION_ALERT_EVENT, {
      event: FACE_DELETION_ALERT_EVENT,
      reason: 'deletion_overdue',
      count: overdue.length,
      oldestAgeSeconds: Math.max(...overdue.map((d) => d.age_seconds)),
      deletionIds: overdue
        .slice(0, MAX_LOGGED_IDS)
        .map((d) => d.id)
        .join(','),
    });
  }
  return { resent: open.length, overdue: overdue.length };
}

const staleFileMark = (settings: Settings) => sql`
  ${files.facesQueuedAt} IS NOT NULL
  AND ${files.facesQueuedAt} < now() - make_interval(secs => ${settings.indexAgeSeconds})`;

/**
 * Outstanding `index.file` marks older than FACES_SWEEP_INDEX_AGE_SECONDS below the cap: bump
 * the mark and the counter in one guarded UPDATE, then send. Marks at the cap are logged.
 */
async function requeueFiles(ctx: JobContext, settings: Settings) {
  const below = sql`${files.facesRequeues} < ${settings.maxRequeues}`;
  const updated = await rows<{ id: string }>(
    ctx.db,
    sql`UPDATE ${files}
      SET "faces_queued_at" = now(), "faces_requeues" = ${files.facesRequeues} + 1
      WHERE ${files.id} IN (
          SELECT ${files.id} FROM ${files}
          WHERE ${staleFileMark(settings)} AND ${below}
          ORDER BY ${files.facesQueuedAt}
          LIMIT ${settings.batchSize}
        )
        AND ${staleFileMark(settings)} AND ${below}
      RETURNING ${files.id} AS "id"`,
  );
  if (updated.length > 0) {
    await ctx.queues.sendMessages(
      ctx.destinations.faces,
      updated.map((f) => serializeQueueMessage('faces', { type: 'index.file', fileId: f.id })),
    );
  }
  const stuck = await rows<{ id: string }>(
    ctx.db,
    sql`SELECT ${files.id} AS "id" FROM ${files}
      WHERE ${staleFileMark(settings)} AND ${files.facesRequeues} >= ${settings.maxRequeues}
      ORDER BY ${files.facesQueuedAt}
      LIMIT ${settings.batchSize}`,
  );
  if (stuck.length > 0) {
    ctx.log.error('face indexing never finished after every requeue; the operator must look', {
      count: stuck.length,
      maxRequeues: settings.maxRequeues,
      fileIds: stuck
        .slice(0, MAX_LOGGED_IDS)
        .map((r) => r.id)
        .join(','),
    });
  }
  return { requeued: updated.length, overCap: stuck.length };
}

/**
 * Outstanding `index.folder` marks older than FACES_SWEEP_INDEX_AGE_SECONDS on folders whose face
 * indexing is still on: bump and re-send (no cap: the faces consumer clears the mark whatever the
 * fan-out finds, so only lost jobs stay). A stale mark on a folder with indexing off (the sweep
 * raced the API turning it off, which clears the mark) is cleared, never sent.
 */
async function requeueFolders(
  ctx: JobContext,
  settings: Settings,
): Promise<{ requeued: number; cleared: number }> {
  const stale = sql`${folders.faceIndexQueuedAt} IS NOT NULL
    AND ${folders.faceIndexQueuedAt} < now() - make_interval(secs => ${settings.indexAgeSeconds})`;
  const enabled = sql`${folders.faceIndexEnabled} AND ${folders.deletedAt} IS NULL`;
  const updated = await rows<{ id: string }>(
    ctx.db,
    sql`UPDATE ${folders} SET "face_index_queued_at" = now()
      WHERE ${folders.id} IN (
          SELECT ${folders.id} FROM ${folders} WHERE ${stale} AND ${enabled}
          ORDER BY ${folders.faceIndexQueuedAt} LIMIT ${settings.batchSize}
        )
        AND ${stale} AND ${enabled}
      RETURNING ${folders.id} AS "id"`,
  );
  if (updated.length > 0) {
    await ctx.queues.sendMessages(
      ctx.destinations.faces,
      updated.map((f) => serializeQueueMessage('faces', { type: 'index.folder', folderId: f.id })),
    );
  }
  // Indexing off (or the folder trashed): nothing to fan out; drop the mark.
  const cleared = await rows<{ id: string }>(
    ctx.db,
    sql`UPDATE ${folders} SET "face_index_queued_at" = NULL
      WHERE ${stale} AND NOT (${enabled})
      RETURNING ${folders.id} AS "id"`,
  );
  return { requeued: updated.length, cleared: cleared.length };
}

/**
 * `faces.sweep` (ADR 0008 section 3, "Lost jobs"): re-sends lost faces work. Deletions first and
 * whatever FACE_SEARCH_ENABLED says (PDPA); see SCHEDULED_JOB_TYPES in @shotx/shared for the
 * contract. Idempotent: the faces consumer tolerates duplicates of every job.
 */
export async function runFacesSweep(
  ctx: JobContext,
  settings: Settings,
): Promise<FacesSweepResult> {
  mayContinue(ctx);
  const deletions = await resendDeletions(ctx, settings);
  const fileMarks = mayContinue(ctx)
    ? await requeueFiles(ctx, settings)
    : { requeued: 0, overCap: 0 };
  const folderMarks = mayContinue(ctx)
    ? await requeueFolders(ctx, settings)
    : { requeued: 0, cleared: 0 };
  return {
    deletionsResent: deletions.resent,
    deletionsOverdue: deletions.overdue,
    filesRequeued: fileMarks.requeued,
    filesOverCap: fileMarks.overCap,
    foldersRequeued: folderMarks.requeued,
    foldersCleared: folderMarks.cleared,
    complete: ctx.now() < ctx.deadline,
  };
}
