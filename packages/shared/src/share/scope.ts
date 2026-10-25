import type {
  FileStatus,
  ShareMode,
  ShareStatus,
  ShareTargetType,
  ShareUnavailableReason,
  SubscriptionStatus,
} from '../domain';
import type { FaceSearchUnavailableReason } from '../errors';

/**
 * Share scope and availability, as pure functions. The API answers these questions in SQL (see
 * `fileInShareScopeSql` and `faceIndexActiveSql` in @shotx/db, which must agree with this file);
 * these helpers are the specification, used for tests, responses and post-query checks.
 *
 * Paths are always the server's `folders.path` values (ltree text: labels joined by `.`), never
 * paths or ids from the client.
 */

const LABEL = /^[A-Za-z0-9_]+$/;

function labels(path: string): string[] {
  const parts = path.split('.');
  if (path === '' || !parts.every((p) => LABEL.test(p))) {
    throw new RangeError(`Not an ltree path of folder labels: ${JSON.stringify(path)}`);
  }
  return parts;
}

/**
 * ltree `descendant <@ ancestor`: true when `ancestor` is `descendant` or one of its ancestors,
 * label by label (`a.b` contains `a.b.c`, not `a.bc`).
 */
export function ltreeContains(ancestor: string, descendant: string): boolean {
  const a = labels(ancestor);
  const d = labels(descendant);
  return a.length <= d.length && a.every((label, i) => label === d[i]);
}

export interface ShareTargetRef {
  ownerId: string;
  targetType: ShareTargetType;
  /** Set when targetType is `file`. */
  targetFileId: string | null;
  /** Set when targetType is `folder`. */
  targetFolderId: string | null;
}

export interface ScopeFile {
  id: string;
  ownerId: string;
  status: FileStatus;
  deletedAt: Date | string | null;
  purgeRequestedAt: Date | string | null;
  /** `path` of the file's folder; null for a file at the drive root. */
  folderPath: string | null;
}

/**
 * Whether a share may serve `file`. Every view, download, zip entry and face-search hit passes
 * this check (and, in face_only mode, the grant):
 *
 * - the file belongs to the share's owner, is `ready`, not in the trash and not being purged;
 * - file share: it is the shared file itself;
 * - folder share: its folder's path is inside the share root's path (`folder.path <@ root.path`).
 *   `rootPath` is the target folder's current path, read from the database (so moves are
 *   followed), and the root itself must be live (see shareAvailability). A file at the drive
 *   root is never in a folder share.
 */
export function isFileInShareScope(
  share: ShareTargetRef,
  rootPath: string | null,
  file: ScopeFile,
): boolean {
  if (file.ownerId !== share.ownerId) return false;
  if (file.status !== 'ready' || file.deletedAt !== null || file.purgeRequestedAt !== null) {
    return false;
  }
  if (share.targetType === 'file') return file.id === share.targetFileId;
  if (rootPath === null || file.folderPath === null) return false;
  return ltreeContains(rootPath, file.folderPath);
}

/**
 * Subscription statuses whose shares keep working: `grace` too (spec: uploads are blocked but
 * shares and downloads keep working). `expired` and `purged` shares show "ลิงก์นี้หมดอายุ".
 */
export const SHARE_SERVING_SUBSCRIPTION_STATUSES = [
  'trial',
  'active',
  'grace',
] as const satisfies readonly SubscriptionStatus[];

export function subscriptionServesShares(status: SubscriptionStatus | null): boolean {
  return (
    status !== null && (SHARE_SERVING_SUBSCRIPTION_STATUSES as readonly string[]).includes(status)
  );
}

/**
 * Subscription statuses that may create shares and enable face indexing: the same as for serving.
 * (Uploads need `trial` or `active`; see subscriptionAllowsUploads.)
 */
export const subscriptionAllowsSharing = subscriptionServesShares;

export interface ShareAvailabilityInput {
  isActive: boolean;
  expiresAt: Date | null;
  /** The target file or folder exists, is not in the trash and is not being purged. */
  targetLive: boolean;
  /** The owner's latest subscription status, null when there is none. */
  subscriptionStatus: SubscriptionStatus | null;
}

