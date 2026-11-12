import { designAssets, shareDesigns } from '@shotx/db';
import {
  designAssetKeys,
  designDocAssetIds,
  designDocSchema,
  fileQuotaBucket,
} from '@shotx/shared';
import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { type Db, isUuid } from '../db';
import { errorFields, type Logger } from '../logger';
import { applyQuotaMove, releaseMoveFor } from '../quota';
import { groupBy, type JobContext, mayContinue } from './context';

export interface DesignAssetPurgeResult {
  /** Owners whose assets were checked against their designs this run. */
  designOwnersChecked: number;
  /** Assets that became unreferenced this run (`orphaned_at` set). */
  designAssetsOrphaned: number;
  /** Assets referenced again (`orphaned_at` cleared), including by the purge's re-check. */
  designAssetsReclaimed: number;
  /** Assets whose purge this run requested (quota released). */
  designAssetsRequested: number;
  /** Purge-requested assets deleted (both objects, then the row). */
  designAssetsPurged: number;
  /** Purge-requested assets kept for the next run (object delete failed). */
  designAssetsSkipped: number;
  complete: boolean;
}

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** Live assets the orphan bookkeeping looks at: not purge-requested, not still uploading. */
const live = and(isNull(designAssets.purgeRequestedAt), ne(designAssets.status, 'uploading'));

const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Every uuid-looking string anywhere in a value (the conservative fallback below). */
function uuidsIn(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(UUID_ANYWHERE)) out.add(match[0].toLowerCase());
  } else if (Array.isArray(value)) {
    for (const item of value) uuidsIn(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) uuidsIn(item, out);
  }
}

/**
 * Asset ids any of the owner's designs references (designDocAssetIds). A document that doesn't
 * parse with the current designDocSchema (a newer api's version, say) never lets an image go:
 * every uuid in it counts as referenced, and the problem is logged.
 */
export async function referencedAssetIds(
  db: Db,
  ownerId: string,
  log: Logger,
): Promise<Set<string>> {
  const docs = await db
    .select({ id: shareDesigns.id, doc: shareDesigns.doc })
    .from(shareDesigns)
    .where(eq(shareDesigns.ownerId, ownerId));
  const ids = new Set<string>();
  for (const { id, doc } of docs) {
    const parsed = designDocSchema.safeParse(doc);
    if (parsed.success) {
      for (const assetId of designDocAssetIds(parsed.data)) ids.add(assetId.toLowerCase());
    } else {
      log.error('design document does not parse; keeping every image it may name', {
        designId: id,
        photographerId: ownerId,
      });
      uuidsIn(doc, ids);
    }
  }
  return ids;
}

/**
 * Step 1, per owner: clear `orphaned_at` of referenced assets, set it on unreferenced ones that
 * don't have it. Only starts or stops the DESIGN_ASSET_ORPHAN_DAYS clock; a save racing with it
 * is fixed by the next run and by the purge's re-check under lock.
 */
async function markOrphans(
  ctx: JobContext,
): Promise<{ owners: number; orphaned: number; reclaimed: number }> {
  let cursor = ZERO_UUID;
  let owners = 0;
  let orphaned = 0;
  let reclaimed = 0;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .selectDistinct({ ownerId: designAssets.ownerId })
      .from(designAssets)
      .where(and(live, gt(designAssets.ownerId, cursor)))
      .orderBy(asc(designAssets.ownerId))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    cursor = batch.at(-1)!.ownerId;
    for (const { ownerId } of batch) {
      if (!mayContinue(ctx)) break;
      try {
        const referenced = [...(await referencedAssetIds(ctx.db, ownerId, ctx.log))].filter(isUuid);
        const cleared =
          referenced.length === 0
            ? []
            : await ctx.db
                .update(designAssets)
                .set({ orphanedAt: null })
                .where(
                  and(
                    eq(designAssets.ownerId, ownerId),
                    live,
                    isNotNull(designAssets.orphanedAt),
                    inArray(designAssets.id, referenced),
                  ),
                )
                .returning({ id: designAssets.id });
        const marked = await ctx.db
          .update(designAssets)
          .set({ orphanedAt: sql`now()` })
          .where(
            and(
              eq(designAssets.ownerId, ownerId),
              live,
              isNull(designAssets.orphanedAt),
              referenced.length === 0 ? undefined : notInArray(designAssets.id, referenced),
            ),
          )
          .returning({ id: designAssets.id });
        owners++;
        reclaimed += cleared.length;
        orphaned += marked.length;
      } catch (error) {
        ctx.log.warn('could not check design images of a photographer; next run retries', {
          ...errorFields(error),
          photographerId: ownerId,
        });
      }
    }
  }
  return { owners, orphaned, reclaimed };
}

/**
 * Step 2: assets orphaned longer than DESIGN_ASSET_ORPHAN_DAYS. Per owner, one transaction locks
 * the due rows (FOR UPDATE: waits for an api save holding FOR KEY SHARE on them, and blocks the
 * next one until commit), re-reads the owner's designs, clears `orphaned_at` of rows referenced
 * after all, and for the rest sets `purge_requested_at` and takes `size_bytes` out of its quota
 * bucket (fileQuotaBucket, as for files). Lock order: design_assets, then storage_usage.
 */
