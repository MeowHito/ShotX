import { Inject, Injectable, type LoggerService } from '@nestjs/common';
import {
  type FaceProvider,
  faceCollectionId,
  ImageTooLargeError,
  NoFaceDetectedError,
  RateLimitedError,
  type SelfieSearchResult,
  bucketByFile,
  searchBySelfies,
  selfieSearchOptions,
  UnreadableImageError,
} from '@shotx/face';
import { faceDeletions, faceFeedback, faces, files, searchableFaceSql } from '@shotx/db';
import {
  CAPTCHA_TOKEN_HEADER,
  type CaptchaAction,
  type CaptchaRejectReason,
  captchaTokenSchema,
  type ConsentPurpose,
  type RateLimitedDetails,
  TURNSTILE_ACTIONS,
  FACE_DELETION_ALERT_EVENT,
  faceDeletionAlertDue,
  type FaceDeletionResponse,
  type FaceSearchResponse,
  faceScanResultKey,
  SELFIE_FIELD_NAME,
  mergeFaceScanResult,
  viewerKey,
} from '@shotx/shared';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Request } from 'express';
import { recordActivity, shareEventSource } from '../activity/activity';
import type { PublicContext } from '../auth/public.guard';
import { type ApiConfig, clientIpTrust } from '../config';
import { type Db, pgErrorInfo, SQLSTATE } from '../db/db';
import { ApiError } from '../http/api-error';
import { clientIp, sha256Hex } from '../http/client';
import { readSelfies } from '../http/multipart';
import type { EventLog } from '../infra/events';
import { SignedUrls } from '../media/signed-urls';
import { type LoadedShare, ShareAccess } from '../share/share-access';
import {
  API_CONFIG,
  API_LOGGER,
  CLOCK,
  type Clock,
  DATABASE,
  EVENT_LOG,
  FACE_PROVIDER,
  KEY_VALUE_STORE,
  type KeyValueStore,
  QUEUE_SENDER,
  type QueueSender,
  RATE_LIMITER,
  type RateLimiter,
} from '../tokens';
import { scopedItemRows, shareItemsScope, toShareItem } from './share-items';
import { CAPTCHA_VERIFIER, type CaptchaVerifier } from './captcha';
import { enforceRate, faceSearchDisabled, SharePageService } from './share-page.service';

/**
 * Redis key of a captcha grant: attempts left for one share, viewer and client IP (ip_hash),
 * hashed so the key carries no ids in the clear. Value: the count; TTL CAPTCHA_GRANT_TTL_SECONDS.
 */
export const captchaGrantKey = (shareId: string, viewer: string, ipHash: string) =>
  `captcha-grant:${sha256Hex(`${shareId}|${viewer}|${ipHash}`)}`;

/** Largest id list in one `= ANY(...)` lookup. */
const FACE_ID_CHUNK = 5000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The collection doesn't exist yet: nothing was ever indexed for this photographer. */
function isMissingCollection(error: unknown): boolean {
  return error instanceof Error && error.name === 'ResourceNotFoundException';
}

/**
 * Face search, "ไม่ใช่ฉัน" feedback and "ขอลบใบหน้าของฉัน". Rekognition is only reached through the
 * FaceProvider and searchBySelfies of @shotx/face, on `faceCollectionId(share owner)`, and only
 * after FACE_SEARCH_ENABLED, the share gates and a current consent. Selfies stay in memory, are
 * zeroed after use, and are never logged, stored or put in an error.
 */
