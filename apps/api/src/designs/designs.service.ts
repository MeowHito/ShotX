import { Inject, Injectable } from '@nestjs/common';
import { designAssets, shareDesigns } from '@shotx/db';
import {
  blankDesignDoc,
  checkDesignDocLimits,
  type createDesignAssetBodySchema,
  type CreateDesignAssetResponse,
  type createDesignBodySchema,
  decodeOpaqueCursor,
  type Design,
  designAssetFileType,
  designAssetKey,
  designAssetListCursorSchema,
  type DesignAssetMessage,
  type DesignAssetView,
  type DesignDoc,
  designDocAssetIds,
  type DesignSummary,
  designTemplateDoc,
  encodeOpaqueCursor,
  fileExtension,
  type ListDesignAssetsResponse,
  type ListDesignsResponse,
  rejectedFileTypeHint,
  reserveQuota,
  subscriptionAllowsUploads,
  type updateDesignBodySchema,
} from '@shotx/shared';
import { and, count, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { type ApiConfig, apiSendsMediaJobs } from '../config';
import type { Db, Tx } from '../db/db';
import {
  currentSubscription,
  reserveQuotaBytes,
  storageCounters,
  uploadGate,
} from '../drive/account';
import { newId } from '../drive/folders';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import type { EventLog } from '../infra/events';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  EVENT_LOG,
  OBJECT_STORAGE,
  type ObjectStorage,
  QUEUE_SENDER,
  type QueueSender,
} from '../tokens';
import { quotaExceeded } from '../upload/upload.service';
import { type DesignAsset, DesignViews, type ShareDesignRow } from './design-views';

type CreateBody = z.output<typeof createDesignBodySchema>;
type UpdateBody = z.output<typeof updateDesignBodySchema>;
type CreateAssetBody = z.output<typeof createDesignAssetBodySchema>;

const designNotFound = () => notFound('Design');
const assetNotFound = () => notFound('Design image');

/**
 * The transaction advisory lock of one owner's designs: creates (the DESIGN_MAX_PER_OWNER count)
 * and default switches serialise on it, so two requests can't both pass the count or both set a
 * default.
 */
