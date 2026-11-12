import { Inject, Injectable } from '@nestjs/common';
import { designAssets, shareDesigns } from '@shotx/db';
import {
  type DesignAssetMap,
  type DesignAssetView,
  designAssetKey,
  type DesignDoc,
  designDocAssetIds,
  designDocSchema,
  type ShareMetaDesign,
} from '@shotx/shared';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db, Queryable } from '../db/db';
import type { EventLog } from '../infra/events';
import { SignedUrls } from '../media/signed-urls';
import { DATABASE, EVENT_LOG } from '../tokens';

/** A `design_assets` row. */
export type DesignAsset = typeof designAssets.$inferSelect;
/** A `share_designs` row. */
export type ShareDesignRow = typeof shareDesigns.$inferSelect;

/** The CDN key of a design image's `web.webp`, the only object of it ever served. */
export function designAssetWebKey(asset: { ownerId: string; id: string }): string {
  return designAssetKey({ photographerId: asset.ownerId, assetId: asset.id }, 'web');
}

/** True when the asset can be shown: `ready`, with web.webp's size. */
function servable(
  asset: Pick<DesignAsset, 'status' | 'width' | 'height'>,
): asset is Pick<DesignAsset, 'status'> & { width: number; height: number } {
  return asset.status === 'ready' && asset.width !== null && asset.height !== null;
}

/**
 * Design documents and design images as the API hands them out (ADR 0013): asset views with
 * signed CDN URLs of `web.webp` (view TTL, through SignedUrls; never a storage URL), asset maps
 * of documents, and the design of a public share page. Every read is filtered by the owner.
 */
@Injectable()
export class DesignViews {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(SignedUrls) private readonly urls: SignedUrls,
    @Inject(EVENT_LOG) private readonly events: EventLog,
  ) {}

  /** View URL expiry for one response (pass it to every assetView of that response). */
  viewExpiry(): Date {
    return this.urls.viewExpiry();
  }

  /** The owner's view of one design image: a signed URL only once it is `ready`. */
  assetView(asset: DesignAsset, expiresAt: Date): DesignAssetView {
    const ready = servable(asset);
    return {
      id: asset.id,
      status: asset.status,
      mime: asset.mime,
      sizeBytes: asset.sizeBytes,
      width: ready ? asset.width : null,
      height: ready ? asset.height : null,
      url: ready ? this.urls.view(designAssetWebKey(asset), expiresAt) : null,
      urlExpiresAt: ready ? expiresAt.toISOString() : null,
      createdAt: asset.createdAt.toISOString(),
    };
  }

  /** The asset map of `rows` (the owner's live rows of some documents' ids), by id. */
  assetMapOf(rows: readonly DesignAsset[], expiresAt = this.viewExpiry()): DesignAssetMap {
    return Object.fromEntries(rows.map((row) => [row.id, this.assetView(row, expiresAt)]));
  }

  /**
   * The owner's live (not purge-requested) design images among `ids`, any status. Ids that are
   * unknown, another owner's or purge-requested are simply missing.
   */
  async liveAssets(q: Queryable, ownerId: string, ids: readonly string[]): Promise<DesignAsset[]> {
    if (ids.length === 0) return [];
    return q
      .select()
      .from(designAssets)
      .where(
        and(
          eq(designAssets.ownerId, ownerId),
          inArray(designAssets.id, [...ids]),
          isNull(designAssets.purgeRequestedAt),
        ),
      );
  }

  /** The asset map of the images `docs` reference (each id once). */
  async assetMap(
    q: Queryable,
    ownerId: string,
    docs: readonly DesignDoc[],
  ): Promise<DesignAssetMap> {
    const ids = [...new Set(docs.flatMap((doc) => designDocAssetIds(doc)))];
    return this.assetMapOf(await this.liveAssets(q, ownerId, ids));
  }

  /**
   * The design of a public share page: the share's own design, else null (the plain layout).
   * The owner's default design is only preselected when a share is created (studio share form);
   * marking a default later never changes existing shares (ADR 0013 amendment, 2026-11-12).
   * Only `ready` images of the owner are included, with view-TTL URLs of web.webp. A stored
   * document that no longer parses (a schema change without a migration) is treated as no design
   * and logged, so the share page keeps working with the plain layout. Writes no activity event
   * (like the cover).
   */
  async shareDesign(share: {
    id: string;
    ownerId: string;
    designId: string | null;
  }): Promise<ShareMetaDesign | null> {
    if (share.designId === null) return null;
    const [row] = await this.db
      .select({ id: shareDesigns.id, doc: shareDesigns.doc })
      .from(shareDesigns)
      .where(and(eq(shareDesigns.id, share.designId), eq(shareDesigns.ownerId, share.ownerId)))
      .limit(1);
    if (row === undefined) return null;
    const parsed = designDocSchema.safeParse(row.doc);
    if (!parsed.success) {
      this.events.warn('design.invalid_document', { designId: row.id, shareId: share.id });
      return null;
    }
    const doc = parsed.data;
    const ids = designDocAssetIds(doc);
    const ready =
      ids.length === 0
        ? []
        : await this.db
            .select()
            .from(designAssets)
            .where(
              and(
                eq(designAssets.ownerId, share.ownerId),
                inArray(designAssets.id, ids),
                eq(designAssets.status, 'ready'),
                isNull(designAssets.purgeRequestedAt),
                isNotNull(designAssets.width),
                isNotNull(designAssets.height),
              ),
            );
    const expiresAt = this.viewExpiry();
    const assets: ShareMetaDesign['assets'] = {};
    for (const asset of ready) {
      if (!servable(asset)) continue;
      assets[asset.id] = {
        url: this.urls.view(designAssetWebKey(asset), expiresAt),
        width: asset.width,
        height: asset.height,
      };
    }
    return { doc, assets };
  }
}
