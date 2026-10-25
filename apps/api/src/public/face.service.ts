import { Inject, Injectable } from '@nestjs/common';
import {
  type FaceProvider,
  faceCollectionId,
  NoFaceDetectedError,
  type SelfieSearchResult,
  bucketByFile,
  searchBySelfies,
  selfieSearchOptions,
} from '@shotx/face';
import { faceDeletions, faceFeedback, faces, files, searchableFaceSql } from '@shotx/db';
import {
  type FaceDeletionResponse,
  type FaceSearchResponse,
  faceScanResultKey,
  mergeFaceScanResult,
  viewerKey,
} from '@shotx/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Request } from 'express';
import { recordActivity, shareEventSource } from '../activity/activity';
import type { PublicContext } from '../auth/public.guard';
import type { ApiConfig } from '../config';
import { type Db, pgErrorInfo, SQLSTATE } from '../db/db';
import { ApiError } from '../http/api-error';
import { readSelfies } from '../http/multipart';
import { SignedUrls } from '../media/signed-urls';
import { type LoadedShare, ShareAccess } from '../share/share-access';
import {
  API_CONFIG,
  DATABASE,
  FACE_PROVIDER,
  KEY_VALUE_STORE,
  type KeyValueStore,
  QUEUE_SENDER,
  type QueueSender,
  RATE_LIMITER,
  type RateLimiter,
} from '../tokens';
import { scopedItemRows, shareItemsScope, toShareItem } from './share-items';
import { enforceRate, faceSearchDisabled, SharePageService } from './share-page.service';

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
  ) {}

  /** CONSENT_REQUIRED unless the viewer consented to the current version for this share. */
  private async requireConsent(share: LoadedShare, ctx: PublicContext): Promise<void> {
    if (!(await this.page.hasConsent(share, ctx.viewer))) {
      throw new ApiError('CONSENT_REQUIRED', 'Consent is required before a face scan', {
        policyVersion: this.config.consent.policyVersion,
      });
    }
  }

  /** FACE_SEARCH_RATE_* per IP, share and viewer; face search and face deletion share them. */
  private async rateLimit(share: LoadedShare, ctx: PublicContext): Promise<void> {
    const rules = this.config.face.searchRateLimits;
    await enforceRate(this.limiter, `face-search:ip:${ctx.ipHash}`, rules.perIp);
    await enforceRate(this.limiter, `face-search:share:${share.id}`, rules.perShare);
    await enforceRate(this.limiter, `face-search:viewer:${viewerKey(ctx.viewer)}`, rules.perViewer);
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
    await this.requireConsent(share, ctx);
    await this.rateLimit(share, ctx);

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

    // Merge into the viewer's result (the face_only grant) and reset its TTL, in one MULTI.
    const key = faceScanResultKey(share.id, ctx.viewer);
    const existing = await this.store.hashGetAll(key);
    await this.store.hashSetWithTtl(
      key,
      mergeFaceScanResult(
        existing,
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
   * "ขอลบใบหน้าของฉัน": direct matches of the selfies at or above FACE_DELETION_THRESHOLD (no
   * expansion) anywhere in the share owner's collection are hidden from search at once
   * (faces.deletion_id, in one transaction with the face_deletions row) and deleted by the worker
   * (`delete.faces`). If the job can't be sent, the marking is undone and the request fails, so a
   * retry starts clean.
   */
  async faceDeletion(
    token: string,
    ctx: PublicContext,
    req: Request,
  ): Promise<FaceDeletionResponse> {
    const share = await this.access.open(token, ctx);
    if (!this.config.features.faceSearch) throw faceSearchDisabled();
    await this.requireConsent(share, ctx);
    await this.rateLimit(share, ctx);

    const selfies = await this.readSelfies(req);
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
        .values({ photographerId: share.ownerId, shareId: share.id, facesMatched: rowIds.length })
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
    return { facesMatched: marked.count };
  }
}
