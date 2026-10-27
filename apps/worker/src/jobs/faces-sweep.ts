import { faceDeletions, files, folders } from '@shotx/db';
import {
  FACE_DELETION_ALERT_EVENT,
  serializeQueueMessage,
  UPLOAD_FILE_TYPES,
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
  /** Covered, never-indexed files without a mark: marked and sent `index.file` (first send). */
  filesCovered: number;
  /** False with FACE_SEARCH_ENABLED=false: only deletions were re-sent, every mark was kept. */
  indexing: boolean;
  complete: boolean;
}

/** An open deletion this old is an alert (SCHEDULED_JOB_TYPES `faces.sweep`: "older than a day"). */
export const FACE_DELETION_OVERDUE_SECONDS = 86_400;

/** Ids per error log line for the operator (the count is always complete). */
const MAX_LOGGED_IDS = 20;

type Settings = WorkerSweepSettings['faces'];

const IMAGE_MIMES = UPLOAD_FILE_TYPES.filter((t) => t.kind === 'image').map((t) => t.mime);

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
 * The predicate of `files_unindexed_ready_idx` (migration 0007), repeated exactly so the planner
 * can use the partial index: ready, never indexed, no `index.file` outstanding, not trashed.
 */
const UNINDEXED_READY = sql`"f"."status" = 'ready' AND "f"."face_count" IS NULL AND "f"."faces_queued_at" IS NULL AND "f"."deleted_at" IS NULL`;

/**
 * Coverage scan: ready photos that an active face index covers but that never got an outbox mark
 * (rows from before migration 0006, a lost fan-out). Driven from the active index folders
 * (folders_face_index_owner_idx), through their subtrees (`path <@`, GiST) to the files of each
 * folder (files_unindexed_ready_idx), keyset-paginated by (folder_id, id). Each page is marked in a
 * guarded UPDATE (`faces_queued_at IS NULL`) before its `index.file` jobs are sent; a first send,
 * so `faces_requeues` is not bumped. At most FACES_SWEEP_BATCH_SIZE files per run.
 */
async function scanCoverage(ctx: JobContext, settings: Settings): Promise<number> {
  let cursor = {
    folderId: '00000000-0000-0000-0000-000000000000',
    id: '00000000-0000-0000-0000-000000000000',
  };
  let sent = 0;
  while (sent < settings.batchSize && mayContinue(ctx)) {
    const limit = Math.min(ctx.batchSize, settings.batchSize - sent);
    const page = await rows<{ id: string; folder_id: string }>(
      ctx.db,
      sql`SELECT DISTINCT "f"."folder_id", "f"."id"
        FROM ${folders} AS "a"
        JOIN ${folders} AS "fo" ON "fo"."owner_id" = "a"."owner_id" AND "fo"."path" <@ "a"."path"
        JOIN ${files} AS "f" ON "f"."folder_id" = "fo"."id" AND "f"."owner_id" = "fo"."owner_id"
        WHERE "a"."face_index_enabled"
          AND "a"."face_index_expires_at" > now()
          AND "a"."deleted_at" IS NULL
          AND ${UNINDEXED_READY}
          AND "f"."purge_requested_at" IS NULL
          AND "f"."mime" IN (${sql.join(
            IMAGE_MIMES.map((m) => sql`${m}`),
            sql`, `,
          )})
          AND "f"."created_at" < now() - make_interval(secs => ${settings.indexAgeSeconds})
          AND ("f"."folder_id", "f"."id") > (${cursor.folderId}::uuid, ${cursor.id}::uuid)
        ORDER BY "f"."folder_id", "f"."id"
        LIMIT ${limit}`,
    );
    if (page.length === 0) break;
    const last = page.at(-1)!;
    cursor = { folderId: last.folder_id, id: last.id };
    const marked = await rows<{ id: string }>(
      ctx.db,
      sql`UPDATE ${files} AS "f" SET "faces_queued_at" = now()
        WHERE "f"."id" IN (${sql.join(
          page.map((r) => sql`${r.id}::uuid`),
          sql`, `,
        )})
          AND ${UNINDEXED_READY}
        RETURNING "f"."id"`,
    );
    if (marked.length > 0) {
      await ctx.queues.sendMessages(
        ctx.destinations.faces,
        marked.map((f) => serializeQueueMessage('faces', { type: 'index.file', fileId: f.id })),
      );
      ctx.log.info('coverage scan queued never-marked photos for indexing', {
        files: marked.length,
      });
    }
    sent += marked.length;
    if (page.length < limit) break;
  }
  return sent;
}

/**
 * `faces.sweep` (ADR 0008 section 3, "Lost jobs"): re-sends lost faces work, deletions first and
 * whatever FACE_SEARCH_ENABLED says (PDPA). With face search off nothing is indexed, so no
 * `index.file` / `index.folder` is sent and no coverage scan runs: the marks are kept (not bumped
 * towards the cap) and re-sent once it is back on. See SCHEDULED_JOB_TYPES in @shotx/shared.
 * Idempotent: the faces consumer tolerates duplicates of every job.
 */
export async function runFacesSweep(
  ctx: JobContext,
  settings: Settings,
  options: { faceSearch: boolean },
): Promise<FacesSweepResult> {
  mayContinue(ctx);
  const deletions = await resendDeletions(ctx, settings);
  const indexing = options.faceSearch;
  const fileMarks =
    indexing && mayContinue(ctx) ? await requeueFiles(ctx, settings) : { requeued: 0, overCap: 0 };
  const folderMarks =
    indexing && mayContinue(ctx)
      ? await requeueFolders(ctx, settings)
      : { requeued: 0, cleared: 0 };
  const filesCovered = indexing && mayContinue(ctx) ? await scanCoverage(ctx, settings) : 0;
  return {
    deletionsResent: deletions.resent,
    deletionsOverdue: deletions.overdue,
    filesRequeued: fileMarks.requeued,
    filesOverCap: fileMarks.overCap,
    foldersRequeued: folderMarks.requeued,
    foldersCleared: folderMarks.cleared,
    filesCovered,
    indexing,
    complete: ctx.now() < ctx.deadline,
  };
}
