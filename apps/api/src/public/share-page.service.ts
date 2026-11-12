import { Inject, Injectable } from '@nestjs/common';
import { consents, files, shareFaceSearchAvailableSql } from '@shotx/db';
import {
  type ConsentPurpose,
  type ConsentResponse,
  consentGates,
  decodeOpaqueCursor,
  encodeOpaqueCursor,
  faceScanResultKey,
  type FaceDeletionInfoResponse,
  generateOpaqueToken,
  type ShareItemsResponse,
  shareItemsCursorSchema,
  type ShareMetaResponse,
  sharePublicPath,
  type SupportedLocale,
  shareUnlockKey,
  type Viewer,
  viewerColumns,
} from '@shotx/shared';
import { and, asc, eq, inArray, isNull, like, type SQL, sql } from 'drizzle-orm';
import { recordActivity, shareEventSource } from '../activity/activity';
import { verifyPassword } from '../auth/password';
import type { PublicContext } from '../auth/public.guard';
import type { ApiConfig } from '../config';
import { type Db, rows } from '../db/db';
import { DesignViews } from '../designs/design-views';
import { ApiError } from '../http/api-error';
import { sha256Hex } from '../http/client';
import { validationError } from '../http/zod';
import { SignedUrls } from '../media/signed-urls';
import { type LoadedShare, passwordFingerprint, ShareAccess } from '../share/share-access';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  KEY_VALUE_STORE,
  type KeyValueStore,
  RATE_LIMITER,
  type RateLimiter,
} from '../tokens';
import { type ShareItemRow, shareItemColumns, shareItemsScope, toShareItem } from './share-items';

export const faceSearchDisabled = () =>
  new ApiError('FEATURE_DISABLED', 'Face search is not available', { feature: 'face_search' });

/** Sort key of share items, as PostgreSQL text (full microseconds; see shareItemsCursorSchema). */
const ITEM_KEY = sql<string>`coalesce(${files.takenAt}, ${files.createdAt})`;

/** RATE_LIMITED with Retry-After. */
export async function enforceRate(
  limiter: RateLimiter,
  key: string,
  rule: { limit: number; windowSeconds: number },
): Promise<void> {
  const result = await limiter.hit(key, rule.limit, rule.windowSeconds);
  if (!result.allowed) {
    throw new ApiError('RATE_LIMITED', 'Too many requests; try again later', undefined, {
      'Retry-After': String(result.retryAfterSeconds),
    });
  }
}

/** Both identities of a browser: the resolved viewer and, when signed in, its anon session. */
export function browserViewers(ctx: PublicContext): Viewer[] {
  return ctx.viewer.kind === 'user'
    ? [ctx.viewer, { kind: 'anon', anonId: ctx.anonId }]
    : [ctx.viewer];
}

/** `consents` condition: the viewer's or session's rows of a share. */
export function consentOf(shareId: string, viewer: Viewer): SQL {
  const { viewerId, anonId } = viewerColumns(viewer);
  return and(
    eq(consents.shareId, shareId),
    viewerId !== null ? eq(consents.viewerId, viewerId) : eq(consents.anonId, anonId ?? ''),
  ) as SQL;
}

/**
 * GET /s/:token, GET /s/:token/items, POST /s/:token/unlock and the consent routes. Gates come
 * from ShareAccess; scope from fileInShareScopeSql plus the face_only grant.
 */