@Injectable()
export class FaceService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(QUEUE_SENDER) private readonly queue: QueueSender,
    @Inject(FACE_PROVIDER) private readonly provider: FaceProvider,
    @Inject(ShareAccess) private readonly access: ShareAccess,
    @Inject(SharePageService) private readonly page: SharePageService,
    @Inject(SignedUrls) private readonly urls: SignedUrls,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(API_LOGGER) private readonly logger: LoggerService,
    @Inject(EVENT_LOG) private readonly events: EventLog,
    @Inject(CAPTCHA_VERIFIER) private readonly captchaVerifier: CaptchaVerifier | null,
  ) {}

  /**
   * CONSENT_REQUIRED unless the viewer consented to the current version for this share, for this
   * purpose (a face_search consent doesn't allow a deletion, nor the reverse).
   */
  private async requireConsent(
    share: LoadedShare,
    ctx: PublicContext,
    purpose: ConsentPurpose,
  ): Promise<void> {
    if (!(await this.page.hasConsent(share, ctx.viewer, purpose))) {
      throw new ApiError('CONSENT_REQUIRED', 'Consent is required before a face scan', {
        policyVersion: this.config.consent.policyVersion,
      });
    }
  }

  /**
   * FACE_SEARCH_RATE_* per IP, share and viewer; face search and face deletion share them. Runs
   * before any selfie is read. Under the limits the captcha header is ignored. Over a limit
   * (ADR 0008 section 7, config/captcha.ts):
   *
   * 1. a live captcha grant for this share, viewer and client IP lets the request through (one of
   *    its CAPTCHA_GRANT_ATTEMPTS; the Rekognition buckets still apply);
   * 2. else with CAPTCHA_PROVIDER=turnstile and CAPTCHA_GRANTS_PER_IP left for the IP: without a
   *    token, RATE_LIMITED with `details.captcha` (solve and repeat); with one, siteverify, and on
   *    a pass a new grant whose first attempt is this request; on a failure RATE_LIMITED with
   *    `captcha.rejected` (fail closed, no grant);
   * 3. else (waf, none, or the IP's grants used up) RATE_LIMITED with `captcha: null`.
   */
  private async rateLimit(
    share: LoadedShare,
    ctx: PublicContext,
    req: Request,
    action: CaptchaAction,
  ): Promise<void> {
    const rules = this.config.face.searchRateLimits;
    const checks: [string, { limit: number; windowSeconds: number }][] = [
      [`face-search:ip:${ctx.ipHash}`, rules.perIp],
      [`face-search:share:${share.id}`, rules.perShare],
      [`face-search:viewer:${viewerKey(ctx.viewer)}`, rules.perViewer],
    ];
    let retryAfterSeconds = 0;
    for (const [key, rule] of checks) {
      const result = await this.limiter.hit(key, rule.limit, rule.windowSeconds);
      if (!result.allowed) {
        retryAfterSeconds = result.retryAfterSeconds;
        break;
      }
    }
    if (retryAfterSeconds === 0) return;

    const grantKey = captchaGrantKey(share.id, viewerKey(ctx.viewer), ctx.ipHash);
    if ((await this.store.decrementIfPositive(grantKey)) !== null) return;

    const captcha = this.config.captcha;
    const limited = (details: RateLimitedDetails['captcha']) =>
      new ApiError(
        'RATE_LIMITED',
        'Too many requests; try again later',
        {
          retryAfterSeconds,
          captcha: details,
        } satisfies RateLimitedDetails,
        { 'Retry-After': String(retryAfterSeconds) },
      );
    if (captcha.provider !== 'turnstile' || this.captchaVerifier === null) throw limited(null);
    const { grant } = captcha;
    const perIpKey = `captcha-grants:ip:${ctx.ipHash}`;
    if (!(await this.limiter.peek(perIpKey, grant.perIp, grant.perIpWindowSeconds)).allowed) {
      throw limited(null);
    }
    const challenge = (rejected: CaptchaRejectReason | null) =>
      limited({ provider: 'turnstile', action, rejected });

    const header = req.headers[CAPTCHA_TOKEN_HEADER];
    if (header === undefined) throw challenge(null);
    const token = captchaTokenSchema.safeParse(Array.isArray(header) ? header[0] : header);
    if (!token.success) throw challenge('invalid');
    const verdict = await this.captchaVerifier.verify({
      token: token.data,
      remoteIp: clientIp(req, clientIpTrust(this.config)),
      action,
    });
    if (!verdict.ok) throw challenge(verdict.reason);
    // Counted at issue: a pass beyond the IP's budget (a concurrent one won) buys nothing.
    if (!(await this.limiter.hit(perIpKey, grant.perIp, grant.perIpWindowSeconds)).allowed) {
      throw limited(null);
    }
    // This request is the grant's first attempt.
    await this.store.setWithTtl(grantKey, String(grant.attempts - 1), grant.ttlSeconds);
  }

  private readSelfies(req: Request): Promise<Buffer[]> {
    return readSelfies(req, {
      maxSelfies: this.config.face.search.maxSelfies,
      maxSelfieBytes: this.config.faceUpload.maxSelfieBytes,
      maxBodyBytes: this.config.faceUpload.maxBodyBytes,
    });
  }

  /** searchBySelfies, then the selfies are zeroed whatever happens. */
  private async search(
    selfies: Buffer[],
    options: ReturnType<typeof selfieSearchOptions>,
  ): Promise<SelfieSearchResult> {
    try {
      return await searchBySelfies(this.provider, selfies, options);
    } catch (error) {
      if (error instanceof NoFaceDetectedError) {
        throw new ApiError('NO_FACE_DETECTED', 'No face was found in the photos', {
          selfies: selfies.length,
          selfiesWithoutFace: selfies.length,
        });
      }
      if (isMissingCollection(error)) return { matches: [], selfiesWithoutFace: 0, seeds: 0 };
      // Self-hosted inference is busy (InferenceSlots, ADR 0009 section 5): ask to retry later.
      if (error instanceof RateLimitedError) {
        const retryAfterSeconds = Math.max(1, Math.ceil(error.waitMs / 1000));
        throw new ApiError(
          'RATE_LIMITED',
          'Face search is busy; try again shortly',
          { retryAfterSeconds, captcha: null },
          { 'Retry-After': String(retryAfterSeconds) },
        );
      }
      // A selfie that passed the magic-byte check but can't be decoded within the limits.
      if (error instanceof UnreadableImageError || error instanceof ImageTooLargeError) {
        throw new ApiError('VALIDATION_FAILED', 'Request validation failed', {
          issues: [{ path: ['body', SELFIE_FIELD_NAME], message: 'selfie could not be read' }],
        });
      }
      throw error;
    } finally {
      for (const selfie of selfies) selfie.fill(0);
    }
  }

  // --- POST /s/:token/face-search ------------------------------------------------------------------

  async faceSearch(token: string, ctx: PublicContext, req: Request): Promise<FaceSearchResponse> {
    const share = await this.access.open(token, ctx);
    if (!this.config.features.faceSearch) throw faceSearchDisabled();
    if (share.targetType !== 'folder') {
      throw new ApiError('FACE_SEARCH_UNAVAILABLE', 'Face search needs a folder share', {
        reason: 'not_folder_share',
      });
    }
    if (!(await this.page.faceSearchAvailable(share))) {
      throw new ApiError('FACE_SEARCH_UNAVAILABLE', 'Face search is not set up for this share', {
        reason: 'not_indexed',
      });
    }
    await this.requireConsent(share, ctx, 'face_search');
    await this.rateLimit(share, ctx, req, TURNSTILE_ACTIONS.faceSearch);

    const selfies = await this.readSelfies(req);
    const selfieCount = selfies.length;
    const result = await this.search(
      selfies,
      selfieSearchOptions(this.config.face, faceCollectionId(share.ownerId)),
    );

    // Face ids -> files: searchable faces of the share owner, on files in the share's scope.
    const fileOfFace = new Map<string, string>();
    const faceIds = [...new Set(result.matches.map((m) => m.faceId))];
    for (const ids of chunks(faceIds, FACE_ID_CHUNK)) {
      const found = await this.db
        .select({ faceId: faces.rekognitionFaceId, fileId: faces.fileId })
        .from(faces)
        .innerJoin(files, and(eq(files.id, faces.fileId), eq(files.ownerId, faces.ownerId)))
        .where(
          and(
            inArray(faces.rekognitionFaceId, ids),
            eq(faces.ownerId, share.ownerId),
            searchableFaceSql(),
            shareItemsScope(share),
          ),
        );
      for (const row of found) fileOfFace.set(row.faceId, row.fileId);
    }
    const hits = bucketByFile(
      result.matches,
      (faceId) => fileOfFace.get(faceId),
      this.config.face.thresholds,
    );

    // Merge into the viewer's result (the face_only grant) and reset its TTL in one atomic step
    // (a Lua script in Redis): each file keeps its best similarity, so concurrent scans of the
    // same viewer never lose each other's matches.
    await this.store.hashMergeMaxWithTtl(
      faceScanResultKey(share.id, ctx.viewer),
      mergeFaceScanResult(
        {},
        hits.map((h) => ({ fileId: h.fileId, similarity: h.similarity })),
      ),
      this.config.share.faceOnlyGrantTtlSeconds,
    );

    const rows = new Map(
      (
        await scopedItemRows(
          this.db,
          share,
          hits.map((h) => h.fileId),
        )
      ).map((r) => [r.id, r]),
    );
    const expiresAt = this.urls.viewExpiry();
    const strong: FaceSearchResponse['strong'] = [];
    const maybe: FaceSearchResponse['maybe'] = [];
    for (const hit of hits) {
      const row = rows.get(hit.fileId);
      if (row === undefined) continue;
      (hit.bucket === 'strong' ? strong : maybe).push(toShareItem(row, this.urls, expiresAt));
    }

    const source = shareEventSource(share, ctx.viewer);
    await recordActivity(this.db, {
      type: 'scan',
      ...source,
      fileId: null,
      bytes: 0,
      meta: { selfies: selfieCount, strong: strong.length, maybe: maybe.length },
    });
    if (strong.length + maybe.length > 0) {
      await recordActivity(this.db, {
        type: 'view',
        ...source,
        fileId: null,
        bytes: 0,
        meta: { items: strong.length + maybe.length },
      });
    }
    return { strong, maybe, selfies: selfieCount, selfiesWithoutFace: result.selfiesWithoutFace };
  }

  // --- POST /s/:token/feedback ---------------------------------------------------------------------

  /**
   * "ไม่ใช่ฉัน": takes the file out of the viewer's face-search result (atomically) and records the
   * stored similarity in face_feedback, without any viewer identity. A file that isn't in the
   * result is a no-op.
   */
  async feedback(token: string, ctx: PublicContext, fileId: string): Promise<void> {
    const share = await this.access.open(token, ctx);
    if (!this.config.features.faceSearch) throw faceSearchDisabled();
    await enforceRate(
      this.limiter,
      `share-feedback:${share.id}:${viewerKey(ctx.viewer)}`,
      this.config.share.rateLimits.feedbackPerViewer,
    );
    const stored = await this.store.hashTake(faceScanResultKey(share.id, ctx.viewer), fileId);
    if (stored === null) return;
    const similarity = Number(stored);
    if (!(similarity >= 0 && similarity <= 100)) return;
    try {
      await this.db.insert(faceFeedback).values({ shareId: share.id, fileId, similarity });
    } catch (error) {
      // The file was purged meanwhile: nothing to record.
      if (pgErrorInfo(error)?.code !== SQLSTATE.FOREIGN_KEY_VIOLATION) throw error;
    }
  }

  // --- POST /s/:token/face-deletion ----------------------------------------------------------------

  /**
   * "ขอลบใบหน้าของฉัน" (ADR 0007): gated on the token and a current `face_deletion` consent only
   * (consentGates('face_deletion')), so it works on revoked, expired and unavailable shares,
   * behind login and password, and with FACE_SEARCH_ENABLED=false. The face-search request limits
   * apply. Direct matches of the selfies at or above FACE_DELETION_THRESHOLD (no expansion)
   * anywhere in the share owner's collection are hidden from search at once (faces.deletion_id,
   * in one transaction with the face_deletions row) and deleted by the worker (`delete.faces`).
   * If the job can't be sent, the marking is undone and the request fails, so a retry starts
   * clean. An owner without searchable faces (no collection, or nothing left) answers 0 without
   * any Rekognition call. Afterwards the share's deletions within FACE_DELETION_ALERT_WINDOW_SECONDS
   * are counted, and FACE_DELETION_ALERT_EVENT is logged when faceDeletionAlertDue.
   */
  async faceDeletion(
    token: string,
    ctx: PublicContext,
    req: Request,
  ): Promise<FaceDeletionResponse> {
    const share = await this.access.byToken(token);
    await this.requireConsent(share, ctx, 'face_deletion');
    await this.rateLimit(share, ctx, req, TURNSTILE_ACTIONS.faceDeletion);

    const selfies = await this.readSelfies(req);
    const [anyFace] = await this.db
      .select({ id: faces.id })
      .from(faces)
      .where(and(eq(faces.ownerId, share.ownerId), searchableFaceSql()))
      .limit(1);
    if (anyFace === undefined) {
      for (const selfie of selfies) selfie.fill(0);
      return { facesMatched: 0 };
    }

    const threshold = this.config.face.deletion.threshold;
    const result = await this.search(selfies, {
      ...selfieSearchOptions(this.config.face, faceCollectionId(share.ownerId)),
      thresholds: { strong: threshold, maybe: threshold },
      expansionSeeds: 0,
    });
    const faceIds = [
      ...new Set(result.matches.filter((m) => m.via === 'selfie').map((m) => m.faceId)),
    ];
    if (faceIds.length === 0) return { facesMatched: 0 };

    const now = this.clock.now();
    const marked = await this.db.transaction(async (tx) => {
      const rowIds: string[] = [];
      for (const ids of chunks(faceIds, FACE_ID_CHUNK)) {
        const found = await tx
          .select({ id: faces.id })
          .from(faces)
          .where(
            and(
              inArray(faces.rekognitionFaceId, ids),
              eq(faces.ownerId, share.ownerId),
              searchableFaceSql(),
            ),
          )
          .for('update');
        rowIds.push(...found.map((f) => f.id));
      }
      if (rowIds.length === 0) return null;
      const [deletion] = await tx
        .insert(faceDeletions)
        .values({
          photographerId: share.ownerId,
          shareId: share.id,
          facesMatched: rowIds.length,
          createdAt: now,
        })
        .returning({ id: faceDeletions.id });
      if (deletion === undefined) throw new Error('face_deletions insert returned no row');
      for (const ids of chunks(rowIds, FACE_ID_CHUNK)) {
        await tx
          .update(faces)
          .set({ deletionId: deletion.id })
          .where(and(inArray(faces.id, ids), eq(faces.ownerId, share.ownerId)));
      }
      return { deletionId: deletion.id, count: rowIds.length };
    });
    if (marked === null) return { facesMatched: 0 };

    try {
      await this.queue.send('faces', { type: 'delete.faces', deletionId: marked.deletionId });
    } catch (error) {
      await this.db.transaction(async (tx) => {
        await tx
          .update(faces)
          .set({ deletionId: null })
          .where(and(eq(faces.deletionId, marked.deletionId), eq(faces.ownerId, share.ownerId)));
        await tx.delete(faceDeletions).where(eq(faceDeletions.id, marked.deletionId));
      });
      throw error;
    }
    await this.alertOnDeletions(share, now);
    return { facesMatched: marked.count };
  }

  /**
   * ADR 0007's per-share alert: counts the share's face_deletions within the alert window
   * (including the one just recorded) and writes one structured event, a JSON line with a
   * top-level `event: "face_deletion.alert"` and ids and the count only (no biometrics, no
   * viewer), which infra's metric filter alarms on.
   * A failure here never fails the deletion itself.
   */
  private async alertOnDeletions(share: LoadedShare, now: Date): Promise<void> {
    const alert = this.config.face.deletion.alert;
    try {
      const since = new Date(now.getTime() - alert.windowSeconds * 1000);
      const [row] = await this.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(faceDeletions)
        .where(
          and(
            eq(faceDeletions.shareId, share.id),
            eq(faceDeletions.photographerId, share.ownerId),
            gt(faceDeletions.createdAt, since),
          ),
        );
      const count = row?.n ?? 0;
      if (faceDeletionAlertDue(count, alert)) {
        this.events.warn(FACE_DELETION_ALERT_EVENT, {
          shareId: share.id,
          ownerId: share.ownerId,
          count,
          threshold: alert.perShare,
          windowSeconds: alert.windowSeconds,
        });
      }
    } catch {
      this.logger.warn('face deletion alert count failed', 'FaceService');
    }
  }
}
