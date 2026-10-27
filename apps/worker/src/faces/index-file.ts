import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coveredByFaceIndexSql, faces, files, folders } from '@shotx/db';
import {
  faceCollectionId,
  indexPhoto,
  IndexPhotoError,
  indexPhotoOptions,
  type IndexPhotoResult,
  recordFacesDeadline,
} from '@shotx/face';
import { UPLOAD_FILE_TYPES } from '@shotx/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { rows } from '../db';
import { deleteFacesInBatches } from '../faces';
import { errorFields, type Logger } from '../logger';
import type { FacesDeps } from './deps';

/** What happened to one `index.file` job (logged). */
export type IndexFileOutcome =
  | 'flag-off'
  | 'missing'
  | 'not-indexable'
  | 'not-covered'
  | 'already-indexed'
  | 'deletion-pending'
  | 'indexed'
  | 'superseded';

/** The commit came after `recordFacesDeadline`: the faces were not recorded (README rule 1). */
export class RecordFacesDeadlineError extends Error {
  override readonly name = 'RecordFacesDeadlineError';
  constructor() {
    super('The indexing attempt missed its record-faces deadline; its faces were not recorded');
  }
}

/** The file changed while it was being indexed; the attempt's faces are not recorded. */
class SupersededError extends Error {
  override readonly name = 'SupersededError';
}

const IMAGE_MIMES = UPLOAD_FILE_TYPES.filter((t) => t.kind === 'image').map((t) => t.mime);

export function isIndexableImage(mime: string): boolean {
  return IMAGE_MIMES.includes(mime as (typeof IMAGE_MIMES)[number]);
}

interface FileForIndexing {
  id: string;
  ownerId: string;
  folderId: string | null;
  mime: string;
  s3Key: string;
  status: string;
  deletedAt: Date | null;
  purgeRequestedAt: Date | null;
  faceCount: number | null;
  createdAt: Date;
}

const fileColumns = {
  id: files.id,
  ownerId: files.ownerId,
  folderId: files.folderId,
  mime: files.mime,
  s3Key: files.s3Key,
  status: files.status,
  deletedAt: files.deletedAt,
  purgeRequestedAt: files.purgeRequestedAt,
  faceCount: files.faceCount,
  createdAt: files.createdAt,
};

/** True when an active face index covers the file's folder (the folder or an ancestor). */
async function isCovered(db: FacesDeps['db'], file: FileForIndexing, now: Date): Promise<boolean> {
  if (file.folderId === null) return false;
  const [row] = await rows<{ covered: boolean }>(
    db,
    sql`SELECT ${coveredByFaceIndexSql(sql`"fo"."path"`, file.ownerId, now)} AS "covered"
      FROM "folders" AS "fo"
      WHERE "fo"."id" = ${file.folderId} AND "fo"."owner_id" = ${file.ownerId}`,
  );
  return row?.covered === true;
}

/**
 * `index.file`: indexes one photo into its owner's collection and records the faces.
 *
 * Skips (and acknowledges) while FACE_SEARCH_ENABLED is false, and files that are gone, not ready,
 * trashed, videos, not covered by an active face index, already indexed (`face_count` set: this is
 * how duplicate deliveries end), or that have faces waiting for a "ขอลบใบหน้าของฉัน" deletion.
 * A file with rows but no `face_count` is re-indexed with its rows' faces as `previousFaceIds`.
 *
 * The packages/face README rules hold: `startedAt` is taken before indexPhoto; the rows are
 * replaced in one transaction that re-checks the file under lock and checks
 * `recordFacesDeadline` right before the commit; an IndexPhotoError's `orphanFaceIds` get one more
 * DeleteFaces (else reconciliation finds them) and are never recorded.
 */
