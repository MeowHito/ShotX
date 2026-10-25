import { faces } from '@shotx/db';
import {
  type Clock,
  deleteOrphans,
  faceCollectionId,
  type FaceProvider,
  type KnownFaceIds,
  OrphanCleanupError,
  scanCollection,
} from '@shotx/face';
import { inArray, sql } from 'drizzle-orm';
import { type Db, rows } from '../db';
import { isCollectionMissing } from '../faces';
import { errorFields } from '../logger';
import { type JobContext, mayContinue } from './context';
import type { OrphanScanStore } from './orphan-scans';

export interface FacesReconcileDeps {
  provider: FaceProvider;
  scans: OrphanScanStore;
  /** FACE_ORPHAN_GRACE_MS: the same value the indexing deadline uses (README rule 7). */
  graceMs: number;
}

export interface FacesReconcileResult {
  collections: number;
  /** Orphans deleted from scans stored by earlier runs. */
  orphansDeleted: number;
  /** Stored candidates that had gained a row by the time they were checked again. */
  claimed: number;
  /** Stored scans kept for a later run because their grace hasn't passed yet. */
  scansDeferred: number;
  /** Fresh scans stored for the next run (collections with candidates). */
  scansStored: number;
  candidates: number;
  failed: number;
  complete: boolean;
}

/**
 * Which ids have a `faces` row. The worker's pool is the primary database (never a replica,
 * README rule 3), so a just-committed face is never mistaken for an orphan. Rows marked for a
 * "ขอลบใบหน้าของฉัน" deletion count as known: delete.faces removes them.
 */
export function knownFaceIdsFrom(db: Db): KnownFaceIds {
  return async (faceIds) => {
    if (faceIds.length === 0) return [];
    const found = await db
      .select({ faceId: faces.rekognitionFaceId })
      .from(faces)
      .where(inArray(faces.rekognitionFaceId, [...faceIds]));
    return found.map((r) => r.faceId);
  };
}

/**
 * Photographers who may have a collection: ever confirmed a face index (the confirmation is kept
 * when indexing is turned off) or have faces rows. Ordered by id for paging.
 */
async function photographersWithCollections(
  db: Db,
  after: string,
  limit: number,
): Promise<string[]> {
  const found = await rows<{ id: string }>(
    db,
    sql`SELECT "u"."id" FROM "users" AS "u"
      WHERE "u"."id" > ${after}
        AND (EXISTS (SELECT 1 FROM "folders" AS "fo" WHERE "fo"."owner_id" = "u"."id" AND "fo"."face_index_informed_at" IS NOT NULL)
          OR EXISTS (SELECT 1 FROM "faces" AS "fa" WHERE "fa"."owner_id" = "u"."id"))
      ORDER BY "u"."id"
      LIMIT ${limit}`,
  );
  return found.map((r) => r.id);
}

/**
 * `faces.reconcile.daily`, two-job mode (packages/face README rule 6). For each photographer's
 * collection:
 *
 * 1. If an earlier run stored an OrphanScan, `deleteOrphans` deletes its candidates that the
 *    database still doesn't know (re-checked batch by batch right before each delete). It refuses
 *    before `listedAtMs + FACE_ORPHAN_GRACE_MS`; then the stored scan is kept for the next run and
 *    no new scan is taken. A failed delete also keeps it (rerunning is safe).
 * 2. Otherwise `scanCollection` lists the collection and stores the candidates (or removes the
 *    stored scan when there are none) for the next run, about a day later.
 *
 * Nothing sleeps: no worker slot is held for the grace period. Runs whatever FACE_SEARCH_ENABLED
 * says. Idempotent: deleting a face that is gone is a no-op, and a rerun at most rescans.
 */
export async function runFacesReconcile(
  ctx: JobContext,
  deps: FacesReconcileDeps,
): Promise<FacesReconcileResult> {
  const result: FacesReconcileResult = {
    collections: 0,
    orphansDeleted: 0,
    claimed: 0,
    scansDeferred: 0,
    scansStored: 0,
    candidates: 0,
    failed: 0,
    complete: true,
  };
  const knownFaceIds = knownFaceIdsFrom(ctx.db);
  const clock: Clock = {
    now: ctx.now,
    sleep: () => Promise.reject(new Error('reconciliation never sleeps in two-job mode')),
  };
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    if (!mayContinue(ctx)) {
      result.complete = false;
      break;
    }
    const batch = await photographersWithCollections(ctx.db, cursor, ctx.batchSize);
    if (batch.length === 0) break;
    cursor = batch.at(-1)!;
    for (const photographerId of batch) {
      if (!mayContinue(ctx)) {
        result.complete = false;
        return result;
      }
      result.collections++;
      const log = ctx.log.child({ photographerId });
      // ADR 0001: the collection id comes from the photographer id in the database.
      const collectionId = faceCollectionId(photographerId);
      try {
        const stored = await deps.scans.load(photographerId);
        if (stored !== null && stored.collectionId === collectionId) {
          if (stored.listedAtMs + deps.graceMs > ctx.now()) {
            result.scansDeferred++;
            continue;
          }
          try {
            const deletion = await deleteOrphans(deps.provider, stored, {
              knownFaceIds,
              graceMs: deps.graceMs,
              clock,
            });
            result.orphansDeleted += deletion.deleted;
            result.claimed += deletion.claimed;
            if (deletion.deleted > 0) {
              log.warn('deleted orphaned faces', { ...deletion });
            }
          } catch (error) {
            if (error instanceof OrphanCleanupError) {
              result.orphansDeleted += error.progress.deleted;
              result.failed++;
              log.warn('deleting orphaned faces failed; the scan is kept for the next run', {
                ...errorFields(error.cause),
                ...error.progress,
              });
              continue;
            }
            if (!isCollectionMissing(error)) throw error;
          }
        }
        let scan;
        try {
          scan = await scanCollection(deps.provider, { collectionId, knownFaceIds, clock });
        } catch (error) {
          if (!isCollectionMissing(error)) throw error;
          if (stored !== null) await deps.scans.remove(photographerId);
          continue;
        }
        result.candidates += scan.candidateFaceIds.length;
        if (scan.candidateFaceIds.length > 0) {
          await deps.scans.save(photographerId, scan);
          result.scansStored++;
          log.info('found orphan candidates; they are deleted after the grace period', {
            listed: scan.listed,
            candidates: scan.candidateFaceIds.length,
          });
        } else if (stored !== null) {
          await deps.scans.remove(photographerId);
        }
      } catch (error) {
        result.failed++;
        log.warn('reconciling a collection failed; the next run tries again', errorFields(error));
      }
    }
  }
  return result;
}