async function lockOwnerDesigns(tx: Tx, ownerId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`designs:${ownerId}`}, 0))`);
}

/**
 * Share page designs and design images (ADR 0013), DESIGN_ROUTES. Every query filters by the
 * photographer the guard resolved: another owner's design or image is NOT_FOUND. Documents arrive
 * validated by designDocSchema (the route body), are checked against the configured limits
 * (DESIGN_DOC_TOO_LARGE) and then every asset id they reference must be one of the caller's live
 * images, locked FOR KEY SHARE in the write's transaction so the orphan purge can't take it
 * (DESIGN_ASSET_NOT_FOUND). Image bytes never pass through the API: one presigned PUT straight to
 * the bucket, then the worker's `design.asset` job.
 */
@Injectable()
export class DesignsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
    @Inject(QUEUE_SENDER) private readonly queue: QueueSender,
    @Inject(EVENT_LOG) private readonly events: EventLog,
    @Inject(DesignViews) private readonly views: DesignViews,
  ) {}

  // --- documents -------------------------------------------------------------------------------

  /** DESIGN_DOC_TOO_LARGE when a (schema-valid) document breaks a configured limit. */
  private checkLimits(doc: DesignDoc): void {
    const violation = checkDesignDocLimits(doc, {
      maxElements: this.config.design.maxElements,
      docMaxBytes: this.config.design.docMaxBytes,
    });
    if (violation !== null) {
      throw new ApiError(
        'DESIGN_DOC_TOO_LARGE',
        violation.reason === 'elements'
          ? 'The design has too many elements'
          : 'The design document is too large',
        violation,
      );
    }
  }

  /**
   * The caller's live images `doc` references, locked FOR KEY SHARE until the transaction ends
   * (the orphan purge locks FOR UPDATE and sets purge_requested_at, so it waits for this write
   * and then sees the reference). DESIGN_ASSET_NOT_FOUND with every id that is unknown, another
   * owner's or purge-requested, in document order.
   */
  private async lockReferencedAssets(
    tx: Tx,
    ownerId: string,
    doc: DesignDoc,
  ): Promise<DesignAsset[]> {
    const ids = designDocAssetIds(doc);
    if (ids.length === 0) return [];
    const found = await tx
      .select()
      .from(designAssets)
      .where(
        and(
          eq(designAssets.ownerId, ownerId),
          inArray(designAssets.id, ids),
          isNull(designAssets.purgeRequestedAt),
        ),
      )
      .orderBy(designAssets.id)
      .for('key share');
    const have = new Set(found.map((a) => a.id));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length > 0) {
      throw new ApiError(
        'DESIGN_ASSET_NOT_FOUND',
        'The design uses images that are not yours or no longer exist',
        { assetIds: missing },
      );
    }
    return found;
  }

  private summary(row: ShareDesignRow): DesignSummary {
    return {
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      revision: row.revision,
      doc: row.doc,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toDesign(row: ShareDesignRow, assets: readonly DesignAsset[]): Design {
    return { ...this.summary(row), assets: this.views.assetMapOf(assets) };
  }

  // --- GET /designs ----------------------------------------------------------------------------

  async list(ownerId: string): Promise<ListDesignsResponse> {
    const rows = await this.db
      .select()
      .from(shareDesigns)
      .where(eq(shareDesigns.ownerId, ownerId))
      .orderBy(desc(shareDesigns.updatedAt), desc(shareDesigns.id));
    return {
      items: rows.map((row) => this.summary(row)),
      assets: await this.views.assetMap(
        this.db,
        ownerId,
        rows.map((row) => row.doc),
      ),
      limits: {
        maxDesigns: this.config.design.maxPerOwner,
        maxElements: this.config.design.maxElements,
        docMaxBytes: this.config.design.docMaxBytes,
        assetMaxBytes: this.config.design.asset.maxBytes,
      },
    };
  }

  // --- POST /designs ---------------------------------------------------------------------------

  /**
   * From a template (with placeholder text in `locale`), a document, or blank. Never the
   * default; revision 1. The owner's designs are counted under the per-owner lock in the insert's
   * transaction (DESIGN_LIMIT_REACHED at DESIGN_MAX_PER_OWNER).
   */
  async create(ownerId: string, body: CreateBody): Promise<Design> {
    const doc =
      body.templateId !== undefined
        ? designTemplateDoc(body.templateId, body.locale)
        : (body.doc ?? blankDesignDoc());
    this.checkLimits(doc);
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      await lockOwnerDesigns(tx, ownerId);
      const [counted] = await tx
        .select({ n: count() })
        .from(shareDesigns)
        .where(eq(shareDesigns.ownerId, ownerId));
      const max = this.config.design.maxPerOwner;
      if ((counted?.n ?? 0) >= max) {
        throw new ApiError('DESIGN_LIMIT_REACHED', 'You have the most designs allowed', {
          maxDesigns: max,
        });
      }
      const assets = await this.lockReferencedAssets(tx, ownerId, doc);
      const [row] = await tx
        .insert(shareDesigns)
        .values({ ownerId, name: body.name, doc, createdAt: now, updatedAt: now })
        .returning();
      if (row === undefined) throw new Error('Design insert returned no row');
      return this.toDesign(row, assets);
    });
  }

  // --- GET /designs/:id ------------------------------------------------------------------------

  async get(ownerId: string, id: string): Promise<Design> {
    const [row] = await this.db
      .select()
      .from(shareDesigns)
      .where(and(eq(shareDesigns.id, id), eq(shareDesigns.ownerId, ownerId)));
    if (row === undefined) throw designNotFound();
    return this.toDesign(
      row,
      await this.views.liveAssets(this.db, ownerId, designDocAssetIds(row.doc)),
    );
  }

  // --- PUT /designs/:id ------------------------------------------------------------------------

  /**
   * Saves name and document when `revision` is the stored one: the row is locked FOR UPDATE,
   * checked (NOT_FOUND, DESIGN_REVISION_CONFLICT with the current revision), the images are
   * checked and locked, then `UPDATE ... WHERE revision = $sent` sets revision + 1. Nothing
   * changes on any error. `isDefault` is not touched.
   */
  async update(ownerId: string, id: string, body: UpdateBody): Promise<Design> {
    this.checkLimits(body.doc);
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ revision: shareDesigns.revision })
        .from(shareDesigns)
        .where(and(eq(shareDesigns.id, id), eq(shareDesigns.ownerId, ownerId)))
        .for('update');
      if (current === undefined) throw designNotFound();
      if (current.revision !== body.revision) throw revisionConflict(current.revision);
      const assets = await this.lockReferencedAssets(tx, ownerId, body.doc);
      const [row] = await tx
        .update(shareDesigns)
        .set({
          name: body.name,
          doc: body.doc,
          revision: sql`${shareDesigns.revision} + 1`,
          updatedAt: now,
        })
        .where(
          and(
            eq(shareDesigns.id, id),
            eq(shareDesigns.ownerId, ownerId),
            eq(shareDesigns.revision, body.revision),
          ),
        )
        .returning();
      // Unreachable under the row lock; kept so the guard is the statement, not the lock.
      if (row === undefined) throw revisionConflict(current.revision);
      return this.toDesign(row, assets);
    });
  }

  // --- DELETE /designs/:id ---------------------------------------------------------------------

  /** Hard delete. Shares using it fall back to the default (shares.design_id ON DELETE SET NULL). */
  async delete(ownerId: string, id: string): Promise<void> {
    const [deleted] = await this.db
      .delete(shareDesigns)
      .where(and(eq(shareDesigns.id, id), eq(shareDesigns.ownerId, ownerId)))
      .returning({ id: shareDesigns.id });
    if (deleted === undefined) throw designNotFound();
  }

  // --- POST /designs/:id/default ---------------------------------------------------------------

  /** Makes it the default: clears the previous one first, then sets it, in one transaction. */
  async setDefault(ownerId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await lockOwnerDesigns(tx, ownerId);
      const [design] = await tx
        .select({ isDefault: shareDesigns.isDefault })
        .from(shareDesigns)
        .where(and(eq(shareDesigns.id, id), eq(shareDesigns.ownerId, ownerId)))
        .for('update');
      if (design === undefined) throw designNotFound();
      if (design.isDefault) return;
      await tx
        .update(shareDesigns)
        .set({ isDefault: false })
        .where(
          and(
            eq(shareDesigns.ownerId, ownerId),
            eq(shareDesigns.isDefault, true),
            ne(shareDesigns.id, id),
          ),
        );
      await tx
        .update(shareDesigns)
        .set({ isDefault: true })
        .where(and(eq(shareDesigns.id, id), eq(shareDesigns.ownerId, ownerId)));
    });
  }

  // --- DELETE /designs/:id/default -------------------------------------------------------------

  /** Stops it being the default; a no-op when it isn't. */
  async clearDefault(ownerId: string, id: string): Promise<void> {
    const [found] = await this.db
      .update(shareDesigns)
      .set({ isDefault: false })
      .where(and(eq(shareDesigns.id, id), eq(shareDesigns.ownerId, ownerId)))
      .returning({ id: shareDesigns.id });
    if (found === undefined) throw designNotFound();
  }

  // --- POST /designs/assets --------------------------------------------------------------------

  /**
   * Starts a design image upload: type and size checks, the reservation in storage_usage (as
   * uploads: guarded, QUOTA_EXCEEDED only with STORAGE_QUOTA_ENFORCED, SUBSCRIPTION_INACTIVE only
   * with BILLING_MODE=gateway), the `uploading` row and one presigned PUT that signs the
   * Content-Type and the exact Content-Length. All in one transaction; the file name is not
   * stored.
   */
  async createAsset(ownerId: string, body: CreateAssetBody): Promise<CreateDesignAssetResponse> {
    const fileType = designAssetFileType(body.fileName, body.mime);
    if (fileType === null) {
      throw new ApiError('UNSUPPORTED_FILE_TYPE', 'Design images must be JPEG, PNG or WebP', {
        extension: fileExtension(body.fileName),
        hint: rejectedFileTypeHint(body.fileName, body.mime),
      });
    }
    const maxBytes = this.config.design.asset.maxBytes;
    if (body.sizeBytes > maxBytes) {
      throw new ApiError('FILE_TOO_LARGE', 'The image is over the size limit', { maxBytes });
    }
    const ttl = this.config.design.asset.uploadTtlSeconds;
    const expiresAt = new Date(this.clock.now().getTime() + ttl * 1000);

    return this.db.transaction(async (tx) => {
      const gate = uploadGate(this.config);
      let quotaBytes: number | null = null;
      if (gate.subscription || gate.quota) {
        // FOR SHARE, as uploads: serialises with plan changes (see currentSubscription).
        const subscription = await currentSubscription(tx, ownerId, { lock: 'share' });
        if (gate.subscription && !subscriptionAllowsUploads(subscription?.status ?? null)) {
          throw new ApiError('SUBSCRIPTION_INACTIVE', 'Uploads need an active subscription', {
            status: subscription?.status ?? null,
          });
        }
        if (gate.quota) quotaBytes = subscription?.quotaBytes ?? 0;
      }
      if (!(await reserveQuotaBytes(tx, ownerId, body.sizeBytes, quotaBytes))) {
        const state = reserveQuota(
          { ...(await storageCounters(tx, ownerId)), quotaBytes: quotaBytes ?? 0 },
          body.sizeBytes,
        );
        throw quotaExceeded(
          state.ok
            ? {
                quotaBytes: quotaBytes ?? 0,
                usedBytes: 0,
                reservedBytes: 0,
                requestedBytes: body.sizeBytes,
                availableBytes: 0,
              }
            : state.details,
        );
      }
      const assetId = await newId(tx);
      await tx.insert(designAssets).values({
        id: assetId,
        ownerId,
        mime: fileType.mime,
        sizeBytes: body.sizeBytes,
        status: 'uploading',
        uploadExpiresAt: expiresAt,
      });
      // Local signing (no network); inside the transaction so a failure reserves nothing.
      const uploadUrl = await this.storage.presignPutObject({
        key: designAssetKey({ photographerId: ownerId, assetId }, 'original'),
        contentType: fileType.mime,
        contentLength: body.sizeBytes,
        expiresInSeconds: ttl,
      });
      return {
        assetId,
        uploadUrl,
        headers: { 'Content-Type': fileType.mime },
        expiresAt: expiresAt.toISOString(),
      };
    });
  }

  // --- POST /designs/assets/:id/complete -------------------------------------------------------

  /**
   * After the PUT: `uploading` -> `processing` with `queued_at` in one guarded UPDATE, then the
   * `design.asset` job. Idempotent: `processing` or `ready` answers the asset and sends nothing.
   * `failed` is CONFLICT, past `upload_expires_at` UPLOAD_EXPIRED, purge-requested NOT_FOUND.
   */
  async completeAsset(ownerId: string, id: string): Promise<DesignAssetView> {
    const asset = await this.liveAsset(ownerId, id);
    if (asset.status === 'processing' || asset.status === 'ready') return this.assetView(asset);
    if (asset.status === 'failed') {
      throw new ApiError('CONFLICT', 'This image upload failed; upload it again');
    }
    if (asset.uploadExpiresAt !== null && this.clock.now() >= asset.uploadExpiresAt) {
      throw new ApiError('UPLOAD_EXPIRED', 'The upload has expired');
    }
    const [updated] = await this.db
      .update(designAssets)
      .set({ status: 'processing', queuedAt: this.clock.now() })
      .where(
        and(
          eq(designAssets.id, id),
          eq(designAssets.ownerId, ownerId),
          eq(designAssets.status, 'uploading'),
          isNull(designAssets.purgeRequestedAt),
        ),
      )
      .returning();
    if (updated === undefined) {
      // A concurrent complete (or the worker, or the purge) got there first: answer as a retry.
      const current = await this.liveAsset(ownerId, id);
      if (current.status === 'failed') {
        throw new ApiError('CONFLICT', 'This image upload failed; upload it again');
      }
      if (current.status === 'uploading') throw new Error('Design asset complete lost a race');
      return this.assetView(current);
    }
    await this.startProcessing(updated);
    return this.assetView(updated);
  }

  /**
   * Sends `design.asset` after the row is `processing`. With QUEUE_BACKEND=sqs the api has no
   * media queue (S3 notifications feed it on AWS), so nothing is sent and the worker's media.sweep
   * picks the row up by `queued_at`. Failures are logged only (ids), never failing the request:
   * media.sweep re-sends.
   */
  private async startProcessing(asset: DesignAsset): Promise<void> {
    if (!apiSendsMediaJobs(this.config)) return;
    const message: DesignAssetMessage = {
      kind: 'design.asset',
      assetId: asset.id,
      photographerId: asset.ownerId,
    };
    try {
      await this.queue.send('media', message);
    } catch (error) {
      this.events.warn('media.enqueue_failed', {
        designAssetId: asset.id,
        photographerId: asset.ownerId,
        queue: 'media',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  // --- GET /designs/assets/:id -----------------------------------------------------------------

  async getAsset(ownerId: string, id: string): Promise<DesignAssetView> {
    return this.assetView(await this.liveAsset(ownerId, id));
  }

  // --- GET /designs/assets ---------------------------------------------------------------------

  /** Newest first (uuidv7 ids), without purge-requested or failed images. */
  async listAssets(
    ownerId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<ListDesignAssetsResponse> {
    const limit = query.limit ?? this.config.design.asset.pageSize;
    let after: string | null = null;
    if (query.cursor !== undefined) {
      const cursor = decodeOpaqueCursor(designAssetListCursorSchema, query.cursor);
      if (cursor === null) throw validationError(['query', 'cursor'], 'is not a valid cursor');
      after = cursor.id;
    }
    const found = await this.db
      .select()
      .from(designAssets)
      .where(
        and(
          eq(designAssets.ownerId, ownerId),
          isNull(designAssets.purgeRequestedAt),
          ne(designAssets.status, 'failed'),
          after === null ? undefined : lt(designAssets.id, after),
        ),
      )
      .orderBy(desc(designAssets.id))
      .limit(limit + 1);
    const shown = found.slice(0, limit);
    const last = shown.at(-1);
    const expiresAt = this.views.viewExpiry();
    return {
      items: shown.map((asset) => this.views.assetView(asset, expiresAt)),
      nextCursor:
        found.length > limit && last !== undefined
          ? encodeOpaqueCursor(designAssetListCursorSchema, { v: 1, id: last.id })
          : null,
    };
  }

  // --- shared ----------------------------------------------------------------------------------

  /** The caller's image, not purge-requested; NOT_FOUND otherwise. */
  private async liveAsset(ownerId: string, id: string): Promise<DesignAsset> {
    const [asset] = await this.db
      .select()
      .from(designAssets)
      .where(
        and(
          eq(designAssets.id, id),
          eq(designAssets.ownerId, ownerId),
          isNull(designAssets.purgeRequestedAt),
        ),
      );
    if (asset === undefined) throw assetNotFound();
    return asset;
  }

  private assetView(asset: DesignAsset): DesignAssetView {
    return this.views.assetView(asset, this.views.viewExpiry());
  }
}

function revisionConflict(currentRevision: number): ApiError {
  return new ApiError(
    'DESIGN_REVISION_CONFLICT',
    'The design was saved elsewhere since you opened it',
    { currentRevision },
  );
}
