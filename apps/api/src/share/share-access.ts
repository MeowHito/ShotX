import { Inject, Injectable } from '@nestjs/common';
import { files, folders, shares, users } from '@shotx/db';
import {
  faceScanResultKey,
  isOpaqueCookieToken,
  isShareToken,
  SHARE_UNLOCK_COOKIE,
  shareAccessGate,
  shareAvailability,
  shareUnlockKey,
  type SubscriptionStatus,
  type Viewer,
} from '@shotx/shared';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PublicContext } from '../auth/public.guard';
import type { Db, Queryable } from '../db/db';
import { currentSubscription } from '../drive/account';
import { ApiError, notFound } from '../http/api-error';
import { sha256Hex } from '../http/client';
import { CLOCK, type Clock, DATABASE, KEY_VALUE_STORE, type KeyValueStore } from '../tokens';

type ShareRow = typeof shares.$inferSelect;

/** A share with what every public route needs to decide on it, all read on the server. */
export interface LoadedShare extends ShareRow {
  /** Current name of the shared file or folder. */
  targetName: string;
  /** The target folder's current `path` (folder shares), or null. */
  rootPath: string | null;
  /** The target exists, is not trashed and not being purged. */
  targetLive: boolean;
  /** The owner's display name. */
  ownerName: string | null;
  /** The owner's latest subscription status (live first), null when none. */
  subscriptionStatus: SubscriptionStatus | null;
}

/** First 16 hex characters of SHA-256 of the password hash: what an unlock proof stores. */
export function passwordFingerprint(passwordHash: string): string {
  return sha256Hex(passwordHash).slice(0, 16);
}

/** One share with its target's name, path and liveness, its owner's name and subscription. */
async function loadShare(q: Queryable, where: SQL): Promise<LoadedShare | null> {
  const [row] = await q
    .select({
      share: shares,
      fileName: files.name,
      fileLive: sql<boolean>`(${files.id} IS NOT NULL AND ${files.deletedAt} IS NULL AND ${files.purgeRequestedAt} IS NULL)`,
      folderName: folders.name,
      folderPath: folders.path,
      folderLive: sql<boolean>`(${folders.id} IS NOT NULL AND ${folders.deletedAt} IS NULL AND ${folders.purgeRequestedAt} IS NULL)`,
      ownerName: users.name,
    })
    .from(shares)
    .innerJoin(users, eq(users.id, shares.ownerId))
    .leftJoin(files, and(eq(files.id, shares.targetFileId), eq(files.ownerId, shares.ownerId)))
    .leftJoin(
      folders,
      and(eq(folders.id, shares.targetFolderId), eq(folders.ownerId, shares.ownerId)),
    )
    .where(where)
    .limit(1);
  if (row === undefined) return null;
  const subscription = await currentSubscription(q, row.share.ownerId);
  const isFile = row.share.targetType === 'file';
  return {
    ...row.share,
    targetName: (isFile ? row.fileName : row.folderName) ?? '',
    rootPath: isFile ? null : row.folderPath,
    targetLive: isFile ? row.fileLive : row.folderLive,
    ownerName: row.ownerName,
    subscriptionStatus: subscription?.status ?? null,
  };
}

/**
 * Token lookup and the gates of the public share routes, in the contract's order: token
 * (NOT_FOUND), availability (SHARE_EXPIRED with a reason), require_login (LOGIN_REQUIRED),
 * password (PASSWORD_REQUIRED). Everything is decided from the share row and the database: never
 * from ids or paths sent by the client.
 */
@Injectable()
export class ShareAccess {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The share of a token; unknown or malformed tokens are NOT_FOUND (never VALIDATION_FAILED). */
  async byToken(token: string): Promise<LoadedShare> {
    if (!isShareToken(token)) throw notFound('Share');
    const share = await loadShare(this.db, eq(shares.token, token));
    if (share === null) throw notFound('Share');
    return share;
  }

  async byId(id: string): Promise<LoadedShare | null> {
    return loadShare(this.db, eq(shares.id, id));
  }

  /** SHARE_EXPIRED unless the share serves (revoked, expired, then unavailable). */
  assertAvailable(share: LoadedShare): void {
    const availability = shareAvailability(
      {
        isActive: share.isActive,
        expiresAt: share.expiresAt,
        targetLive: share.targetLive,
        subscriptionStatus: share.subscriptionStatus,
      },
      this.clock.now(),
    );
    if (!availability.ok) {
      throw new ApiError('SHARE_EXPIRED', 'This share link no longer works', {
        reason: availability.reason,
      });
    }
  }

  /**
   * Whether this browser unlocked the share: its unlock cookie maps, in Redis, to the fingerprint
   * of the current password hash (a changed or removed password locks everyone out again).
   * Shares without a password are always unlocked. Redis errors propagate (fail closed).
   */
  async isUnlocked(share: LoadedShare, ctx: PublicContext): Promise<boolean> {
    if (share.passwordHash === null) return true;
    const token = ctx.cookies.get(SHARE_UNLOCK_COOKIE);
    if (token === undefined || !isOpaqueCookieToken(token)) return false;
    const stored = await this.store.get(shareUnlockKey(share.id, sha256Hex(token)));
    return stored === passwordFingerprint(share.passwordHash);
  }

  /** LOGIN_REQUIRED, then PASSWORD_REQUIRED (after availability). */
  async assertAccess(share: LoadedShare, ctx: PublicContext): Promise<void> {
    const signedIn = ctx.viewer.kind === 'user';
    // Login first: an anonymous visitor of a login share never gets as far as the password.
    if (share.requireLogin && !signedIn) {
      throw new ApiError('LOGIN_REQUIRED', 'Sign in to open this share');
    }
    const gate = shareAccessGate(
      { requireLogin: share.requireLogin, passwordProtected: share.passwordHash !== null },
      { signedIn, unlocked: await this.isUnlocked(share, ctx) },
    );
    if (gate === 'LOGIN_REQUIRED')
      throw new ApiError('LOGIN_REQUIRED', 'Sign in to open this share');
    if (gate === 'PASSWORD_REQUIRED') {
      throw new ApiError('PASSWORD_REQUIRED', 'This share needs its password');
    }
  }

  /** Token lookup, availability, login and password: the full gate of most public routes. */
  async open(token: string, ctx: PublicContext): Promise<LoadedShare> {
    const share = await this.byToken(token);
    this.assertAvailable(share);
    await this.assertAccess(share, ctx);
    return share;
  }

  /** The viewer's face-search result (fileId -> similarity), `{}` when none. */
  async scanResult(share: { id: string }, viewer: Viewer): Promise<Record<string, string>> {
    return this.store.hashGetAll(faceScanResultKey(share.id, viewer));
  }

  /**
   * The face_only grant: the file ids of the viewer's face-search result, or null when there is
   * none (which allows nothing). Gallery shares don't need it (null).
   */
  async grant(share: LoadedShare, viewer: Viewer): Promise<ReadonlySet<string> | null> {
    if (share.mode !== 'face_only') return null;
    const result = await this.scanResult(share, viewer);
    const ids = Object.keys(result);
    return ids.length === 0 ? null : new Set(ids);
  }
}