export async function requestDuePurges(
  ctx: JobContext,
  cutoff: Date,
): Promise<{ requested: number; reclaimed: number }> {
  const due = and(live, lt(designAssets.orphanedAt, cutoff));
  const failedOwners = new Set<string>();
  let requested = 0;
  let reclaimed = 0;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: designAssets.id, ownerId: designAssets.ownerId })
      .from(designAssets)
      .where(
        failedOwners.size === 0
          ? due
          : and(due, notInArray(designAssets.ownerId, [...failedOwners])),
      )
      .orderBy(asc(designAssets.orphanedAt), asc(designAssets.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    const failedBefore = failedOwners.size;
    let progressed = 0;
    for (const [ownerId, owned] of groupBy(batch, (r) => r.ownerId)) {
      try {
        const done = await ctx.db.transaction(async (tx) => {
          const locked = await tx
            .select({
              id: designAssets.id,
              sizeBytes: designAssets.sizeBytes,
              status: designAssets.status,
              verifiedAt: designAssets.verifiedAt,
              purgeRequestedAt: designAssets.purgeRequestedAt,
            })
            .from(designAssets)
            .where(
              and(
                due,
                eq(designAssets.ownerId, ownerId),
                inArray(
                  designAssets.id,
                  owned.map((r) => r.id),
                ),
              ),
            )
            .orderBy(asc(designAssets.id))
            .for('update');
          if (locked.length === 0) return { requested: 0, reclaimed: 0 };
          const referenced = await referencedAssetIds(tx, ownerId, ctx.log);
          const keep = locked.filter((r) => referenced.has(r.id.toLowerCase()));
          const doomed = locked.filter((r) => !referenced.has(r.id.toLowerCase()));
          if (keep.length > 0) {
            await tx
              .update(designAssets)
              .set({ orphanedAt: null })
              .where(
                inArray(
                  designAssets.id,
                  keep.map((r) => r.id),
                ),
              );
          }
          let used = 0;
          let reserved = 0;
          for (const row of doomed) {
            const move = releaseMoveFor(fileQuotaBucket(row));
            if (move === 'releaseUsed') used += row.sizeBytes;
            else if (move === 'releaseReserved') reserved += row.sizeBytes;
          }
          if (used > 0) await applyQuotaMove(tx, ownerId, 'releaseUsed', used, ctx.log);
          if (reserved > 0) {
            await applyQuotaMove(tx, ownerId, 'releaseReserved', reserved, ctx.log);
          }
          if (doomed.length > 0) {
            await tx
              .update(designAssets)
              .set({ purgeRequestedAt: sql`now()` })
              .where(
                inArray(
                  designAssets.id,
                  doomed.map((r) => r.id),
                ),
              );
          }
          return { requested: doomed.length, reclaimed: keep.length };
        });
        requested += done.requested;
        reclaimed += done.reclaimed;
        progressed += done.requested + done.reclaimed;
      } catch (error) {
        failedOwners.add(ownerId);
        ctx.log.warn('could not request the purge of orphaned design images; next run retries', {
          ...errorFields(error),
          photographerId: ownerId,
        });
      }
    }
    // Rows that changed between the select and the lock leave `due`; failed owners are excluded.
    if (progressed === 0 && failedOwners.size === failedBefore) break;
  }
  return { requested, reclaimed };
}

/**
 * Step 3: every purge-requested asset (this run's, the api's if any, and those a crash left):
 * delete both objects (designAssetKeys), then the row. Missing objects are fine; a failed delete
 * keeps the batch for the next run.
 */
async function finishPurges(ctx: JobContext): Promise<{ purged: number; skipped: number }> {
  let cursor = ZERO_UUID;
  let purged = 0;
  let skipped = 0;
  while (mayContinue(ctx)) {
    const batch = await ctx.db
      .select({ id: designAssets.id, ownerId: designAssets.ownerId })
      .from(designAssets)
      .where(and(isNotNull(designAssets.purgeRequestedAt), gt(designAssets.id, cursor)))
      .orderBy(asc(designAssets.id))
      .limit(ctx.batchSize);
    if (batch.length === 0) break;
    cursor = batch.at(-1)!.id;
    try {
      await ctx.store.deleteObjects(
        batch.flatMap((a) =>
          Object.values(designAssetKeys({ photographerId: a.ownerId, assetId: a.id })),
        ),
      );
    } catch (error) {
      ctx.log.warn('deleting design images failed; keeping the batch for the next run', {
        ...errorFields(error),
        assets: batch.length,
      });
      skipped += batch.length;
      continue;
    }
    const deleted = await ctx.db
      .delete(designAssets)
      .where(
        and(
          inArray(
            designAssets.id,
            batch.map((a) => a.id),
          ),
          isNotNull(designAssets.purgeRequestedAt),
        ),
      )
      .returning({ id: designAssets.id });
    purged += deleted.length;
  }
  return { purged, skipped };
}

/**
 * The design image orphan purge of `trash.purge.daily` (ADR 0013; SCHEDULED_JOB_TYPES in
 * @shotx/shared is the contract): maintain `orphaned_at`, request the purge of assets orphaned
 * longer than `orphanDays` (re-checked under lock, quota released), then delete the objects and
 * rows of every purge-requested asset. Never changes or deletes a design.
 *
 * Idempotent: every step is guarded by the row state, object deletes ignore what is already
 * gone, and rows go last, so a crash anywhere is finished by the next run.
 */
export async function runDesignAssetPurge(
  ctx: JobContext,
  orphanDays: number,
): Promise<DesignAssetPurgeResult> {
  const cutoff = new Date(ctx.now() - orphanDays * 86_400_000);
  const marks = await markOrphans(ctx);
  const requests = await requestDuePurges(ctx, cutoff);
  const finished = await finishPurges(ctx);
  return {
    designOwnersChecked: marks.owners,
    designAssetsOrphaned: marks.orphaned,
    designAssetsReclaimed: marks.reclaimed + requests.reclaimed,
    designAssetsRequested: requests.requested,
    designAssetsPurged: finished.purged,
    designAssetsSkipped: finished.skipped,
    complete: ctx.now() < ctx.deadline,
  };
}
