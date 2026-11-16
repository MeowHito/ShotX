import { ErrorCode } from '../errors';

// Time-boxed packages (ADR 0026): pure rules shared by api (applying a package, counting photos,
// expiry checks), worker and web (the studio chip). No row in `photographer_packages` means the
// account is unlimited (every admin-created account): none of these rules apply to it.

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The package being applied (a `packages` row). */
export interface PackageTerms {
  id: string;
  /** `packages.days` (> 0). */
  days: number;
  /** `packages.photo_limit` (> 0). */
  photoLimit: number;
}

/** A `photographer_packages` row, as far as the rules need it. */
export interface PhotographerPackageState {
  packageId: string;
  startsAt: Date;
  expiresAt: Date;
  photoLimit: number;
  photosUsed: number;
}

/**
 * What applyPackage decided:
 * - `fresh`: no row, or the row had expired: a new period from now;
 * - `extend`: the row was still running: more days and more photos on top.
 */
export const PACKAGE_APPLY_KINDS = ['fresh', 'extend'] as const;
export type PackageApplyKind = (typeof PACKAGE_APPLY_KINDS)[number];

/** The row values to write (insert or update) after applying a package. */
export interface AppliedPackage extends PhotographerPackageState {
  kind: PackageApplyKind;
}

function assertPositiveInt(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer, got ${value}`);
  }
}

function assertValidDate(label: string, value: Date): void {
  if (Number.isNaN(value.getTime())) throw new RangeError(`${label} must be a valid date`);
}

/** `start + days`, in whole 24-hour days (Asia/Bangkok has no DST, so these are calendar days). */
export function addPackageDays(start: Date, days: number): Date {
  assertPositiveInt('days', days);
  assertValidDate('start', start);
  return new Date(start.getTime() + days * MS_PER_DAY);
}

/** True once `now >= expires_at` (ADR 0026 §2: expired at the instant itself). */
export function packageExpired(
  row: Pick<PhotographerPackageState, 'expiresAt'>,
  now: Date,
): boolean {
  assertValidDate('expiresAt', row.expiresAt);
  assertValidDate('now', now);
  return now.getTime() >= row.expiresAt.getTime();
}

/**
 * The next `photographer_packages` values after applying `pkg` at `now` (ADR 0026 §2). The api
 * calls it inside the transaction that locked the row (`FOR UPDATE`; null when there is none):
 * - no row, or expired (`expires_at <= now`): fresh period: `starts_at = now`,
 *   `expires_at = now + days`, `photo_limit = package.photo_limit`, `photos_used = 0`;
 * - still running: extend: `expires_at += days`, `photo_limit += package.photo_limit`,
 *   `starts_at` and `photos_used` kept.
 * `packageId` is always the package just applied (the last one applied).
 */
export function applyPackage(
  current: PhotographerPackageState | null,
  pkg: PackageTerms,
  now: Date,
): AppliedPackage {
  assertPositiveInt('package days', pkg.days);
  assertPositiveInt('package photoLimit', pkg.photoLimit);
  assertValidDate('now', now);
  if (current === null || packageExpired(current, now)) {
    return {
      kind: 'fresh',
      packageId: pkg.id,
      startsAt: now,
      expiresAt: addPackageDays(now, pkg.days),
      photoLimit: pkg.photoLimit,
      photosUsed: 0,
    };
  }
  const photoLimit = current.photoLimit + pkg.photoLimit;
  assertPositiveInt('photoLimit', photoLimit);
  return {
    kind: 'extend',
    packageId: pkg.id,
    startsAt: current.startsAt,
    expiresAt: addPackageDays(current.expiresAt, pkg.days),
    photoLimit,
    photosUsed: current.photosUsed,
  };
}

/**
 * Photos the account may still upload: `max(0, photo_limit − photos_used)` (extensions can leave
 * `photos_used` above an old limit only transiently; never negative here).
 */
export function photosRemaining(
  row: Pick<PhotographerPackageState, 'photoLimit' | 'photosUsed'>,
): number {
  return Math.max(0, row.photoLimit - row.photosUsed);
}

/**
 * Days left for the studio chip: started days until `expires_at`, rounded up (a started day
 * counts); 0 once expired.
 */
export function packageDaysLeft(
  row: Pick<PhotographerPackageState, 'expiresAt'>,
  now: Date,
): number {
  if (packageExpired(row, now)) return 0;
  return Math.ceil((row.expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
}

/**
 * Why the package blocks uploads right now, for GET /drive/usage `uploadsBlockedBy` and the
 * POST /uploads/init check order: expiry first, then the photo limit (`requested` photos must
 * fit: `photos_used + requested <= photo_limit`). Null when there is no row (unlimited) or the
 * upload fits. The api still does the guarded UPDATE in the transaction; this is not a
 * reservation.
 */
export function packageUploadsBlockedBy(
  row: PhotographerPackageState | null,
  now: Date,
  requested = 1,
): typeof ErrorCode.PLAN_EXPIRED | typeof ErrorCode.PHOTO_LIMIT_REACHED | null {
  assertPositiveInt('requested', requested);
  if (row === null) return null;
  if (packageExpired(row, now)) return ErrorCode.PLAN_EXPIRED;
  if (row.photosUsed + requested > row.photoLimit) {
    return ErrorCode.PHOTO_LIMIT_REACHED;
  }
  return null;
}

/**
 * The buyer's email as GET /package-orders/:id shows it: the first character of the local part,
 * `***`, then `@` and the domain (`alice@example.com` → `a***@example.com`). The access-token
 * holder recognises their inbox without the page revealing the address.
 */
export function maskEmail(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return '***';
  return `${Array.from(trimmed)[0] ?? ''}***@${trimmed.slice(at + 1)}`;
}
