import { Inject, Injectable } from '@nestjs/common';
import {
  childFolderDepth,
  designAssets,
  type DriveFile as DriveFileRow,
  driveNameKeySql,
  files,
  type Folder,
  folderSubtreeMoveSql,
  folders,
  planFolderMove,
  storageUsage,
} from '@shotx/db';
import {
  type CreateFolderBody,
  decodeDriveCursor,
  type DriveCursor,
  type DriveFolder,
  type DriveItem,
  type DriveItemRef,
  type DriveSort,
  type DriveUsageResponse,
  driveNameKey,
  type EmptyTrashResponse,
  encodeDriveCursor,
  folderIdFromRef,
  type FolderRef,
  type ListChildrenResponse,
  type ListTrashResponse,
  rejectedFileTypeHint,
  renameKeepsFileType,
  fileExtension,
  type RestoreItemsResponse,
  type SortOrder,
  type TrashItem,
  type TrashItemsResponse,
  type UpdateFileBody,
  type UpdateFolderBody,
  availableBytes,
  type DownloadSize,
  downloadObject,
  isFaceIndexActive,
  packageUploadsBlockedBy,
  type SignedDownload,
  subscriptionAllowsSharing,
  type CoverFileInvalidDetails,
  type CoverFileInvalidReason,
} from '@shotx/shared';
import { and, asc, desc, eq, inArray, isNotNull, isNull, type SQL, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { recordActivity } from '../activity/activity';
import { type ApiConfig, billingOnline } from '../config';
import { type Db, isUniqueViolation, type Queryable, rows, type Tx } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { SignedUrls } from '../media/signed-urls';
import { API_CONFIG, CLOCK, type Clock, DATABASE, QUEUE_SENDER, type QueueSender } from '../tokens';
import { assertPackageActive, photographerPackage } from '../packages/package-state';
import { currentSubscription, storageCounters, uploadGate, uploadsBlockedUnder } from './account';
import { eventsOf } from './events';
import { ancestorsOf, insertFolder, liveFolder, subtreeMaxDepth } from './folders';
import { DriveFileMapper, mediaKindOf, toDriveFolder } from './media-urls';
import { fileFolderIs, folderParentIs, withFreeName } from './names';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const nameTaken = (kind: 'folder' | 'file', name: string) =>
  new ApiError('NAME_TAKEN', `A ${kind} with this name already exists here`, { kind, name });

const depthExceeded = (maxDepth: number) =>
  new ApiError('FOLDER_DEPTH_EXCEEDED', 'The folder tree would be too deep', { maxDepth });

interface ListQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
  sort: DriveSort;
  order: SortOrder;
}

type Row = { kind: 'folder'; row: Folder } | { kind: 'file'; row: DriveFileRow };

/** Keyset condition and order of one table in a children listing (see drive/cursor). */
export function listingOrder(
  cols: { id: AnyPgColumn; name: AnyPgColumn },
  sort: DriveSort,
  order: SortOrder,
  after: DriveCursor | null,
): { where: SQL | undefined; orderBy: SQL[] } {
  const dir = order === 'asc' ? asc : desc;
  const cmp = order === 'asc' ? sql.raw('>') : sql.raw('<');
  if (sort === 'name') {
    const key = driveNameKeySql(cols.name);
    return {
      where:
        after === null
          ? undefined
          : sql`(${key}, ${cols.id}) ${cmp} (${after.key ?? ''}::text COLLATE "C", ${after.id}::uuid)`,
      orderBy: [dir(key), dir(cols.id)],
    };
  }
  return {
    where: after === null ? undefined : sql`${cols.id} ${cmp} ${after.id}::uuid`,
    orderBy: [dir(cols.id)],
  };
}

/**
 * Drive: folders and files of the authenticated photographer. Every query filters by `ownerId`
 * (resolved by PhotographerGuard), so other owners' ids are NOT_FOUND.
 */