export type ShareAvailability =
  { ok: true } | { ok: false; code: 'SHARE_EXPIRED'; reason: ShareUnavailableReason };

/**
 * Whether a share serves anything at `now`, checked first by every public route after the token
 * lookup (unknown token: NOT_FOUND). Order: revoked, expired, then unavailable.
 */
export function shareAvailability(share: ShareAvailabilityInput, now: Date): ShareAvailability {
  if (!share.isActive) return { ok: false, code: 'SHARE_EXPIRED', reason: 'revoked' };
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) {
    return { ok: false, code: 'SHARE_EXPIRED', reason: 'expired' };
  }
  if (!share.targetLive || !subscriptionServesShares(share.subscriptionStatus)) {
    return { ok: false, code: 'SHARE_EXPIRED', reason: 'unavailable' };
  }
  return { ok: true };
}

/** Owner-facing status of a share (`GET /shares`). */
export function ownerShareStatus(
  share: { isActive: boolean; expiresAt: Date | null },
  now: Date,
): ShareStatus {
  if (!share.isActive) return 'revoked';
  if (share.expiresAt !== null && share.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/**
 * The gates after availability, in order: login (`require_login` without a signed-in viewer:
 * LOGIN_REQUIRED), then password (a password share this browser hasn't unlocked:
 * PASSWORD_REQUIRED). `GET /s/:token` reports them as flags instead of failing.
 */
export function shareAccessGate(
  share: { requireLogin: boolean; passwordProtected: boolean },
  viewer: { signedIn: boolean; unlocked: boolean },
): 'LOGIN_REQUIRED' | 'PASSWORD_REQUIRED' | null {
  if (share.requireLogin && !viewer.signedIn) return 'LOGIN_REQUIRED';
  if (share.passwordProtected && !viewer.unlocked) return 'PASSWORD_REQUIRED';
  return null;
}

export interface FaceIndexFolder {
  path: string;
  faceIndexEnabled: boolean;
  faceIndexExpiresAt: Date | null;
  deletedAt: Date | string | null;
}

/** A folder's own face index is active: enabled, live, and not past its expiry. */
export function isFaceIndexActive(folder: FaceIndexFolder, now: Date): boolean {
  return (
    folder.faceIndexEnabled &&
    folder.deletedAt === null &&
    folder.faceIndexExpiresAt !== null &&
    folder.faceIndexExpiresAt.getTime() > now.getTime()
  );
}

/**
 * Face indexing covers a subtree: a file is indexed when its folder or any ancestor has an active
 * face index (`folders` is any set of the owner's folders that includes the ancestors). Files at
 * the drive root are never covered. The worker uses this rule to decide whether to index a file
 * (`index.file`), and the expiry and unindex jobs delete faces of files it no longer covers.
 */
export function isCoveredByFaceIndex(
  folderPath: string | null,
  folders: readonly FaceIndexFolder[],
  now: Date,
): boolean {
  if (folderPath === null) return false;
  return folders.some((f) => isFaceIndexActive(f, now) && ltreeContains(f.path, folderPath));
}

/**
 * Whether face search can run on a share (beyond FACE_SEARCH_ENABLED): only folder shares, and
 * only when some folder that is an ancestor-or-self or a descendant of the root has an active
 * face index. `folders` must include those folders. Null means available.
 */
export function faceSearchUnavailableReason(
  share: { targetType: ShareTargetType },
  rootPath: string | null,
  folders: readonly FaceIndexFolder[],
  now: Date,
): FaceSearchUnavailableReason | null {
  if (share.targetType !== 'folder' || rootPath === null) return 'not_folder_share';
  const active = folders.some(
    (f) =>
      isFaceIndexActive(f, now) &&
      (ltreeContains(f.path, rootPath) || ltreeContains(rootPath, f.path)),
  );
  return active ? null : 'not_indexed';
}

/**
 * face_only shares must be folder shares (a single shared file has nobody else's photos to hide).
 * The API also answers FEATURE_DISABLED for face_only while FACE_SEARCH_ENABLED is false. It does
 * not check the face index: the photographer may enable it after creating the share.
 */
export function shareModeAllowedForTarget(mode: ShareMode, targetType: ShareTargetType): boolean {
  return mode === 'gallery' || targetType === 'folder';
}
