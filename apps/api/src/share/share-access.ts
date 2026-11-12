import { Inject, Injectable } from '@nestjs/common';
import { files, folders, shares, users } from '@shotx/db';
import {
  type AccountStatus,
  faceScanResultKey,
  isOpaqueCookieToken,
  parseShareRef,
  SHARE_UNLOCK_COOKIE,
  shareAccessGate,
  shareAvailability,
  shareUnlockKey,
  type SubscriptionStatus,
  type Viewer,
} from '@shotx/shared';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { PublicContext } from '../auth/public.guard';
import { type ApiConfig, billingOnline } from '../config';
import type { Db, Queryable } from '../db/db';
import { currentSubscription } from '../drive/account';
import { ApiError, notFound } from '../http/api-error';
import { sha256Hex } from '../http/client';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  KEY_VALUE_STORE,
  type KeyValueStore,
  RATE_LIMITER,
  type RateLimiter,
  type RateLimitResult,
} from '../tokens';

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
  /**
   * The owner's latest subscription status (live first), null when none. Not read (null) with
   * BILLING_MODE=offline, where subscriptions decide nothing.
   */
  subscriptionStatus: SubscriptionStatus | null;
  /** The owner's account status (ADR 0010): a disabled photographer's shares don't serve. */
  ownerStatus: AccountStatus;
  /**
   * Folder shares: the target folder's chosen cover (ADR 0011), not re-checked here (share meta
   * does); null for file shares or the default cover.
   */
  coverFileId: string | null;
}

/** RATE_LIMITED with Retry-After unless the window allows the request. */
function refuseUnless(result: RateLimitResult): void {
  if (!result.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many requests; try again later', undefined, {
      'Retry-After': String(Math.max(1, result.retryAfterSeconds)),
    });
  }
}

/** First 16 hex characters of SHA-256 of the password hash: what an unlock proof stores. */
export function passwordFingerprint(passwordHash: string): string {
  return sha256Hex(passwordHash).slice(0, 16);
}

/**
 * One share with its target's name, path and liveness, its owner's name, account status and
 * (when `withSubscription`) subscription.
 */
async function loadShare(
  q: Queryable,
  where: SQL,
  withSubscription: boolean,
): Promise<LoadedShare | null> {
  const [row] = await q
    .select({
      share: shares,
      fileName: files.name,
      fileLive: sql<boolean>`(${files.id} IS NOT NULL AND ${files.deletedAt} IS NULL AND ${files.purgeRequestedAt} IS NULL)`,
      folderName: folders.name,
      folderPath: folders.path,
      folderCoverFileId: folders.coverFileId,
      folderLive: sql<boolean>`(${folders.id} IS NOT NULL AND ${folders.deletedAt} IS NULL AND ${folders.purgeRequestedAt} IS NULL)`,
      ownerName: users.name,
      ownerStatus: users.status,
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
  const subscription = withSubscription ? await currentSubscription(q, row.share.ownerId) : null;
  const isFile = row.share.targetType === 'file';
  return {
    ...row.share,
    targetName: (isFile ? row.fileName : row.folderName) ?? '',
    rootPath: isFile ? null : row.folderPath,
    targetLive: isFile ? row.fileLive : row.folderLive,
    ownerName: row.ownerName,
    subscriptionStatus: subscription?.status ?? null,
    ownerStatus: row.ownerStatus,
    coverFileId: isFile ? null : row.folderCoverFileId,
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
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
  ) {}

  /**
   * The share of a ref, the `:token` path parameter of every public share route (ADR 0011):
   * parseShareRef reads it as a token (`shares.token`) or a slug (`shares.slug`); anything else is
   * NOT_FOUND, like an unknown ref (never VALIDATION_FAILED). Slugs are guessable, so per client
   * IP (ADR 0011 risk 3):
   * - a slug lookup is refused (RATE_LIMITED, Retry-After) while the IP is over
   *   SHARE_NOT_FOUND_RATE_PER_IP NOT_FOUND answers, found or not, and counts towards
   *   SHARE_SLUG_RESOLVE_RATE_PER_IP;
   * - every NOT_FOUND (slug, token or malformed ref) counts towards SHARE_NOT_FOUND_RATE_PER_IP.
   * Token lookups are never refused by these limits. A refused or unknown slug answers exactly
   * what an unknown one would otherwise (no hint that a slug exists).
   */
  async byToken(ref: string, ctx: { ipHash: string }): Promise<LoadedShare> {
    const { slugResolvePerIp, notFoundPerIp } = this.config.share.rateLimits;
    const notFoundKey = `share-ref:not-found:ip:${ctx.ipHash}`;
    const parsed = parseShareRef(ref);
    if (parsed?.kind === 'slug') {
      refuseUnless(
        await this.limiter.peek(notFoundKey, notFoundPerIp.limit, notFoundPerIp.windowSeconds),
      );
      refuseUnless(
        await this.limiter.hit(
          `share-ref:slug:ip:${ctx.ipHash}`,
          slugResolvePerIp.limit,
          slugResolvePerIp.windowSeconds,
        ),
      );
    }
    const share =
      parsed === null
        ? null
        : await loadShare(
            this.db,
            parsed.kind === 'token' ? eq(shares.token, parsed.token) : eq(shares.slug, parsed.slug),
            billingOnline(this.config),
          );
    if (share === null) {
      // Counted, never refused here: the refusal applies to the next slug lookups.
      await this.limiter.hit(notFoundKey, notFoundPerIp.limit, notFoundPerIp.windowSeconds);
      throw notFound('Share');
    }
    return share;
  }

  async byId(id: string): Promise<LoadedShare | null> {
    return loadShare(this.db, eq(shares.id, id), billingOnline(this.config));
  }

  /**
   * SHARE_EXPIRED unless the share serves (revoked, expired, then unavailable). ADR 0010: a
   * disabled owner makes it `unavailable`, and the subscription gates only with
   * BILLING_MODE=gateway.
   */
  assertAvailable(share: LoadedShare): void {
    const availability = shareAvailability(
      {
        isActive: share.isActive,
        expiresAt: share.expiresAt,
        targetLive: share.targetLive,
        ownerStatus: share.ownerStatus,
        subscriptionGates: billingOnline(this.config),
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
    const share = await this.byToken(token, ctx);
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