@Injectable()
export class DriveService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DriveFileMapper) private readonly mapper: DriveFileMapper,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QUEUE_SENDER) private readonly queue: QueueSender,
    @Inject(SignedUrls) private readonly urls: SignedUrls,
  ) {}

  private item(row: Row): DriveItem {
    return row.kind === 'folder' ? toDriveFolder(row.row) : this.mapper.toDriveFile(row.row);
  }

  // --- GET /drive/folders/:id/children -------------------------------------------------------

  async listChildren(
    ownerId: string,
    ref: FolderRef,
    query: ListQuery,
  ): Promise<ListChildrenResponse> {
    const folderId = folderIdFromRef(ref);
    const cursor = this.listCursor(query);
    const limit = query.limit ?? this.config.drive.pageSize;
    let folder: Folder | null = null;
    let ancestors: { id: string; name: string }[] = [];
    if (folderId !== null) {
      folder = await liveFolder(this.db, ownerId, folderId);
      if (folder === null) throw notFound('Folder');
      ancestors = await ancestorsOf(this.db, ownerId, folder);
    }

    const page: Row[] = [];
    if (cursor === null || cursor.phase === 'folders') {
      const o = listingOrder(folders, query.sort, query.order, cursor);
      const found = await this.db
        .select()
        .from(folders)
        .where(
          and(
            eq(folders.ownerId, ownerId),
            folderParentIs(folderId),
            isNull(folders.deletedAt),
            o.where,
          ),
        )
        .orderBy(...o.orderBy)
        .limit(limit + 1);
      page.push(...found.map((row) => ({ kind: 'folder' as const, row })));
    }
    if (page.length <= limit) {
      const o = listingOrder(
        files,
        query.sort,
        query.order,
        cursor?.phase === 'files' ? cursor : null,
      );
      const found = await this.db
        .select()
        .from(files)
        .where(
          and(eq(files.ownerId, ownerId), fileFolderIs(folderId), isNull(files.deletedAt), o.where),
        )
        .orderBy(...o.orderBy)
        .limit(limit + 1 - page.length);
      page.push(...found.map((row) => ({ kind: 'file' as const, row })));
    }

    const hasMore = page.length > limit;
    const shown = page.slice(0, limit);
    const last = shown.at(-1);
    const nextCursor =
      hasMore && last !== undefined
        ? encodeDriveCursor({
            v: 1,
            sort: query.sort,
            order: query.order,
            phase: last.kind === 'folder' ? 'folders' : 'files',
            key: query.sort === 'name' ? driveNameKey(last.row.name) : null,
            kind: last.kind,
            id: last.row.id,
          })
        : null;
    // ADR 0016: every folder is an event; its cover and link come along in two queries.
    const events = await eventsOf(
      this.db,
      ownerId,
      shown.filter((r) => r.kind === 'folder').map((r) => r.row.id),
      {
        urls: this.urls,
        publicBaseUrl: this.config.app.publicBaseUrl,
        now: this.clock.now(),
        expiresAt: this.urls.viewExpiry(),
      },
    );
    return {
      folder: folder === null ? null : toDriveFolder(folder),
      ancestors,
      items: shown.map((r) => {
        const item = this.item(r);
        const event = item.kind === 'folder' ? events.get(item.id) : undefined;
        return event === undefined ? item : { ...item, event };
      }),
      nextCursor,
    };
  }

  private listCursor(query: ListQuery): DriveCursor | null {
    if (query.cursor === undefined) return null;
    const cursor = decodeDriveCursor(query.cursor);
    if (cursor === null) throw validationError(['query', 'cursor'], 'is not a valid cursor');
    if (
      cursor.phase === 'trash' ||
      cursor.sort !== query.sort ||
      cursor.order !== query.order ||
      (cursor.sort === 'name' && cursor.key === null)
    ) {
      throw validationError(['query', 'cursor'], 'does not belong to this listing, sort and order');
    }
    return cursor;
  }

  // --- POST /drive/folders -------------------------------------------------------------------

  async createFolder(ownerId: string, body: CreateFolderBody): Promise<DriveFolder> {
    return this.db.transaction(async (tx) => {
      const parent =
        body.parentId === null ? null : await liveFolder(tx, ownerId, body.parentId, 'share');
      if (body.parentId !== null && parent === null) throw notFound('Parent folder');
      const max = this.config.drive.maxFolderDepth;
      if (childFolderDepth(parent?.path ?? null) > max) throw depthExceeded(max);
      try {
        return toDriveFolder(
          await insertFolder(tx, {
            ownerId,
            parent,
            name: body.name,
            now: this.clock.now(),
            faceIndexExpiryDays: this.config.retention.faceIndexExpiryDays,
          }),
        );
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken('folder', body.name);
        throw error;
      }
    });
  }

  // --- PATCH /drive/folders/:id --------------------------------------------------------------

  async updateFolder(ownerId: string, id: string, body: UpdateFolderBody): Promise<DriveFolder> {
    return this.db.transaction(async (tx) => {
      const folder = await liveFolder(tx, ownerId, id, 'update');
      if (folder === null) throw notFound('Folder');
      const name = body.name ?? folder.name;
      const rename = body.name !== undefined && body.name !== folder.name;
      try {
        if (body.parentId !== undefined) {
          const newParent =
            body.parentId === null ? null : await liveFolder(tx, ownerId, body.parentId, 'update');
          if (body.parentId !== null && newParent === null) throw notFound('Target folder');
          const result = planFolderMove({
            folder,
            newParent,
            subtreeMaxDepth: await subtreeMaxDepth(tx, ownerId, folder.path),
            maxDepth: this.config.drive.maxFolderDepth,
          });
          if (!result.ok) {
            if (result.code === 'INVALID_MOVE') {
              throw new ApiError(
                'INVALID_MOVE',
                'A folder cannot move into itself or its descendants',
              );
            }
            throw depthExceeded(result.maxDepth);
          }
          const { plan } = result;
          if (!plan.noop) {
            if (rename) {
              // Name, parent and path of the folder in one statement (so a name that is only
              // free at the destination is accepted), then the descendants' prefix.
              await tx
                .update(folders)
                .set({ name, parentId: plan.newParentId, path: plan.newPath })
                .where(and(eq(folders.id, folder.id), eq(folders.ownerId, ownerId)));
            }
            await tx.execute(folderSubtreeMoveSql(ownerId, plan));
          } else if (rename) {
            await tx.update(folders).set({ name }).where(eq(folders.id, folder.id));
          }
        } else if (rename) {
          await tx
            .update(folders)
            .set({ name })
            .where(and(eq(folders.id, folder.id), eq(folders.ownerId, ownerId)));
        }
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken('folder', name);
        throw error;
      }
      const moved = await liveFolder(tx, ownerId, id);
      if (moved === null) throw new Error('Folder vanished inside its transaction');
      if (body.coverFileId === undefined && body.coverAssetId === undefined) {
        return toDriveFolder(moved);
      }
      // ADR 0011: the share page cover, checked against the folder as it is after this request's
      // move (same transaction). ADR 0028: or an uploaded cover; setting one clears the other,
      // null for either clears both.
      if (body.coverFileId != null) {
        await this.assertCoverFile(tx, ownerId, moved, body.coverFileId);
      }
      if (body.coverAssetId != null) await this.lockCoverAsset(tx, ownerId, body.coverAssetId);
      const cover =
        body.coverAssetId != null
          ? { coverAssetId: body.coverAssetId, coverFileId: null }
          : body.coverFileId != null
            ? { coverFileId: body.coverFileId, coverAssetId: null }
            : { coverFileId: null, coverAssetId: null };
      const [covered] = await tx
        .update(folders)
        .set(cover)
        .where(and(eq(folders.id, id), eq(folders.ownerId, ownerId)))
        .returning();
      if (covered === undefined) throw new Error('Folder vanished inside its transaction');
      return toDriveFolder(covered);
    });
  }

  /**
   * A folder's cover must be the owner's file (else NOT_FOUND) that is live (not trashed or being
   * purged, nor in a trashed folder), `ready`, an image, and inside the folder's subtree; else
   * COVER_FILE_INVALID with the first failing reason, in that order. The file row is locked FOR
   * SHARE so a concurrent trash or move waits for this transaction.
   */
  private async assertCoverFile(
    tx: Tx,
    ownerId: string,
    folder: Pick<Folder, 'path'>,
    fileId: string,
  ): Promise<void> {
    const [file] = await tx
      .select({
        status: files.status,
        mime: files.mime,
        live: sql<boolean>`(${files.deletedAt} IS NULL AND ${files.purgeRequestedAt} IS NULL AND ${folders.deletedAt} IS NULL)`,
        inside: sql<boolean>`coalesce(${folders.path} <@ ${folder.path}::ltree, false)`,
      })
      .from(files)
      .leftJoin(folders, and(eq(folders.id, files.folderId), eq(folders.ownerId, files.ownerId)))
      .where(and(eq(files.id, fileId), eq(files.ownerId, ownerId)))
      .for('share', { of: files })
      .limit(1);
    if (file === undefined) throw notFound('File');
    const reason: CoverFileInvalidReason | null = !file.live
      ? 'not_live'
      : file.status !== 'ready'
        ? 'not_ready'
        : mediaKindOf(file.mime) !== 'image'
          ? 'not_image'
          : !file.inside
            ? 'outside_folder'
            : null;
    if (reason !== null) {
      throw new ApiError('COVER_FILE_INVALID', 'This file cannot be the folder cover', {
        reason,
      } satisfies CoverFileInvalidDetails);
    }
  }

  /**
   * ADR 0028: an uploaded cover must be the caller's live design image (any status but purge
   * requested; it shows once `ready`), else DESIGN_ASSET_NOT_FOUND. Locked FOR KEY SHARE, as a
   * design save does, so the orphan purge can't take it before this transaction commits.
   */
  private async lockCoverAsset(tx: Tx, ownerId: string, assetId: string): Promise<void> {
    const [asset] = await tx
      .select({ id: designAssets.id })
      .from(designAssets)
      .where(
        and(
          eq(designAssets.id, assetId),
          eq(designAssets.ownerId, ownerId),
          isNull(designAssets.purgeRequestedAt),
        ),
      )
      .for('key share');
    if (asset === undefined) {
      throw new ApiError(
        'DESIGN_ASSET_NOT_FOUND',
        'The cover image is not yours or no longer exists',
        {
          assetIds: [assetId],
        },
      );
    }
  }

  // --- PATCH /drive/files/:id ----------------------------------------------------------------

  async updateFile(ownerId: string, id: string, body: UpdateFileBody) {
    return this.db.transaction(async (tx) => {
      const [file] = await tx
        .select()
        .from(files)
        .where(and(eq(files.id, id), eq(files.ownerId, ownerId), isNull(files.deletedAt)))
        .for('update');
      if (file === undefined) throw notFound('File');
      const name = body.name ?? file.name;
      if (body.name !== undefined && !renameKeepsFileType(file.mime, body.name)) {
        throw new ApiError(
          'UNSUPPORTED_FILE_TYPE',
          'The new name must keep an extension of the file type',
          { extension: fileExtension(body.name), hint: rejectedFileTypeHint(body.name, file.mime) },
        );
      }
      let folderId = file.folderId;
      if (body.folderId !== undefined) {
        if (body.folderId !== null) {
          const target = await liveFolder(tx, ownerId, body.folderId, 'share');
          if (target === null) throw notFound('Target folder');
        }
        folderId = body.folderId;
      }
      try {
        const [updated] = await tx
          .update(files)
          .set({ name, folderId })
          .where(and(eq(files.id, file.id), eq(files.ownerId, ownerId)))
          .returning();
        if (updated === undefined) throw new Error('File vanished inside its transaction');
        return this.mapper.toDriveFile(updated);
      } catch (error) {
        if (isUniqueViolation(error)) throw nameTaken('file', name);
        throw error;
      }
    });
  }

  // --- POST /drive/items/trash ---------------------------------------------------------------

  /**
   * Trashes the items in one transaction. A trashed folder stamps every live folder and file
   * below it with the same `deleted_at` (the transaction's `now()`) and `trashed_via_folder_id`.
   * Items already in the trash keep their state. Any unknown id is NOT_FOUND (nothing changes).
   */
  async trash(ownerId: string, items: DriveItemRef[]): Promise<TrashItemsResponse> {
    const folderIds = items.filter((i) => i.kind === 'folder').map((i) => i.id);
    const fileIds = items.filter((i) => i.kind === 'file').map((i) => i.id);
    return this.db.transaction(async (tx) => {
      const lockedFolders = await this.lockTrashable(tx, ownerId, folderIds, fileIds);
      // Ancestors first, so a requested folder inside another requested folder goes with it.
      const ordered = [...lockedFolders].sort(
        (a, b) => a.path.split('.').length - b.path.split('.').length,
      );
      for (const folder of ordered) {
        const [current] = await tx
          .select({ deletedAt: folders.deletedAt })
          .from(folders)
          .where(eq(folders.id, folder.id));
        if (current?.deletedAt !== null) continue;
        await tx.execute(sql`UPDATE ${folders}
          SET deleted_at = now(),
              trashed_via_folder_id = CASE WHEN ${folders.id} = ${folder.id}::uuid THEN NULL ELSE ${folder.id}::uuid END
          WHERE ${folders.ownerId} = ${ownerId}::uuid AND ${folders.path} <@ ${folder.path}::ltree
            AND ${folders.deletedAt} IS NULL`);
        await tx.execute(sql`UPDATE ${files}
          SET deleted_at = now(), trashed_via_folder_id = ${folder.id}::uuid
          WHERE ${files.ownerId} = ${ownerId}::uuid AND ${files.deletedAt} IS NULL
            AND ${files.folderId} IN (
              SELECT ${folders.id} FROM ${folders}
              WHERE ${folders.ownerId} = ${ownerId}::uuid AND ${folders.path} <@ ${folder.path}::ltree)`);
      }
      if (fileIds.length > 0) {
        await tx
          .update(files)
          .set({ deletedAt: sql`now()` })
          .where(
            and(eq(files.ownerId, ownerId), inArray(files.id, fileIds), isNull(files.deletedAt)),
          );
      }
      const stamps = new Map<string, Date>();
      if (folderIds.length > 0) {
        const found = await tx
          .select({ id: folders.id, deletedAt: folders.deletedAt })
          .from(folders)
          .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, folderIds)));
        for (const f of found) if (f.deletedAt !== null) stamps.set(`folder:${f.id}`, f.deletedAt);
      }
      if (fileIds.length > 0) {
        const found = await tx
          .select({ id: files.id, deletedAt: files.deletedAt })
          .from(files)
          .where(and(eq(files.ownerId, ownerId), inArray(files.id, fileIds)));
        for (const f of found) if (f.deletedAt !== null) stamps.set(`file:${f.id}`, f.deletedAt);
      }
      return {
        items: items.map((item) => {
          const deletedAt = stamps.get(`${item.kind}:${item.id}`);
          if (deletedAt === undefined) throw new Error('Trashed item has no deleted_at');
          return { kind: item.kind, id: item.id, deletedAt: deletedAt.toISOString() };
        }),
      };
    });
  }

  /** Locks the requested rows (not purge-requested); NOT_FOUND unless all exist for the owner. */
  private async lockTrashable(tx: Tx, ownerId: string, folderIds: string[], fileIds: string[]) {
    const lockedFolders =
      folderIds.length === 0
        ? []
        : await tx
            .select()
            .from(folders)
            .where(
              and(
                eq(folders.ownerId, ownerId),
                inArray(folders.id, folderIds),
                isNull(folders.purgeRequestedAt),
              ),
            )
            .orderBy(asc(folders.id))
            .for('update');
    const lockedFiles =
      fileIds.length === 0
        ? []
        : await tx
            .select({ id: files.id })
            .from(files)
            .where(
              and(
                eq(files.ownerId, ownerId),
                inArray(files.id, fileIds),
                isNull(files.purgeRequestedAt),
              ),
            )
            .orderBy(asc(files.id))
            .for('update');
    if (lockedFolders.length !== folderIds.length || lockedFiles.length !== fileIds.length) {
      throw notFound('Item');
    }
    return lockedFolders;
  }

  // --- POST /drive/items/restore -------------------------------------------------------------

  /**
   * Restores items the user trashed (rows listed by GET /drive/trash). Each goes back to its old
   * parent, or to the root when that parent isn't live; a taken name becomes ` (2)`, ` (3)`, ….
   * Folders bring back everything trashed with them (`trashed_via_folder_id`).
   */
  async restore(ownerId: string, items: DriveItemRef[]): Promise<RestoreItemsResponse> {
    const folderIds = items.filter((i) => i.kind === 'folder').map((i) => i.id);
    const fileIds = items.filter((i) => i.kind === 'file').map((i) => i.id);
    return this.db.transaction(async (tx) => {
      const restorable = <T extends typeof folders | typeof files>(t: T) =>
        and(
          eq(t.ownerId, ownerId),
          isNotNull(t.deletedAt),
          isNull(t.trashedViaFolderId),
          isNull(t.purgeRequestedAt),
        );
      const trashedFolders =
        folderIds.length === 0
          ? []
          : await tx
              .select()
              .from(folders)
              .where(and(restorable(folders), inArray(folders.id, folderIds)))
              .orderBy(asc(folders.id))
              .for('update');
      const trashedFiles =
        fileIds.length === 0
          ? []
          : await tx
              .select()
              .from(files)
              .where(and(restorable(files), inArray(files.id, fileIds)))
              .orderBy(asc(files.id))
              .for('update');
      if (trashedFolders.length !== folderIds.length || trashedFiles.length !== fileIds.length) {
        throw notFound('Trashed item');
      }

      const byDepth = [...trashedFolders].sort(
        (a, b) => a.path.split('.').length - b.path.split('.').length,
      );
      for (const folder of byDepth) await this.restoreFolder(tx, ownerId, folder);
      for (const file of trashedFiles) await this.restoreFile(tx, ownerId, file);

      const restoredFolders =
        folderIds.length === 0
          ? []
          : await tx
              .select()
              .from(folders)
              .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, folderIds)));
      const restoredFiles =
        fileIds.length === 0
          ? []
          : await tx
              .select()
              .from(files)
              .where(and(eq(files.ownerId, ownerId), inArray(files.id, fileIds)));
      const byKey = new Map<string, DriveItem>([
        ...restoredFolders.map((f) => [`folder:${f.id}`, toDriveFolder(f)] as const),
        ...restoredFiles.map((f) => [`file:${f.id}`, this.mapper.toDriveFile(f)] as const),
      ]);
      return {
        items: items.map((i) => {
          const item = byKey.get(`${i.kind}:${i.id}`);
          if (item === undefined) throw new Error('Restored item vanished');
          return item;
        }),
      };
    });
  }

  private async restoreFolder(tx: Tx, ownerId: string, folder: Folder): Promise<void> {
    const parentLive =
      folder.parentId !== null &&
      (await liveFolder(tx, ownerId, folder.parentId, 'share')) !== null;
    const targetParentId = parentLive ? folder.parentId : null;
    if (targetParentId !== folder.parentId) {
      const result = planFolderMove({
        folder,
        newParent: null,
        subtreeMaxDepth: await subtreeMaxDepth(tx, ownerId, folder.path),
        maxDepth: this.config.drive.maxFolderDepth,
      });
      // Moving to the root only makes the subtree shallower.
      if (!result.ok) throw new Error(`Restore to the root failed: ${result.code}`);
      await tx.execute(folderSubtreeMoveSql(ownerId, result.plan));
    }
    await withFreeName(
      tx,
      { ownerId, kind: 'folder', parentId: targetParentId, name: folder.name },
      (sp, name) =>
        sp
          .update(folders)
          .set({ deletedAt: null, name })
          .where(and(eq(folders.id, folder.id), eq(folders.ownerId, ownerId))),
    );
    await tx
      .update(folders)
      .set({ deletedAt: null, trashedViaFolderId: null })
      .where(and(eq(folders.ownerId, ownerId), eq(folders.trashedViaFolderId, folder.id)));
    await tx
      .update(files)
      .set({ deletedAt: null, trashedViaFolderId: null })
      .where(and(eq(files.ownerId, ownerId), eq(files.trashedViaFolderId, folder.id)));
  }

  private async restoreFile(tx: Tx, ownerId: string, file: DriveFileRow): Promise<void> {
    const folderLive =
      file.folderId !== null && (await liveFolder(tx, ownerId, file.folderId, 'share')) !== null;
    const folderId = folderLive ? file.folderId : null;
    await withFreeName(
      tx,
      { ownerId, kind: 'file', parentId: folderId, name: file.name },
      (sp, name) =>
        sp
          .update(files)
          .set({ deletedAt: null, folderId, name })
          .where(and(eq(files.id, file.id), eq(files.ownerId, ownerId))),
    );
  }

  // --- GET /drive/trash ----------------------------------------------------------------------

  async listTrash(
    ownerId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<ListTrashResponse> {
    const limit = query.limit ?? this.config.drive.pageSize;
    let after: DriveCursor | null = null;
    if (query.cursor !== undefined) {
      after = decodeDriveCursor(query.cursor);
      if (after === null) throw validationError(['query', 'cursor'], 'is not a valid cursor');
      if (after.phase !== 'trash' || after.key === null) {
        throw validationError(['query', 'cursor'], 'does not belong to this listing');
      }
    }
    const keyset = (t: typeof folders | typeof files): SQL | undefined =>
      after === null
        ? undefined
        : sql`(${t.deletedAt}, ${t.id}) < (${after.key}::timestamptz, ${after.id}::uuid)`;
    const listed = (t: typeof folders | typeof files) =>
      and(
        eq(t.ownerId, ownerId),
        isNotNull(t.deletedAt),
        isNull(t.trashedViaFolderId),
        isNull(t.purgeRequestedAt),
        keyset(t),
      );
    const sortKey = (t: typeof folders | typeof files) => ({
      key: sql<string>`${t.deletedAt}::text`,
      micros: sql<string>`(extract(epoch from ${t.deletedAt}) * 1000000)::bigint::text`,
    });
    const trashedFolders = await this.db
      .select({ row: folders, ...sortKey(folders) })
      .from(folders)
      .where(listed(folders))
      .orderBy(desc(folders.deletedAt), desc(folders.id))
      .limit(limit + 1);
    const trashedFiles = await this.db
      .select({ row: files, ...sortKey(files) })
      .from(files)
      .where(listed(files))
      .orderBy(desc(files.deletedAt), desc(files.id))
      .limit(limit + 1);
    const merged = [
      ...trashedFolders.map((r) => ({ ...r, kind: 'folder' as const })),
      ...trashedFiles.map((r) => ({ ...r, kind: 'file' as const })),
    ].sort((a, b) => {
      const da = BigInt(a.micros);
      const db = BigInt(b.micros);
      if (da !== db) return da > db ? -1 : 1;
      return a.row.id > b.row.id ? -1 : a.row.id < b.row.id ? 1 : 0;
    });
    const shown = merged.slice(0, limit);
    const last = shown.at(-1);
    const retentionMs = this.config.retention.trashRetentionDays * MS_PER_DAY;
    const items = shown.map((r): TrashItem => {
      const deletedAt = r.row.deletedAt ?? new Date(0);
      const extra = {
        deletedAt: deletedAt.toISOString(),
        purgeAt: new Date(deletedAt.getTime() + retentionMs).toISOString(),
      };
      return r.kind === 'folder'
        ? { ...toDriveFolder(r.row), ...extra }
        : { ...this.mapper.toDriveFile(r.row), ...extra };
    });
    return {
      items,
      nextCursor:
        merged.length > limit && last !== undefined
          ? encodeDriveCursor({
              v: 1,
              sort: 'createdAt',
              order: 'desc',
              phase: 'trash',
              key: last.key,
              kind: last.kind,
              id: last.row.id,
            })
          : null,
    };
  }

  // --- DELETE /drive/trash -------------------------------------------------------------------

  /**
   * Marks everything in the trash for purge and releases its bytes from storage_usage in the same
   * transaction (each file from the counter it is in, see drive/quota). The worker deletes the
   * objects and faces later. Files are updated before storage_usage, the same lock order as the
   * worker's verify, so the two can't deadlock; a file verified concurrently is released from
   * `used` because the UPDATE re-reads it.
   */
  async emptyTrash(ownerId: string): Promise<EmptyTrashResponse> {
    return this.db.transaction(async (tx) => {
      const [purged] = await rows<{ files: string; used: string; reserved: string }>(
        tx,
        sql`WITH purged AS (
              UPDATE ${files} SET purge_requested_at = now()
              WHERE ${files.ownerId} = ${ownerId}::uuid AND ${files.deletedAt} IS NOT NULL
                AND ${files.purgeRequestedAt} IS NULL
              RETURNING ${files.sizeBytes} AS size, ${files.status} AS status, ${files.verifiedAt} AS verified_at)
            SELECT count(*)::text AS files,
              coalesce(sum(size) FILTER (WHERE verified_at IS NOT NULL), 0)::text AS used,
              coalesce(sum(size) FILTER (WHERE verified_at IS NULL AND status <> 'failed'), 0)::text AS reserved
            FROM purged`,
      );
      const used = Number(purged?.used ?? 0);
      const reserved = Number(purged?.reserved ?? 0);
      if (used > 0 || reserved > 0) {
        await tx
          .update(storageUsage)
          .set({
            usedBytes: sql`greatest(0, ${storageUsage.usedBytes} - ${used})`,
            reservedBytes: sql`greatest(0, ${storageUsage.reservedBytes} - ${reserved})`,
          })
          .where(eq(storageUsage.photographerId, ownerId));
      }
      const [marked] = await rows<{ folders: string }>(
        tx,
        sql`WITH marked AS (
              UPDATE ${folders} SET purge_requested_at = now()
              WHERE ${folders.ownerId} = ${ownerId}::uuid AND ${folders.deletedAt} IS NOT NULL
                AND ${folders.purgeRequestedAt} IS NULL
              RETURNING 1)
            SELECT count(*)::text AS folders FROM marked`,
      );
      return {
        folders: Number(marked?.folders ?? 0),
        files: Number(purged?.files ?? 0),
        bytes: used + reserved,
      };
    });
  }

  // --- PATCH /drive/folders/:id/face-index --------------------------------------------------

  /**
   * Turns face indexing of a folder subtree on (PDPA: the photographer confirmed attendees were
   * informed; stored as face_index_informed_at) or extends it to max(current, now +
   * FACE_INDEX_EXPIRY_DAYS), or turns it off. Turning on a folder without an active index stamps
   * face_index_queued_at in the same transaction and sends `index.folder` after the commit; if the send fails, the change is undone and the request fails,
   * so a retry sends it again. Turning off always sends `unindex.folder` (idempotent; the daily
   * expiry job also catches anything a failed send left behind).
   */
  async updateFaceIndex(
    ownerId: string,
    id: string,
    body: { enabled: true; attendeesInformedConfirmed?: true | undefined } | { enabled: false },
  ): Promise<DriveFolder> {
    const now = this.clock.now();
    if (!body.enabled) {
      const folder = await this.db.transaction(async (tx) => {
        const current = await liveFolder(tx, ownerId, id, 'update');
        if (current === null) throw notFound('Folder');
        const [updated] = await tx
          .update(folders)
          // No index.folder is outstanding once indexing is off (faces.sweep must not re-send it).
          .set({ faceIndexEnabled: false, faceIndexExpiresAt: null, faceIndexQueuedAt: null })
          .where(and(eq(folders.id, id), eq(folders.ownerId, ownerId)))
          .returning();
        if (updated === undefined) throw new Error('Folder vanished inside its transaction');
        return updated;
      });
      await this.queue.send('faces', { type: 'unindex.folder', folderId: folder.id });
      return toDriveFolder(folder);
    }

    if (!this.config.features.faceSearch) {
      throw new ApiError('FEATURE_DISABLED', 'Face search is not available', {
        feature: 'face_search',
      });
    }
    const target = new Date(now.getTime() + this.config.retention.faceIndexExpiryDays * MS_PER_DAY);
    const { before, after } = await this.db.transaction(async (tx) => {
      // ADR 0010: only with BILLING_MODE=gateway does face indexing need a subscription.
      if (billingOnline(this.config)) {
        const subscription = await currentSubscription(tx, ownerId);
        if (!subscriptionAllowsSharing(subscription?.status ?? null)) {
          throw new ApiError(
            'SUBSCRIPTION_INACTIVE',
            'Face indexing needs an active subscription',
            { status: subscription?.status ?? null },
          );
        }
      }
      // ADR 0026: turning indexing on (or extending it) needs a package that still runs (no
      // package row: unlimited). Turning it off always works.
      await assertPackageActive(tx, ownerId, now);
      const current = await liveFolder(tx, ownerId, id, 'update');
      if (current === null) throw notFound('Folder');
      const expiresAt =
        current.faceIndexExpiresAt !== null && current.faceIndexExpiresAt > target
          ? current.faceIndexExpiresAt
          : target;
      // Outbox mark (migration 0006): index.folder will be sent after the commit; faces.sweep
      // re-sends it if the message is lost, the worker clears it when the fan-out is done.
      const sendsIndex = !isFaceIndexActive(current, now);
      const [updated] = await tx
        .update(folders)
        // ADR 0011 decision 1: no attendee confirmation any more; face_index_informed_at keeps
        // the record of earlier confirmations and is no longer written.
        .set({
          faceIndexEnabled: true,
          faceIndexExpiresAt: expiresAt,
          ...(sendsIndex ? { faceIndexQueuedAt: now } : {}),
        })
        .where(and(eq(folders.id, id), eq(folders.ownerId, ownerId)))
        .returning();
      if (updated === undefined) throw new Error('Folder vanished inside its transaction');
      return { before: current, after: updated };
    });
    if (!isFaceIndexActive(before, now)) {
      try {
        await this.queue.send('faces', { type: 'index.folder', folderId: after.id });
      } catch (error) {
        // Undo, unless something else changed the folder meanwhile.
        await this.db
          .update(folders)
          .set({
            faceIndexEnabled: before.faceIndexEnabled,
            faceIndexExpiresAt: before.faceIndexExpiresAt,
            faceIndexQueuedAt: before.faceIndexQueuedAt,
          })
          // This request's own outbox mark: undone only while nothing else changed it since.
          .where(
            and(
              eq(folders.id, id),
              eq(folders.ownerId, ownerId),
              eq(folders.faceIndexQueuedAt, now),
            ),
          );
        throw error;
      }
    }
    return toDriveFolder(after);
  }

  // --- GET /drive/files/:id/download ---------------------------------------------------------

  /**
   * The owner's download of their own file, in any subscription status, trashed files included:
   * a signed URL with Content-Disposition attachment (download TTL) and an `owner` download event.
   * `original` needs the upload completed and the bytes accepted; `web` needs the file `ready`.
   */
  async downloadFile(ownerId: string, id: string, size: DownloadSize): Promise<SignedDownload> {
    const [file] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.ownerId, ownerId), isNull(files.purgeRequestedAt)));
    if (file === undefined) throw notFound('File');
    const servable =
      size === 'original'
        ? file.uploadId === null && (file.status === 'processing' || file.status === 'ready')
        : file.status === 'ready';
    const object = servable
      ? downloadObject({ ...file, mediaKind: mediaKindOf(file.mime) }, size)
      : null;
    if (object === null) throw new ApiError('CONFLICT', 'The file is not ready for download yet');
    const signed = this.urls.download(object.key, object.fileName);
    await recordActivity(this.db, {
      type: 'download',
      source: 'owner',
      shareId: null,
      photographerId: ownerId,
      viewerId: null,
      anonId: null,
      fileId: file.id,
      bytes: object.bytes,
      meta: null,
    });
    return {
      fileId: file.id,
      url: signed.url,
      fileName: object.fileName,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  // --- GET /drive/usage ----------------------------------------------------------------------

  async usage(ownerId: string): Promise<DriveUsageResponse> {
    return this.db.transaction(
      async (tx) => {
        const subscription = await currentSubscription(tx, ownerId);
        const pkg = await photographerPackage(tx, ownerId);
        const counters = await storageCounters(tx, ownerId);
        const trashBytes = await trashedQuotaBytes(tx, ownerId);
        const state = { ...counters, quotaBytes: subscription?.quotaBytes ?? 0 };
        // ADR 0010: no limit while STORAGE_QUOTA_ENFORCED=false (quota and available are null),
        // and no subscription gate while BILLING_MODE=offline.
        const gate = uploadGate(this.config);
        return {
          usedBytes: counters.usedBytes,
          reservedBytes: counters.reservedBytes,
          quotaBytes: gate.quota ? state.quotaBytes : null,
          availableBytes: gate.quota ? availableBytes(state) : null,
          trashBytes,
          subscription:
            subscription === null
              ? null
              : {
                  status: subscription.status,
                  planCode: subscription.planCode,
                  periodEnd: subscription.periodEnd.toISOString(),
                },
          // ADR 0026: the package first (expired, then no photos left); null when unlimited.
          uploadsBlockedBy:
            packageUploadsBlockedBy(pkg, this.clock.now()) ??
            uploadsBlockedUnder(gate, subscription?.status ?? null, state),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

/** Bytes of trashed files that still count (in used or reserved), i.e. not failed or purged. */
async function trashedQuotaBytes(q: Queryable, ownerId: string): Promise<number> {
  const [row] = await q
    .select({ bytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`.mapWith(Number) })
    .from(files)
    .where(
      and(
        eq(files.ownerId, ownerId),
        isNotNull(files.deletedAt),
        isNull(files.purgeRequestedAt),
        sql`(${files.verifiedAt} IS NOT NULL OR ${files.status} <> 'failed')`,
      ),
    );
  return row?.bytes ?? 0;
}