export async function indexFile(
  deps: FacesDeps,
  fileId: string,
  log: Logger,
  signal: AbortSignal,
): Promise<IndexFileOutcome> {
  if (!deps.features.faceSearch) {
    log.info('face search is disabled; index job acknowledged without indexing');
    return 'flag-off';
  }
  const { db } = deps;
  const [file] = await db.select(fileColumns).from(files).where(eq(files.id, fileId));
  if (file === undefined) return 'missing';
  if (
    file.status !== 'ready' ||
    file.deletedAt !== null ||
    file.purgeRequestedAt !== null ||
    !isIndexableImage(file.mime)
  ) {
    return 'not-indexable';
  }
  if (file.faceCount !== null) return 'already-indexed';
  if (!(await isCovered(db, file, new Date(deps.now())))) return 'not-covered';

  const existing = await db
    .select({ faceId: faces.rekognitionFaceId, deletionId: faces.deletionId })
    .from(faces)
    .where(and(eq(faces.fileId, file.id), eq(faces.ownerId, file.ownerId)));
  if (existing.some((f) => f.deletionId !== null)) {
    // Re-indexing would bring back faces someone asked to delete; delete.faces runs first.
    return 'deletion-pending';
  }
  const previousFaceIds = existing.map((f) => f.faceId);

  // ADR 0001: the collection comes from the file's owner_id in the database.
  const collectionId = faceCollectionId(file.ownerId);
  await deps.collections.ensure(collectionId);
  signal.throwIfAborted();
  const original = await downloadOriginal(deps, file, signal);

  const startedAt = deps.now(); // before indexPhoto: every face of the attempt comes after it
  let result: IndexPhotoResult;
  try {
    result = await indexPhoto(
      {
        provider: deps.provider,
        newAttemptId: deps.newAttemptId,
      },
      original,
      indexPhotoOptions(deps.face, { collectionId, fileId: file.id, previousFaceIds }),
    );
  } catch (error) {
    if (error instanceof IndexPhotoError) await handleIndexPhotoError(deps, error, log);
    throw error;
  }

  try {
    await recordFaces(deps, file, previousFaceIds, result, startedAt);
  } catch (error) {
    // Not recorded: delete this attempt's faces, or leave them to reconciliation (rule 1).
    await discardFaces(deps, collectionId, result, log);
    if (error instanceof SupersededError) {
      log.info('file changed while indexing; faces discarded', { reason: error.message });
      return 'superseded';
    }
    throw error;
  }
  const degraded = result.images.filter(
    (image) => image.downscaled || image.quality < deps.face.index.jpegQuality,
  );
  log.info('file indexed', {
    faces: result.faces.length,
    // Counts only: how many images had to be squeezed under the 5 MiB Image.Bytes limit.
    images: result.images.length,
    imagesDegraded: degraded.length,
    imagesDownscaled: result.images.filter((image) => image.downscaled).length,
    lowestQuality:
      result.images.length === 0 ? null : Math.min(...result.images.map((i) => i.quality)),
    faceCount: result.faceCount,
    tiled: result.tiled,
    indexCalls: result.indexCalls,
    replacedFaces: result.replacedFaces,
    durationMs: deps.now() - startedAt,
  });
  return 'indexed';
}

async function downloadOriginal(
  deps: FacesDeps,
  file: FileForIndexing,
  signal: AbortSignal,
): Promise<Buffer> {
  const dir = await mkdtemp(join(deps.tmpDir ?? tmpdir(), `faces-${file.id}-`));
  try {
    const path = join(dir, 'original');
    await deps.store.download(file.s3Key, path, signal);
    return await readFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Replaces the file's faces rows with the attempt's faces and sets face_count, in one transaction:
 * the file is locked and checked again (still ready, live, covered, and its rows still the ones
 * this attempt replaced), the covering folders' expiry moves to last upload +
 * FACE_INDEX_EXPIRY_DAYS, and the record-faces deadline is checked last, right before the commit.
 */
async function recordFaces(
  deps: FacesDeps,
  file: FileForIndexing,
  previousFaceIds: readonly string[],
  result: IndexPhotoResult,
  startedAt: number,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select(fileColumns)
      .from(files)
      .where(eq(files.id, file.id))
      .for('update');
    if (
      current === undefined ||
      current.status !== 'ready' ||
      current.deletedAt !== null ||
      current.purgeRequestedAt !== null
    ) {
      throw new SupersededError('file is gone, trashed or no longer ready');
    }
    const now = new Date(deps.now());
    if (!(await isCovered(tx, current, now))) {
      throw new SupersededError('no active face index covers the file any more');
    }
    const rowsNow = await tx
      .select({ faceId: faces.rekognitionFaceId })
      .from(faces)
      .where(eq(faces.fileId, file.id));
    const expected = new Set(previousFaceIds);
    if (
      current.faceCount !== null ||
      rowsNow.length !== expected.size ||
      rowsNow.some((r) => !expected.has(r.faceId))
    ) {
      throw new SupersededError('another attempt indexed the file');
    }
    if (previousFaceIds.length > 0) {
      await tx
        .delete(faces)
        .where(
          and(eq(faces.fileId, file.id), inArray(faces.rekognitionFaceId, [...previousFaceIds])),
        );
    }
    if (result.faces.length > 0) {
      await tx.insert(faces).values(
        result.faces.map((face) => ({
          fileId: file.id,
          ownerId: file.ownerId,
          rekognitionFaceId: face.faceId,
          bbox: face.bbox,
          confidence: Math.min(100, Math.max(0, face.confidence)),
        })),
      );
    }
    await tx.update(files).set({ faceCount: result.faceCount }).where(eq(files.id, file.id));
    await extendCoveringFolders(tx, current, deps.retention.faceIndexExpiryDays, now);
    if (deps.now() > recordFacesDeadline(startedAt, deps.face.index.orphanGraceMs)) {
      throw new RecordFacesDeadlineError(); // rolls the transaction back
    }
  });
}

