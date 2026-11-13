import { Inject, Injectable } from '@nestjs/common';
import { files, folders, shareDailyStats, shareDesigns, shares } from '@shotx/db';
import {
  authProvidersOf,
  type createShareBodySchema,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
  generateShareToken,
  type ListSharesResponse,
  type OwnerShare,
  ownerShareStatus,
  SHARE_LIST_PAGE_SIZE_LIMIT,
  SHARE_STATS_MAX_DAYS,
  shareListCursorSchema,
  shareModeAllowedForTarget,
  type ShareStatsResponse,
  type ShareStatsValues,
  sharePublicPath,
  sharePublicUrl,
  shareSlugCandidate,
  shareSlugSourceName,
  SHARE_SLUG_MAX_ATTEMPTS,
  slugifyEventName,
  subscriptionAllowsSharing,
  type updateShareBodySchema,
  viewerLoginAvailable,
} from '@shotx/shared';
import { and, asc, desc, eq, gte, isNull, lt, lte, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { hashPassword } from '../auth/password';
import { type ApiConfig, billingOnline } from '../config';
import { type Db, isUniqueViolation, pgErrorInfo, type Queryable } from '../db/db';
import { currentSubscription } from '../drive/account';
import { liveFolder } from '../drive/folders';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { API_CONFIG, CLOCK, type Clock, DATABASE } from '../tokens';

type CreateBody = z.output<typeof createShareBodySchema>;
type UpdateBody = z.output<typeof updateShareBodySchema>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Default stats range: the last 30 days up to today (Bangkok). */
const DEFAULT_STATS_DAYS = 30;
/** A fresh token on the (astronomically unlikely) unique violation. */
const TOKEN_ATTEMPTS = 3;

const featureDisabled = () =>
  new ApiError('FEATURE_DISABLED', 'Face search is not available', { feature: 'face_search' });

/** The calendar day of `at` in Asia/Bangkok, `YYYY-MM-DD`. */
export function bangkokDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** `date` plus `days` days (calendar arithmetic on `YYYY-MM-DD`). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included. */
function daysInclusive(from: string, to: string): number {
  return (
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY) + 1
  );
}

/**
 * Owner share routes. Every query filters by the photographer the guard resolved; shares, files
 * and folders of other owners are NOT_FOUND. Tokens come from the CSPRNG (generateShareToken),
 * passwords are stored as argon2id hashes and never returned.
 */
