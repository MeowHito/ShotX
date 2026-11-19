import { Inject, Injectable } from '@nestjs/common';
import { files, folders, printOrders, printSettings, shares } from '@shotx/db';
import {
  type CreatePrintOrderResponse,
  faceOnlyGrantAllows,
  type ListPrintOrdersResponse,
  type OwnerPrintOrder,
  PRINT_ORDER_LIST_LIMIT,
  PRINT_ORDER_STATUSES,
  PRINT_SETTINGS_DEFAULTS,
  type PrintOrderStatus,
  type PrintPaperSize,
  type PrintSettings,
  type SharePrintsResponse,
  sortPaperSizes,
  type ViewerPrintOrder,
} from '@shotx/shared';
import { and, count, desc, eq, ne, type SQL, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { PublicContext } from '../auth/public.guard';
import type { ApiConfig } from '../config';
import type { Db, Queryable, Tx } from '../db/db';
import { mediaKindOf } from '../drive/media-urls';
import { ApiError, notFound } from '../http/api-error';
import { sha256Hex } from '../http/client';
import { SignedUrls } from '../media/signed-urls';
import { enforceRate } from '../public/share-page.service';
import { shareItemsScope } from '../public/share-items';
import { type LoadedShare, ShareAccess } from '../share/share-access';
import { API_CONFIG, CLOCK, type Clock, DATABASE, RATE_LIMITER, type RateLimiter } from '../tokens';

type OrderRow = typeof printOrders.$inferSelect;

const orderNotFound = () => notFound('Print order');
const conflict = (message: string) => new ApiError('CONFLICT', message);

/** Four characters that tell devices apart without revealing the anon id. */
export function deviceLabel(anonId: string): string {
  return sha256Hex(`print-device:${anonId}`).slice(0, 4).toUpperCase();
}

/**
 * The transaction lock of one photographer's print orders: numbering and the per-device limit
 * check serialise on it, so two orders can't take the same number or both pass the limit.
 */
async function lockPhotographerPrints(tx: Tx, photographerId: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`print:${photographerId}`}, 0))`,
  );
}

function viewerOrder(row: OrderRow): ViewerPrintOrder {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    fileId: row.fileId,
    paperSize: row.paperSize as PrintPaperSize,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Orders of one device on one share that count against its limit. */
function countedOrders(shareId: string, anonId: string): SQL {
  return and(
    eq(printOrders.shareId, shareId),
    eq(printOrders.anonId, anonId),
    ne(printOrders.status, 'rejected'),
  ) as SQL;
}

/**
 * Print orders (ADR 0031), PRINT_ROUTES. Viewers of a share ask for one photo at a time on a
 * paper size the photographer offers; the photographer allows (approval `manual`) or the order is
 * queued at once (`auto`), and the studio's print station prints queued orders on the
 * photographer's printer. The device is the anon_id cookie: a signed-in viewer's browser has one
 * too, so the limit is per browser either way. Every studio query filters by the photographer the
 * guard resolved: another photographer's order is NOT_FOUND.
 */
@Injectable()
export class PrintService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(ShareAccess) private readonly access: ShareAccess,
    @Inject(SignedUrls) private readonly urls: SignedUrls,
  ) {}

  // --- settings --------------------------------------------------------------------------------------

  async settings(photographerId: string, q: Queryable = this.db): Promise<PrintSettings> {
    const [row] = await q
      .select()
      .from(printSettings)
      .where(eq(printSettings.photographerId, photographerId));
    if (row === undefined) return { ...PRINT_SETTINGS_DEFAULTS };
    return {
      enabled: row.enabled,
      approval: row.approval,
      perDeviceLimit: row.perDeviceLimit,
      paperSizes: sortPaperSizes(row.paperSizes as PrintPaperSize[]),
    };
  }

  async updateSettings(photographerId: string, body: PrintSettings): Promise<PrintSettings> {
    const values = {
      enabled: body.enabled,
      approval: body.approval,
      perDeviceLimit: body.perDeviceLimit,
      paperSizes: sortPaperSizes(body.paperSizes),
      updatedAt: this.clock.now(),
    };
    await this.db
      .insert(printSettings)
      .values({ photographerId, ...values })
      .onConflictDoUpdate({ target: printSettings.photographerId, set: values });
    return this.settings(photographerId);
  }

  // --- public: GET and POST /s/:token/prints --------------------------------------------------------

  async shareStatus(token: string, ctx: PublicContext): Promise<SharePrintsResponse> {
    const share = await this.access.open(token, ctx);
    const settings = await this.settings(share.ownerId);
    const orders = await this.db
      .select()
      .from(printOrders)
      .where(and(eq(printOrders.shareId, share.id), eq(printOrders.anonId, ctx.anonId)))
      .orderBy(desc(printOrders.createdAt), desc(printOrders.id))
      .limit(PRINT_ORDER_LIST_LIMIT);
    return {
      offer: settings.enabled
        ? {
            paperSizes: settings.paperSizes,
            perDeviceLimit: settings.perDeviceLimit,
            approval: settings.approval,
          }
        : null,
      used: orders.filter((o) => o.status !== 'rejected').length,
      orders: orders.map(viewerOrder),
    };
  }

  async createOrder(
    token: string,
    ctx: PublicContext,
    body: { fileId: string; paperSize: PrintPaperSize; customerName: string | null },
  ): Promise<CreatePrintOrderResponse> {
    const share = await this.access.open(token, ctx);
    const settings = await this.settings(share.ownerId);
    if (!settings.enabled) {
      throw new ApiError('PRINT_UNAVAILABLE', 'This photographer does not take print orders');
    }
    if (!settings.paperSizes.includes(body.paperSize)) {
      throw new ApiError('PRINT_SIZE_UNAVAILABLE', 'This paper size is not offered');
    }
    await this.assertPrintable(share, ctx, body.fileId);
    await enforceRate(
      this.limiter,
      `print-order:${share.id}:${ctx.anonId}`,
      this.config.share.rateLimits.printOrderPerViewer,
    );

    const viewerId = ctx.viewer.kind === 'user' ? ctx.viewer.viewerId : null;
    const { order, used, limit } = await this.db.transaction(async (tx) => {
      await lockPhotographerPrints(tx, share.ownerId);
      // Read again under the lock: a settings change between the check above and now wins.
      const current = await this.settings(share.ownerId, tx);
      if (!current.enabled) {
        throw new ApiError('PRINT_UNAVAILABLE', 'This photographer does not take print orders');
      }
      const [counted] = await tx
        .select({ n: count() })
        .from(printOrders)
        .where(countedOrders(share.id, ctx.anonId));
      const usedBefore = counted?.n ?? 0;
      if (usedBefore >= current.perDeviceLimit) {
        throw new ApiError('PRINT_LIMIT_REACHED', 'This device has used all its prints', {
          limit: current.perDeviceLimit,
          used: usedBefore,
        });
      }
      const [last] = await tx
        .select({ n: sql<number>`coalesce(max(${printOrders.orderNumber}), 0)::int` })
        .from(printOrders)
        .where(eq(printOrders.photographerId, share.ownerId));
      const [created] = await tx
        .insert(printOrders)
        .values({
          photographerId: share.ownerId,
          orderNumber: (last?.n ?? 0) + 1,
          shareId: share.id,
          fileId: body.fileId,
          anonId: ctx.anonId,
          viewerId,
          paperSize: body.paperSize,
          customerName: body.customerName,
          status: current.approval === 'auto' ? 'queued' : 'pending',
        })
        .returning();
      if (created === undefined) throw new Error('print_orders insert returned no row');
      return { order: created, used: usedBefore + 1, limit: current.perDeviceLimit };
    });
    return { order: viewerOrder(order), used, perDeviceLimit: limit };
  }

  /** NOT_FOUND unless a ready image of the share's scope (and the face_only grant). */
  private async assertPrintable(share: LoadedShare, ctx: PublicContext, fileId: string) {
    const grant = await this.access.grant(share, ctx.viewer);
    const [file] = await this.db
      .select({ id: files.id, mime: files.mime })
      .from(files)
      .where(and(shareItemsScope(share), eq(files.id, fileId)));
    if (file === undefined || !faceOnlyGrantAllows(share.mode, grant, fileId)) {
      throw notFound('File');
    }
    if (mediaKindOf(file.mime) !== 'image') {
      throw new ApiError('PRINT_UNAVAILABLE', 'Only photos can be printed');
    }
  }

  // --- studio: orders ---------------------------------------------------------------------------------

  async listOrders(
    photographerId: string,
    status: PrintOrderStatus | undefined,
  ): Promise<ListPrintOrdersResponse> {
    const where = and(
      eq(printOrders.photographerId, photographerId),
      status === undefined ? undefined : eq(printOrders.status, status),
    ) as SQL;
    const items = await this.ownerOrders(where, PRINT_ORDER_LIST_LIMIT);
    const byStatus = await this.db
      .select({ status: printOrders.status, n: count() })
      .from(printOrders)
      .where(eq(printOrders.photographerId, photographerId))
      .groupBy(printOrders.status);
    const counts = Object.fromEntries(PRINT_ORDER_STATUSES.map((s) => [s, 0])) as Record<
      PrintOrderStatus,
      number
    >;
    for (const row of byStatus) counts[row.status] = row.n;
    return { items, counts };
  }

  async approve(photographerId: string, id: string): Promise<OwnerPrintOrder> {
    return this.transition(photographerId, id, ['pending'], (row) => ({
      status: 'queued',
      decidedAt: this.clock.now(),
      printCount: row.printCount,
    }));
  }

  async reject(photographerId: string, id: string): Promise<OwnerPrintOrder> {
    return this.transition(photographerId, id, ['pending', 'queued'], (row) => ({
      status: 'rejected',
      decidedAt: this.clock.now(),
      printCount: row.printCount,
    }));
  }

  /**
   * Takes an order for printing. A station (`onlyQueued`) takes queued orders only; the
   * photographer's own button also allows a pending one and reprints a printed one. The file must
   * still be live (else CONFLICT: there is nothing to print; reject it instead).
   */
  async print(photographerId: string, id: string, onlyQueued: boolean): Promise<OwnerPrintOrder> {
    const allowed: PrintOrderStatus[] = onlyQueued ? ['queued'] : ['pending', 'queued', 'printed'];
    const [file] = await this.db
      .select({
        live: sql<boolean>`(${files.deletedAt} IS NULL AND ${files.purgeRequestedAt} IS NULL)`,
      })
      .from(printOrders)
      .innerJoin(files, eq(files.id, printOrders.fileId))
      .where(and(eq(printOrders.id, id), eq(printOrders.photographerId, photographerId)));
    if (file === undefined) throw orderNotFound();
    if (!file.live) throw conflict('The photo of this order is gone');
    const now = this.clock.now();
    return this.transition(photographerId, id, allowed, (row) => ({
      status: 'printed',
      // Allowed by printing it: decided now, unless it was decided before.
      decidedAt: row.status === 'pending' ? now : row.decidedAt,
      printedAt: now,
      printCount: row.printCount + 1,
    }));
  }

  /** One guarded status change: the row must be the photographer's and in `from`. */
  private async transition(
    photographerId: string,
    id: string,
    from: PrintOrderStatus[],
    next: (row: OrderRow) => Partial<OrderRow>,
  ): Promise<OwnerPrintOrder> {
    const updated = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(printOrders)
        .where(and(eq(printOrders.id, id), eq(printOrders.photographerId, photographerId)))
        .for('update');
      if (row === undefined) throw orderNotFound();
      if (!from.includes(row.status)) {
        throw conflict(`The order is ${row.status}`);
      }
      await tx.update(printOrders).set(next(row)).where(eq(printOrders.id, id));
      return row.id;
    });
    const [order] = await this.ownerOrders(eq(printOrders.id, updated), 1);
    if (order === undefined) throw orderNotFound();
    return order;
  }

  /** Orders with their file, event name and signed URLs, newest first. */
  private async ownerOrders(where: SQL, limit: number): Promise<OwnerPrintOrder[]> {
    const targetFile = alias(files, 'print_target_file');
    const rows = await this.db
      .select({
        order: printOrders,
        fileName: files.name,
        mime: files.mime,
        width: files.width,
        height: files.height,
        s3Key: files.s3Key,
        webKey: files.webKey,
        thumbKey: files.thumbKey,
        fileLive: sql<boolean>`(${files.deletedAt} IS NULL AND ${files.purgeRequestedAt} IS NULL)`,
        folderName: folders.name,
        targetFileName: targetFile.name,
      })
      .from(printOrders)
      .innerJoin(files, eq(files.id, printOrders.fileId))
      .innerJoin(shares, eq(shares.id, printOrders.shareId))
      .leftJoin(folders, eq(folders.id, shares.targetFolderId))
      .leftJoin(targetFile, eq(targetFile.id, shares.targetFileId))
      .where(where)
      .orderBy(desc(printOrders.createdAt), desc(printOrders.id))
      .limit(limit);
    const expiresAt = this.urls.viewExpiry();
    return rows.map((r) => {
      const o = r.order;
      const live = r.fileLive;
      // Browsers print JPEG, PNG and WebP originals (every image type uploads accept).
      const printKey = mediaKindOf(r.mime) === 'image' ? r.s3Key : r.webKey;
      return {
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        paperSize: o.paperSize as PrintPaperSize,
        customerName: o.customerName,
        deviceLabel: deviceLabel(o.anonId),
        shareId: o.shareId,
        eventName: r.folderName ?? r.targetFileName ?? '',
        fileId: o.fileId,
        fileName: r.fileName,
        width: r.width,
        height: r.height,
        thumbUrl: live && r.thumbKey !== null ? this.urls.view(r.thumbKey, expiresAt) : null,
        printUrl: live && printKey !== null ? this.urls.view(printKey, expiresAt) : null,
        printCount: o.printCount,
        createdAt: o.createdAt.toISOString(),
        decidedAt: o.decidedAt?.toISOString() ?? null,
        printedAt: o.printedAt?.toISOString() ?? null,
      };
    });
  }
}