/**
 * Moves `face_index_expires_at` of the active indexes covering the file to at least its upload
 * time + FACE_INDEX_EXPIRY_DAYS (spec: last upload + 90 days). Never shortens an expiry and never
 * revives an expired or disabled index.
 */
async function extendCoveringFolders(
  tx: FacesDeps['db'],
  file: FileForIndexing,
  expiryDays: number,
  now: Date,
): Promise<void> {
  if (file.folderId === null) return;
  await tx.execute(sql`
    UPDATE ${folders} SET "face_index_expires_at" = GREATEST(
      "face_index_expires_at",
      ${file.createdAt.toISOString()}::timestamptz + make_interval(days => ${expiryDays})
    )
    WHERE "owner_id" = ${file.ownerId}
      AND "face_index_enabled"
      AND "deleted_at" IS NULL
      AND "face_index_expires_at" > ${now.toISOString()}::timestamptz
      AND "path" @> (SELECT "path" FROM ${folders} WHERE "id" = ${file.folderId})`);
}

/**
 * IndexPhotoError (rule 4): retry DeleteFaces once for `orphanFaceIds` (never record them);
 * `untrackedFacesPossible` is left to the daily reconciliation. Logs names and counts only.
 */
async function handleIndexPhotoError(
  deps: FacesDeps,
  error: IndexPhotoError,
  log: Logger,
): Promise<void> {
  const fields = {
    cause: error.cause instanceof Error ? error.cause.name : 'unknown',
    orphanFaces: error.orphanFaceIds.length,
    untrackedFacesPossible: error.untrackedFacesPossible,
    cleanupErrors: error.cleanupErrors.length,
    attemptId: error.attemptId,
  };
  if (error.cause instanceof Error && error.cause.name === 'ResourceNotFoundException') {
    // The collection vanished (e.g. deleted with an account); create it again on the retry.
    deps.collections.forget(error.collectionId);
  }
  if (error.orphanFaceIds.length > 0) {
    try {
      await deleteFacesInBatches(deps.provider, error.collectionId, error.orphanFaceIds);
      log.warn('indexing failed; deleted the faces its cleanup left behind', fields);
      return;
    } catch (deleteError) {
      log.error('indexing failed and its faces could not be deleted; reconciliation will', {
        ...fields,
        deleteError: deleteError instanceof Error ? deleteError.name : 'unknown',
      });
      return;
    }
  }
  if (error.untrackedFacesPossible) {
    log.warn(
      'indexing failed; IndexFaces may have left untracked faces for reconciliation',
      fields,
    );
    return;
  }
  log.warn('indexing failed', fields);
}

async function discardFaces(
  deps: FacesDeps,
  collectionId: string,
  result: IndexPhotoResult,
  log: Logger,
): Promise<void> {
  const ids = result.faces.map((f) => f.faceId);
  if (ids.length === 0) return;
  try {
    await deleteFacesInBatches(deps.provider, collectionId, ids);
  } catch (error) {
    log.warn('could not delete unrecorded faces; reconciliation will', {
      ...errorFields(error),
      faces: ids.length,
    });
  }
}

/** Files in a folder subtree that `index.folder` sends to `index.file`. */
export async function unindexedPhotosInSubtree(
  db: FacesDeps['db'],
  folder: { ownerId: string; path: string },
  now: Date,
  after: string,
  limit: number,
): Promise<string[]> {
  const found = await rows<{ id: string }>(
    db,
    sql`SELECT "f"."id" FROM ${files} AS "f"
      JOIN "folders" AS "fo" ON "fo"."id" = "f"."folder_id" AND "fo"."owner_id" = "f"."owner_id"
      WHERE "f"."owner_id" = ${folder.ownerId}
        AND "fo"."path" <@ ${folder.path}::ltree
        AND "f"."status" = 'ready'
        AND "f"."deleted_at" IS NULL
        AND "f"."purge_requested_at" IS NULL
        AND "f"."face_count" IS NULL
        AND "f"."mime" IN (${sql.join(
          IMAGE_MIMES.map((m) => sql`${m}`),
          sql`, `,
        )})
        AND "f"."id" > ${after}
        AND ${coveredByFaceIndexSql(sql`"fo"."path"`, folder.ownerId, now)}
      ORDER BY "f"."id"
      LIMIT ${limit}`,
  );
  return found.map((r) => r.id);
}