@Injectable()
export class SharesService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private async rows(q: Queryable, where: SQL, limit?: number) {
    const query = q
      .select({
        share: shares,
        fileName: files.name,
        fileUnavailable: sql<boolean>`(${files.deletedAt} IS NOT NULL OR ${files.purgeRequestedAt} IS NOT NULL)`,
        folderName: folders.name,
        folderUnavailable: sql<boolean>`(${folders.deletedAt} IS NOT NULL OR ${folders.purgeRequestedAt} IS NOT NULL)`,
      })
      .from(shares)
      .leftJoin(files, and(eq(files.id, shares.targetFileId), eq(files.ownerId, shares.ownerId)))
      .leftJoin(
        folders,
        and(eq(folders.id, shares.targetFolderId), eq(folders.ownerId, shares.ownerId)),
      )
      .where(where)
      .orderBy(desc(shares.id));
    return limit === undefined ? query : query.limit(limit);
  }

  private toOwnerShare(row: Awaited<ReturnType<SharesService['rows']>>[number]): OwnerShare {
    const { share } = row;
    const isFile = share.targetType === 'file';
    const targetId = isFile ? share.targetFileId : share.targetFolderId;
    if (targetId === null) throw new Error('Share without a target');
    return {
      id: share.id,
      token: share.token,
      slug: share.slug,
      path: sharePublicPath(share),
      url: sharePublicUrl(this.config.app.publicBaseUrl, share),
      target: {
        type: share.targetType,
        id: targetId,
        name: (isFile ? row.fileName : row.folderName) ?? '',
        unavailable: (isFile ? row.fileUnavailable : row.folderUnavailable) ?? true,
      },
      mode: share.mode,
      allowDownload: share.allowDownload,
      downloadSize: share.downloadSize,
      requireLogin: share.requireLogin,
      passwordProtected: share.passwordHash !== null,
      expiresAt: share.expiresAt === null ? null : share.expiresAt.toISOString(),
      designId: share.designId,
      status: ownerShareStatus(share, this.clock.now()),
      createdAt: share.createdAt.toISOString(),
    };
  }

  private async ownerShare(q: Queryable, ownerId: string, id: string): Promise<OwnerShare> {
    const [row] = await this.rows(q, and(eq(shares.id, id), eq(shares.ownerId, ownerId)) as SQL, 1);
    if (row === undefined) throw notFound('Share');
    return this.toOwnerShare(row);
  }

  /** A future expiry, else VALIDATION_FAILED. */
  private expiry(value: string | null, path: string[]): Date | null {
    if (value === null) return null;
    const at = new Date(value);
    if (at.getTime() <= this.clock.now().getTime())
      throw validationError(path, 'must be in the future');
    return at;
  }

  /**
   * LOGIN_PROVIDER_UNAVAILABLE for `requireLogin: true` while no viewer could sign in: the API
   * issues tokens and neither LINE nor Google is configured nor the dev login on
   * (viewerLoginAvailable). Never with AUTH_PROVIDER=cognito.
   */
  private assertViewerLoginAvailable(requireLogin: boolean | undefined): void {
    const auth = this.config.shotxAuth;
    if (requireLogin !== true || auth === null) return;
    if (!viewerLoginAvailable(authProvidersOf(auth))) {
      throw new ApiError(
        'LOGIN_PROVIDER_UNAVAILABLE',
        'No viewer sign-in (LINE or Google) is configured, so a share cannot require login',
      );
    }
  }

  /**
   * DESIGN_NOT_FOUND unless `designId` is one of the caller's designs. Locked FOR KEY SHARE until
   * the share write commits, so the design can't be deleted in between (the foreign key on
   * (design_id, owner_id) would refuse it anyway).
   */
  private async assertOwnDesign(q: Queryable, ownerId: string, designId: string): Promise<void> {
    const [design] = await q
      .select({ id: shareDesigns.id })
      .from(shareDesigns)
      .where(and(eq(shareDesigns.id, designId), eq(shareDesigns.ownerId, ownerId)))
      .for('key share');
    if (design === undefined) {
      throw new ApiError('DESIGN_NOT_FOUND', 'No design of yours has this id');
    }
  }

  // --- POST /shares ----------------------------------------------------------------------------

  async create(ownerId: string, body: CreateBody): Promise<OwnerShare> {
    if (body.mode === 'face_only' && !this.config.features.faceSearch) throw featureDisabled();
    this.assertViewerLoginAvailable(body.requireLogin);
    const expiresAt = this.expiry(body.expiresAt, ['body', 'expiresAt']);
    const passwordHash =
      body.password === null
        ? null
        : await hashPassword(body.password, this.config.password.argon2id);
    return this.db.transaction(async (tx) => {
      // ADR 0010: only with BILLING_MODE=gateway does sharing need a subscription.
      if (billingOnline(this.config)) {
        const subscription = await currentSubscription(tx, ownerId);
        if (!subscriptionAllowsSharing(subscription?.status ?? null)) {
          throw new ApiError('SUBSCRIPTION_INACTIVE', 'Sharing needs an active subscription', {
            status: subscription?.status ?? null,
          });
        }
      }
      let target: { targetFileId: string | null; targetFolderId: string | null };
      let targetName: string;
      if (body.target.type === 'file') {
        const [file] = await tx
          .select({ id: files.id, name: files.name })
          .from(files)
          .where(
            and(
              eq(files.id, body.target.fileId),
              eq(files.ownerId, ownerId),
              eq(files.status, 'ready'),
              isNull(files.deletedAt),
              isNull(files.purgeRequestedAt),
            ),
          )
          .for('share');
        if (file === undefined) throw notFound('File');
        target = { targetFileId: file.id, targetFolderId: null };
        targetName = file.name;
      } else {
        const folder = await liveFolder(tx, ownerId, body.target.folderId, 'share');
        if (folder === null || folder.purgeRequestedAt !== null) throw notFound('Folder');
        target = { targetFileId: null, targetFolderId: folder.id };
        targetName = folder.name;
      }
      if (body.designId !== null) await this.assertOwnDesign(tx, ownerId, body.designId);
      // ADR 0011: the readable ref, from the target's name; the base first, then suffixed
      // candidates while `shares_slug_unique` says taken. Never changed afterwards.
      const slugBase = slugifyEventName(shareSlugSourceName(body.target.type, targetName));
      let slugAttempt = 0;
      for (let tokenAttempt = 1; ;) {
        try {
          const [share] = await tx.transaction((sp) =>
            sp
              .insert(shares)
              .values({
                ownerId,
                targetType: body.target.type,
                ...target,
                token: generateShareToken(),
                slug: shareSlugCandidate(slugBase, slugAttempt),
                mode: body.mode,
                allowDownload: body.allowDownload,
                downloadSize: body.downloadSize,
                requireLogin: body.requireLogin,
                passwordHash,
                expiresAt,
                designId: body.designId,
              })
              .returning({ id: shares.id }),
          );
          if (share === undefined) throw new Error('Share insert returned no row');
          return this.ownerShare(tx, ownerId, share.id);
        } catch (error) {
          const constraint = isUniqueViolation(error) ? pgErrorInfo(error)?.constraint : undefined;
          if (constraint === 'shares_slug_unique' && slugAttempt + 1 < SHARE_SLUG_MAX_ATTEMPTS) {
            slugAttempt++;
          } else if (constraint === 'shares_token_unique' && tokenAttempt < TOKEN_ATTEMPTS) {
            tokenAttempt++;
          } else {
            throw error;
          }
        }
      }
    });
  }

  // --- GET /shares -------------------------------------------------------------------------------

  async list(
    ownerId: string,
    query: { cursor?: string; limit?: number; fileId?: string; folderId?: string },
  ): Promise<ListSharesResponse> {
    const limit = query.limit ?? Math.min(this.config.share.pageSize, SHARE_LIST_PAGE_SIZE_LIMIT);
    let after: string | null = null;
    if (query.cursor !== undefined) {
      const cursor = decodeOpaqueCursor(shareListCursorSchema, query.cursor);
      if (cursor === null) throw validationError(['query', 'cursor'], 'is not a valid cursor');
      after = cursor.id;
    }
    const found = await this.rows(
      this.db,
      and(
        eq(shares.ownerId, ownerId),
        query.fileId === undefined ? undefined : eq(shares.targetFileId, query.fileId),
        query.folderId === undefined ? undefined : eq(shares.targetFolderId, query.folderId),
        after === null ? undefined : lt(shares.id, after),
      ) as SQL,
      limit + 1,
    );
    const shown = found.slice(0, limit);
    const last = shown.at(-1);
    return {
      items: shown.map((row) => this.toOwnerShare(row)),
      nextCursor:
        found.length > limit && last !== undefined
          ? encodeOpaqueCursor(shareListCursorSchema, { v: 1, id: last.share.id })
          : null,
    };
  }

  // --- GET /shares/:id ---------------------------------------------------------------------------

  get(ownerId: string, id: string): Promise<OwnerShare> {
    return this.ownerShare(this.db, ownerId, id);
  }

  // --- PATCH /shares/:id -------------------------------------------------------------------------

  /**
   * Changes settings of a share that isn't revoked (CONFLICT). Switching to face_only follows the
   * create rules (folder target, FACE_SEARCH_ENABLED). A new or removed password changes the
   * hash, so every earlier unlock proof stops matching (ShareAccess.isUnlocked).
   */
  async update(ownerId: string, id: string, body: UpdateBody): Promise<OwnerShare> {
    // Only when turning it on: an existing require_login share stays editable.
    this.assertViewerLoginAvailable(body.requireLogin);
    const passwordHash =
      body.password === undefined
        ? undefined
        : body.password === null
          ? null
          : await hashPassword(body.password, this.config.password.argon2id);
    return this.db.transaction(async (tx) => {
      const [share] = await tx
        .select()
        .from(shares)
        .where(and(eq(shares.id, id), eq(shares.ownerId, ownerId)))
        .for('update');
      if (share === undefined) throw notFound('Share');
      if (!share.isActive) throw new ApiError('CONFLICT', 'A revoked share cannot be changed');
      if (body.mode === 'face_only' && share.mode !== 'face_only') {
        if (!this.config.features.faceSearch) throw featureDisabled();
        if (!shareModeAllowedForTarget('face_only', share.targetType)) {
          throw validationError(['body', 'mode'], 'face_only shares must target a folder');
        }
      }
      const expiresAt =
        body.expiresAt === undefined
          ? undefined
          : this.expiry(body.expiresAt, ['body', 'expiresAt']);
      if (body.designId !== undefined && body.designId !== null) {
        await this.assertOwnDesign(tx, ownerId, body.designId);
      }
      await tx
        .update(shares)
        .set({
          ...(body.mode === undefined ? {} : { mode: body.mode }),
          ...(body.allowDownload === undefined ? {} : { allowDownload: body.allowDownload }),
          ...(body.downloadSize === undefined ? {} : { downloadSize: body.downloadSize }),
          ...(body.requireLogin === undefined ? {} : { requireLogin: body.requireLogin }),
          ...(passwordHash === undefined ? {} : { passwordHash }),
          ...(expiresAt === undefined ? {} : { expiresAt }),
          ...(body.designId === undefined ? {} : { designId: body.designId }),
          // ADR 0016: unpublish keeps the first pause time; publish clears it. Same link either way.
          ...(body.paused === undefined
            ? {}
            : { pausedAt: body.paused ? (share.pausedAt ?? this.clock.now()) : null }),
        })
        .where(and(eq(shares.id, id), eq(shares.ownerId, ownerId)));
      return this.ownerShare(tx, ownerId, id);
    });
  }

  // --- DELETE /shares/:id ------------------------------------------------------------------------

  /** Revokes (is_active = false). Final and idempotent. */
  async revoke(ownerId: string, id: string): Promise<void> {
    const [found] = await this.db
      .update(shares)
      .set({ isActive: false })
      .where(and(eq(shares.id, id), eq(shares.ownerId, ownerId)))
      .returning({ id: shares.id });
    if (found === undefined) throw notFound('Share');
  }

  // --- GET /shares/:id/stats ---------------------------------------------------------------------

  /** Days of share_daily_stats (the hourly rollup); dashboards never read raw events. */
  async stats(
    ownerId: string,
    id: string,
    query: { from?: string; to?: string },
  ): Promise<ShareStatsResponse> {
    const [share] = await this.db
      .select({ id: shares.id })
      .from(shares)
      .where(and(eq(shares.id, id), eq(shares.ownerId, ownerId)));
    if (share === undefined) throw notFound('Share');
    const to =
      query.to ??
      (query.from === undefined
        ? bangkokDate(this.clock.now())
        : addDays(query.from, DEFAULT_STATS_DAYS - 1));
    const from = query.from ?? addDays(to, -(DEFAULT_STATS_DAYS - 1));
    if (from > to) throw validationError(['query', 'from'], 'must not be after to');
    if (daysInclusive(from, to) > SHARE_STATS_MAX_DAYS) {
      throw validationError(['query'], `the range must be at most ${SHARE_STATS_MAX_DAYS} days`);
    }
    const days = await this.db
      .select()
      .from(shareDailyStats)
      .where(
        and(
          eq(shareDailyStats.shareId, id),
          eq(shareDailyStats.photographerId, ownerId),
          gte(shareDailyStats.date, from),
          lte(shareDailyStats.date, to),
        ),
      )
      .orderBy(asc(shareDailyStats.date));
    const values = (d: (typeof days)[number]): ShareStatsValues => ({
      visitors: d.visitors,
      scanners: d.scanners,
      scans: d.scans,
      downloads: d.downloads,
      uniqueDownloaders: d.uniqueDownloaders,
      zips: d.zips,
      bytesOut: d.bytesOut,
    });
    const totals: ShareStatsValues = {
      visitors: 0,
      scanners: 0,
      scans: 0,
      downloads: 0,
      uniqueDownloaders: 0,
      zips: 0,
      bytesOut: 0,
    };
    for (const d of days) {
      const v = values(d);
      for (const k of Object.keys(totals) as (keyof ShareStatsValues)[]) totals[k] += v[k];
    }
    const newest = days.at(-1);
    return {
      shareId: id,
      from,
      to,
      totals,
      days: days.map((d) => ({ date: d.date, ...values(d) })),
      rolledUpAt: newest === undefined ? null : newest.updatedAt.toISOString(),
    };
  }
}
