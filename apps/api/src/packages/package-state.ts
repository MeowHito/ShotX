import { photographerPackages } from '@shotx/db';
import {
  ErrorCode,
  packageExpired,
  packageUploadsBlockedBy,
  type PhotographerPackageState,
} from '@shotx/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Queryable } from '../db/db';
import { ApiError } from '../http/api-error';

// The photographer's package as the drive, upload and share code sees it (ADR 0026 §2). No
// `photographer_packages` row means unlimited (every admin-created account): every helper here
// lets such an account through without a limit.

/** The account's package row, or null (unlimited). `lock` only inside a transaction. */
export async function photographerPackage(
  q: Queryable,
  ownerId: string,
  options: { lock?: 'update' | 'share' } = {},
): Promise<PhotographerPackageState | null> {
  const query = q
    .select({
      packageId: photographerPackages.packageId,
      startsAt: photographerPackages.startsAt,
      expiresAt: photographerPackages.expiresAt,
      photoLimit: photographerPackages.photoLimit,
      photosUsed: photographerPackages.photosUsed,
    })
    .from(photographerPackages)
    .where(eq(photographerPackages.photographerId, ownerId))
    .limit(1);
  const [row] = await (options.lock === undefined ? query : query.for(options.lock));
  return row ?? null;
}

/** PLAN_EXPIRED (403) with when the package ran out (planExpiredDetailsSchema). */
export function planExpired(expiresAt: Date): ApiError {
  return new ApiError(ErrorCode.PLAN_EXPIRED, 'The package has expired; renew it to continue', {
    expiresAt: expiresAt.toISOString(),
  });
}

/** PHOTO_LIMIT_REACHED (403) with the limit, the count and the request. */
export function photoLimitReached(
  row: Pick<PhotographerPackageState, 'photoLimit' | 'photosUsed'>,
  requested: number,
): ApiError {
  return new ApiError(
    ErrorCode.PHOTO_LIMIT_REACHED,
    'The package has no photos left; renew it to upload more',
    { photoLimit: row.photoLimit, photosUsed: row.photosUsed, requested },
  );
}

/**
 * PLAN_EXPIRED unless the account is unlimited or its package still runs at `now`: creating a
 * share, re-activating or un-pausing one, and turning face indexing on.
 */
export async function assertPackageActive(q: Queryable, ownerId: string, now: Date): Promise<void> {
  const row = await photographerPackage(q, ownerId);
  if (row !== null && packageExpired(row, now)) throw planExpired(row.expiresAt);
}

/** The error packageUploadsBlockedBy names for `row`, or null when `count` photos fit. */
function uploadBlock(
  row: PhotographerPackageState | null,
  count: number,
  now: Date,
): ApiError | null {
  switch (packageUploadsBlockedBy(row, now, count)) {
    case null:
      return null;
    case ErrorCode.PLAN_EXPIRED:
      return planExpired(row?.expiresAt ?? now);
    case ErrorCode.PHOTO_LIMIT_REACHED:
      return photoLimitReached(row ?? { photoLimit: 1, photosUsed: 0 }, count);
  }
}

/**
 * PLAN_EXPIRED / PHOTO_LIMIT_REACHED when `count` more photos wouldn't be accepted right now, read
 * without a lock: a pre-check only (takePackagePhotos decides).
 */
export async function assertPackageAllowsUpload(
  q: Queryable,
  ownerId: string,
  count: number,
  now: Date,
): Promise<void> {
  const error = uploadBlock(await photographerPackage(q, ownerId), count, now);
  if (error !== null) throw error;
}

/**
 * Counts `count` photos against the package, inside the transaction that creates their file rows
 * (POST /uploads/init), with one guarded UPDATE (`photos_used + n <= photo_limit` and not
 * expired), which is race-safe on its own and holds the row lock only from here to the commit.
 * Refused: PLAN_EXPIRED or PHOTO_LIMIT_REACHED. No row: unlimited, nothing written.
 *
 * Lock order (ADR 0026): photographer_packages before storage_usage, in init, abort and the
 * worker's abandoned-upload cleanup, so they never deadlock.
 */
export async function takePackagePhotos(
  tx: Queryable,
  ownerId: string,
  count: number,
  now: Date,
): Promise<void> {
  const p = photographerPackages;
  for (let attempt = 0; attempt < 2; attempt++) {
    const [updated] = await tx
      .update(p)
      .set({ photosUsed: sql`${p.photosUsed} + ${count}`, updatedAt: now })
      .where(
        and(
          eq(p.photographerId, ownerId),
          sql`${p.expiresAt} > ${now.toISOString()}::timestamptz`,
          sql`${p.photosUsed} + ${count} <= ${p.photoLimit}`,
        ),
      )
      .returning({ photosUsed: p.photosUsed });
    if (updated !== undefined) return;
    // Not counted: unlimited (no row), expired, or full. Name which.
    const row = await photographerPackage(tx, ownerId);
    if (row === null) return;
    const error = uploadBlock(row, count, now);
    if (error !== null) throw error;
    // The row changed between the two statements (a package applied meanwhile): try again.
  }
  const row = await photographerPackage(tx, ownerId);
  throw photoLimitReached(row ?? { photoLimit: count, photosUsed: count }, count);
}

/**
 * Gives `count` photos back (DELETE /uploads/:id aborts a counted upload), never below zero, in
 * the transaction that deletes the file rows. Expired packages get them back too. No row: nothing.
 */
export async function returnPackagePhotos(
  tx: Queryable,
  ownerId: string,
  count: number,
  now: Date,
): Promise<void> {
  const p = photographerPackages;
  await tx
    .update(p)
    .set({ photosUsed: sql`greatest(0, ${p.photosUsed} - ${count})`, updatedAt: now })
    .where(eq(p.photographerId, ownerId));
}