@Injectable()
export class SharePageService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ShareAccess) private readonly access: ShareAccess,
    @Inject(SignedUrls) private readonly urls: SignedUrls,
    @Inject(DesignViews) private readonly designs: DesignViews,
  ) {}

  /** FACE_SEARCH_ENABLED and a folder share with an active face index at, above or below it. */
  async faceSearchAvailable(share: LoadedShare): Promise<boolean> {
    if (!this.config.features.faceSearch) return false;
    if (share.targetType !== 'folder' || share.targetFolderId === null) return false;
    const [row] = await rows<{ ok: boolean }>(
      this.db,
      sql`SELECT ${shareFaceSearchAvailableSql(
        { ownerId: share.ownerId, targetFolderId: share.targetFolderId },
        this.clock.now(),
      )} AS ok`,
    );
    return row?.ok === true;
  }

  /**
   * A current (not withdrawn) consent of this viewer for the share, the current version and
   * `purpose`. A consent covers only its own purpose (a face_search consent never allows a face
   * deletion, and the reverse).
   */
  async hasConsent(
    share: { id: string },
    viewer: Viewer,
    purpose: ConsentPurpose = 'face_search',
  ): Promise<boolean> {
    const [row] = await this.db
      .select({ id: consents.id })
      .from(consents)
      .where(
        and(
          consentOf(share.id, viewer),
          eq(consents.purpose, purpose),
          eq(consents.policyVersion, this.config.consent.policyVersion),
          isNull(consents.withdrawnAt),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** FACE_MAX_SELFIES, FACE_SELFIE_LONG_EDGE and FACE_SELFIE_JPEG_QUALITY for the client. */
  private selfieSettings() {
    return {
      maxSelfies: this.config.face.search.maxSelfies,
      selfieLongEdge: this.config.face.selfie.longEdge,
      selfieJpegQuality: this.config.face.selfie.jpegQuality,
    };
  }

  // --- GET /s/:token -------------------------------------------------------------------------------

  async meta(token: string, ctx: PublicContext): Promise<ShareMetaResponse> {
    const share = await this.access.byToken(token, ctx);
    this.access.assertAvailable(share);
    const loginRequired = share.requireLogin && ctx.viewer.kind !== 'user';
    const locked = !(await this.access.isUnlocked(share, ctx));
    const open = !loginRequired && !locked;

    let details: ShareMetaResponse['details'] = null;
    let design: ShareMetaResponse['design'] = null;
    if (open) {
      const gallery = share.mode === 'gallery';
      let itemCount: number | null = null;
      let cover: NonNullable<ShareMetaResponse['details']>['cover'] = null;
      if (gallery) {
        const [count] = await this.db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(files)
          .where(shareItemsScope(share));
        itemCount = count?.n ?? 0;
        // ADR 0011: the folder's chosen cover while it is still a live, ready image in scope
        // (re-checked on every request: it may have been moved out, trashed or purged since),
        // else the first ready image in scope (items order).
        const coverColumns = {
          previewKey: files.previewKey,
          width: files.width,
          height: files.height,
        };
        const imageInScope = and(shareItemsScope(share), like(files.mime, 'image/%'));
        const [chosen] =
          share.coverFileId === null
            ? []
            : await this.db
                .select(coverColumns)
                .from(files)
                .where(and(imageInScope, eq(files.id, share.coverFileId)))
                .limit(1);
        const [first] =
          chosen?.previewKey != null
            ? [chosen]
            : await this.db
                .select(coverColumns)
                .from(files)
                .where(imageInScope)
                .orderBy(asc(ITEM_KEY), asc(files.id))
                .limit(1);
        if (first?.previewKey != null) {
          // No `view` event (PUBLIC_SHARE_ROUTE_ACTIVITY.meta is empty): SSR and link unfurlers
          // call this route, so views come only from items pages and face-search results.
          cover = {
            previewUrl: this.urls.view(first.previewKey, this.urls.viewExpiry()),
            width: first.width,
            height: first.height,
          };
        }
      }
      details = { title: share.targetName, photographerName: share.ownerName, itemCount, cover };
      // ADR 0013: behind the same gates as `details` (a design shows the event's name and logos).
      // No activity event, like the cover.
      design = await this.designs.shareDesign(share);
    }

    const available = await this.faceSearchAvailable(share);
    return {
      token: share.token,
      slug: share.slug,
      path: sharePublicPath(share),
      targetType: share.targetType,
      mode: share.mode,
      allowDownload: share.allowDownload,
      downloadSize: share.downloadSize,
      requireLogin: share.requireLogin,
      passwordProtected: share.passwordHash !== null,
      expiresAt: share.expiresAt === null ? null : share.expiresAt.toISOString(),
      access: { loginRequired, locked },
      details,
      design,
      faceSearch: {
        available,
        policyVersion: available ? this.config.consent.policyVersion : null,
        consented: available && (await this.hasConsent(share, ctx.viewer, 'face_search')),
        ...this.selfieSettings(),
        resultTtlSeconds: this.config.share.faceOnlyGrantTtlSeconds,
      },
      zip: { maxFiles: this.config.share.zip.maxFiles },
    };
  }

  // --- GET /s/:token/items -------------------------------------------------------------------------

  /**
   * One page of ready, live files in scope, by (coalesce(taken_at, created_at), id). In face_only
   * mode only files of the viewer's face-search result (an empty page without one). One `view`
   * activity event per page.
   */
  async items(
    token: string,
    ctx: PublicContext,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<ShareItemsResponse> {
    const share = await this.access.open(token, ctx);
    const limit = query.limit ?? this.config.share.pageSize;
    let after: { key: string; id: string } | null = null;
    if (query.cursor !== undefined) {
      const cursor = decodeOpaqueCursor(shareItemsCursorSchema, query.cursor);
      if (cursor === null || cursor.shareId !== share.id) {
        throw validationError(['query', 'cursor'], 'is not a valid cursor for this share');
      }
      after = cursor;
    }
    const grant = await this.access.grant(share, ctx.viewer);
    let found: (ShareItemRow & { key: string })[] = [];
    if (share.mode === 'gallery' || grant !== null) {
      found = await this.pageRows(share, grant, after, limit);
    }
    const shown = found.slice(0, limit);
    const last = shown.at(-1);
    await recordActivity(this.db, {
      type: 'view',
      ...shareEventSource(share, ctx.viewer),
      fileId: null,
      bytes: 0,
      meta: { items: shown.length },
    });
    const expiresAt = this.urls.viewExpiry();
    return {
      items: shown.map((row) => toShareItem(row, this.urls, expiresAt)),
      nextCursor:
        found.length > limit && last !== undefined
          ? encodeOpaqueCursor(shareItemsCursorSchema, {
              v: 1,
              shareId: share.id,
              key: last.key,
              id: last.id,
            })
          : null,
    };
  }

  private pageRows(
    share: LoadedShare,
    grant: ReadonlySet<string> | null,
    after: { key: string; id: string } | null,
    limit: number,
  ) {
    return this.db
      .select({ ...shareItemColumns, key: sql<string>`${ITEM_KEY}::text` })
      .from(files)
      .where(
        and(
          shareItemsScope(share),
          share.mode === 'face_only' ? inArray(files.id, [...(grant ?? [])]) : undefined,
          after === null
            ? undefined
            : sql`(${ITEM_KEY}, ${files.id}) > (${after.key}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(asc(ITEM_KEY), asc(files.id))
      .limit(limit + 1);
  }

  // --- POST /s/:token/unlock -----------------------------------------------------------------------

  /**
   * Checks the password (argon2id) and sets the share's unlock cookie: an opaque token whose
   * SHA-256 maps, in Redis, to the password fingerprint (TTL SHARE_UNLOCK_TTL_SECONDS). Rate-limited
   * per IP and share before the password is checked. Returns the cookie value and the share's
   * token (the cookie's path is always `/api/s/{token}`, also when the request used the slug,
   * ADR 0011), or null on a share without a password (no-op).
   */
  async unlock(
    token: string,
    ctx: PublicContext,
    password: string,
  ): Promise<{ cookie: string; shareToken: string } | null> {
    const share = await this.access.byToken(token, ctx);
    this.access.assertAvailable(share);
    if (share.requireLogin && ctx.viewer.kind !== 'user') {
      throw new ApiError('LOGIN_REQUIRED', 'Sign in to open this share');
    }
    await enforceRate(
      this.limiter,
      `share-unlock:${share.id}:${ctx.ipHash}`,
      this.config.share.rateLimits.unlockPerIp,
    );
    if (share.passwordHash === null) return null;
    if (!(await verifyPassword(password, share.passwordHash))) {
      throw new ApiError('PASSWORD_INCORRECT', 'Wrong password');
    }
    const cookie = generateOpaqueToken();
    await this.store.setWithTtl(
      shareUnlockKey(share.id, sha256Hex(cookie)),
      passwordFingerprint(share.passwordHash),
      this.config.share.unlockTtlSeconds,
    );
    return { cookie, shareToken: share.token };
  }

  // --- POST /s/:token/consent ----------------------------------------------------------------------

  /**
   * Records consent of `purpose` to the current policy version for this viewer or session. The
   * gates follow the purpose (consentGates): `face_search` needs an open share (availability,
   * login, password) and FACE_SEARCH_ENABLED; `face_deletion` only the token, so the PDPA
   * deletion flow works on revoked or expired shares, without unlocking and with the flag off.
   * Then a well-formed but other version is CONSENT_VERSION_MISMATCH with the current one.
   * Idempotent per purpose: INSERT ON CONFLICT DO NOTHING on the partial unique indexes (share,
   * viewer|anon, purpose, version), then SELECT. Stores ip_hash, never the address.
   */
  async giveConsent(
    token: string,
    ctx: PublicContext,
    body: { purpose: ConsentPurpose; policyVersion: string; locale: SupportedLocale },
  ): Promise<ConsentResponse> {
    const gates = consentGates(body.purpose);
    const share = await this.access.byToken(token, ctx);
    if (gates.availability) this.access.assertAvailable(share);
    if (gates.access) await this.access.assertAccess(share, ctx);
    if (gates.featureFlag && !this.config.features.faceSearch) throw faceSearchDisabled();
    const current = this.config.consent.policyVersion;
    if (body.policyVersion !== current) {
      throw new ApiError('CONSENT_VERSION_MISMATCH', 'The consent text has a newer version', {
        policyVersion: current,
      });
    }
    await this.db
      .insert(consents)
      .values({
        shareId: share.id,
        ...viewerColumns(ctx.viewer),
        purpose: body.purpose,
        policyVersion: current,
        // ADR 0011: the language the text was shown in; the first acceptance's stays.
        locale: body.locale,
        ipHash: ctx.ipHash,
        acceptedAt: this.clock.now(),
      })
      .onConflictDoNothing();
    const [row] = await this.db
      .select({ acceptedAt: consents.acceptedAt, locale: consents.locale })
      .from(consents)
      .where(
        and(
          consentOf(share.id, ctx.viewer),
          eq(consents.purpose, body.purpose),
          eq(consents.policyVersion, current),
          isNull(consents.withdrawnAt),
        ),
      )
      .limit(1);
    if (row === undefined) throw new Error('Consent vanished after insert');
    return {
      purpose: body.purpose,
      policyVersion: current,
      locale: row.locale,
      acceptedAt: row.acceptedAt.toISOString(),
    };
  }

  // --- GET /s/:token/face-deletion -----------------------------------------------------------------

  /**
   * What the "ขอลบใบหน้าของฉัน" page needs. Token lookup only (consentGates('face_deletion')): it
   * answers on revoked, expired and unavailable shares, behind login and password, and with
   * FACE_SEARCH_ENABLED=false. Writes no activity event.
   */
  async faceDeletionInfo(token: string, ctx: PublicContext): Promise<FaceDeletionInfoResponse> {
    const share = await this.access.byToken(token, ctx);
    return {
      policyVersion: this.config.consent.policyVersion,
      consented: await this.hasConsent(share, ctx.viewer, 'face_deletion'),
      ...this.selfieSettings(),
    };
  }

  // --- DELETE /s/:token/consent --------------------------------------------------------------------

  /**
   * Withdraws every current consent, of every purpose, of this browser (the viewer and, when signed in, its anon
   * session) for the share and deletes their face-search results (the face_only grant). Works on
   * revoked or expired shares and while face search is disabled; only the token must exist.
   */
  async withdrawConsent(token: string, ctx: PublicContext): Promise<void> {
    const share = await this.access.byToken(token, ctx);
    const viewers = browserViewers(ctx);
    const now = this.clock.now();
    for (const viewer of viewers) {
      await this.db
        .update(consents)
        .set({
          withdrawnAt: sql`greatest(${now.toISOString()}::timestamptz, ${consents.acceptedAt})`,
        })
        .where(and(consentOf(share.id, viewer), isNull(consents.withdrawnAt)));
    }
    await this.store.del(...viewers.map((viewer) => faceScanResultKey(share.id, viewer)));
  }
}
