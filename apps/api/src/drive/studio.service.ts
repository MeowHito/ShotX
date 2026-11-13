import { Inject, Injectable } from '@nestjs/common';
import {
  dailyStats,
  type DriveFile as DriveFileRow,
  driveNameKeySql,
  files,
  type Folder,
  folders,
  zipJobEntries,
  zipJobs,
} from '@shotx/db';
import type { searchDriveQuerySchema } from '@shotx/shared';
import {
  type CopyFileResponse,
  decodeDriveCursor,
  type DownloadSize,
  downloadObject,
  type DriveCursor,
  driveNameKey,
  DRIVE_STATS_DEFAULT_DAYS,
  type DriveStatsResponse,
  driveSearchPattern,
  encodeDriveCursor,
  fileCopyMessageSchema,
  fileExtension,
  type FolderSummaryResponse,
  type GetFileResponse,
  type ListRecentResponse,
  type MediaKind,
  originalKey,
  rejectedFileTypeHint,
  renameKeepsFileType,
  reserveQuota,
  sanitizeOriginalName,
  type SearchDriveResponse,
  searchExcludesFolders,
  type SearchResult,
  subscriptionAllowsUploads,
  UPLOAD_FILE_TYPES,
  type UploadNameConflictMode,
  uniqueZipEntryPaths,
  type ZipJobView,
} from '@shotx/shared';
import { and, desc, eq, gte, inArray, isNull, lt, ne, type SQL, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { recordActivity } from '../activity/activity';
import { type ApiConfig, apiSendsMediaJobs } from '../config';
import { type Db, isUniqueViolation, rows, type Tx } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { addDays, bangkokDate } from '../share/shares.service';
import type { EventLog } from '../infra/events';
import { SignedUrls } from '../media/signed-urls';
import { type ZipJobRow, zipJobView } from '../public/downloads.service';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  EVENT_LOG,
  QUEUE_SENDER,
  type QueueSender,
  RATE_LIMITER,
  type RateLimiter,
} from '../tokens';
import { currentSubscription, reserveQuotaBytes, storageCounters, uploadGate } from './account';
import { listingOrder } from './drive.service';
import { ancestorsOf, liveFolder, newId, pathFolderIds } from './folders';
import { DriveFileMapper, toDriveFolder } from './media-urls';
import { withFreeName } from './names';

// Drive-style studio (Wave 7, api/studio in @shotx/shared): copy, owner folder zips, recent,
// search and item info. Every query filters by owner_id = the caller (PhotographerGuard), so other
// owners' ids are NOT_FOUND.

type SearchQuery = z.output<typeof searchDriveQuerySchema>;

/** Files a listing may show: not uploads in progress, not failed ones. */
const SHOWN_STATUSES = ['processing', 'ready'] as const;

const mimesOf = (kind: MediaKind) =>
  UPLOAD_FILE_TYPES.filter((t) => t.kind === kind).map((t) => t.mime);

const quotaExceeded = (details: {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
  requestedBytes: number;
  availableBytes: number;
}) => new ApiError('QUOTA_EXCEEDED', 'Not enough storage left in the plan', details);

const keyReused = () =>
  new ApiError('IDEMPOTENCY_KEY_REUSED', 'This id was used before for another request');

const rateLimited = (retryAfterSeconds: number, message: string) =>
  new ApiError('RATE_LIMITED', message, undefined, { 'Retry-After': String(retryAfterSeconds) });

/** `files.folder_id` is a folder of the owner's subtree at `path` (the folder itself included). */
function fileInSubtree(ownerId: string, path: string, liveOnly: boolean): SQL {
  return sql`${files.folderId} IN (SELECT ${folders.id} FROM ${folders}
    WHERE ${folders.ownerId} = ${ownerId}::uuid AND ${folders.path} <@ ${path}::ltree
    ${liveOnly ? sql`AND ${folders.deletedAt} IS NULL` : sql``})`;
}

/** The archive's download name of an owner zip: the folder's name + `.zip`, sanitized. */
export function ownerArchiveName(folderName: string): string {
  const name = sanitizeOriginalName(`${folderName}.zip`);
  return name.toLowerCase().endsWith('.zip') && name.length >= 5 ? name : 'folder.zip';
}

@Injectable()
export class StudioService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DriveFileMapper) private readonly mapper: DriveFileMapper,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(QUEUE_SENDER) private readonly queue: QueueSender,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(SignedUrls) private readonly urls: SignedUrls,
    @Inject(EVENT_LOG) private readonly events: EventLog,
  ) {}

  // --- POST /drive/files/:id/copy --------------------------------------------------------------

  async copyFile(
    ownerId: string,
    sourceId: string,
    body: {
      targetFolderId: string | null;
      name?: string | undefined;
      onNameConflict: UploadNameConflictMode;
      clientCopyId?: string | undefined;
    },
  ): Promise<CopyFileResponse> {
    const { limit, windowSeconds } = this.config.drive.copyRate;
    const rate = await this.limiter.hit(`drive-copy:${ownerId}`, limit, windowSeconds);
    if (!rate.allowed)
      throw rateLimited(rate.retryAfterSeconds, 'Too many copies; try again later');

    const now = this.clock.now();
    const result = await this.db.transaction(async (tx) => {
      if (body.clientCopyId !== undefined) {
        // The `upload-init:` namespace on purpose: clientCopyId lives in files.client_upload_id,
        // which uploads use too, so a copy and an upload init with the same id serialise on the
        // same lock (and the second sees the first's row: IDEMPOTENCY_KEY_REUSED).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`upload-init:${ownerId}:${body.clientCopyId}`}, 0))`,
        );
        const [existing] = await tx
          .select()
          .from(files)
          .where(and(eq(files.ownerId, ownerId), eq(files.clientUploadId, body.clientCopyId)));
        if (existing !== undefined) {
          if (existing.copiedFromFileId !== sourceId || existing.folderId !== body.targetFolderId) {
            throw keyReused();
          }
          return { file: existing, created: false };
        }
      }

      // FOR SHARE: the source can't be trashed or purged while it is copied.
      const [source] = await tx
        .select()
        .from(files)
        .where(
          and(
            eq(files.id, sourceId),
            eq(files.ownerId, ownerId),
            isNull(files.deletedAt),
            isNull(files.purgeRequestedAt),
          ),
        )
        .for('share');
      if (source === undefined) throw notFound('File');
      if (source.status !== 'ready')
        throw new ApiError('CONFLICT', 'Only ready files can be copied');
      if (body.targetFolderId !== null) {
        const target = await liveFolder(tx, ownerId, body.targetFolderId, 'share');
        if (target === null) throw notFound('Target folder');
      }
      const name = body.name ?? source.name;
      if (body.name !== undefined && !renameKeepsFileType(source.mime, body.name)) {
        throw new ApiError(
          'UNSUPPORTED_FILE_TYPE',
          'The name must keep an extension of the file type',
          {
            extension: fileExtension(body.name),
            hint: rejectedFileTypeHint(body.name, source.mime),
          },
        );
      }

      // The upload gate and the reservation, as for an upload init (ADR 0010: subscription only
      // with BILLING_MODE=gateway, quota only with STORAGE_QUOTA_ENFORCED).
      const gate = uploadGate(this.config);
      let quotaBytes: number | null = null;
      if (gate.subscription || gate.quota) {
        const subscription = await currentSubscription(tx, ownerId, { lock: 'share' });
        if (gate.subscription && !subscriptionAllowsUploads(subscription?.status ?? null)) {
          throw new ApiError('SUBSCRIPTION_INACTIVE', 'Copies need an active subscription', {
            status: subscription?.status ?? null,
          });
        }
        if (gate.quota) quotaBytes = subscription?.quotaBytes ?? 0;
      }
      if (
        !(await reserveQuotaBytes(tx, ownerId, source.sizeBytes, quotaBytes)) &&
        quotaBytes !== null
      ) {
        const check = reserveQuota(
          { ...(await storageCounters(tx, ownerId)), quotaBytes },
          source.sizeBytes,
        );
        throw quotaExceeded(
          check.ok
            ? {
                quotaBytes,
                usedBytes: 0,
                reservedBytes: 0,
                requestedBytes: source.sizeBytes,
                availableBytes: 0,
              }
            : check.details,
        );
      }

      const fileId = await newId(tx);
      const key = originalKey({
        photographerId: ownerId,
        fileId,
        originalName: sanitizeOriginalName(name),
      });
      const insert = (q: Tx, chosen: string) =>
        q
          .insert(files)
          .values({
            id: fileId,
            ownerId,
            folderId: body.targetFolderId,
            name: chosen,
            mime: source.mime,
            sizeBytes: source.sizeBytes,
            sha256: source.sha256,
            width: source.width,
            height: source.height,
            takenAt: source.takenAt,
            webSizeBytes: source.webSizeBytes,
            // PDPA: a copy of a photo whose faces were withheld stays withheld (migration 0009).
            facesWithheldAt: source.facesWithheldAt,
            s3Key: key,
            status: 'processing',
            clientUploadId: body.clientCopyId ?? null,
            copiedFromFileId: source.id,
            mediaQueuedAt: now,
          })
          .returning();
      let inserted: DriveFileRow[];
      if (body.onNameConflict === 'fail') {
        try {
          inserted = await tx.transaction((sp) => insert(sp, name));
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ApiError('NAME_TAKEN', 'A file with this name already exists here', {
              kind: 'file',
              name,
            });
          }
          throw error;
        }
      } else {
        inserted = await withFreeName(
          tx,
          { ownerId, kind: 'file', parentId: body.targetFolderId, name },
          insert,
        );
      }
      const [file] = inserted;
      if (file === undefined) throw new Error('File insert returned no row');
      return { file, created: true };
    });

    if (result.created && result.file.copiedFromFileId !== null) {
      await this.startCopy(result.file, result.file.copiedFromFileId);
    }
    return this.mapper.toDriveFile(result.file);
  }

  /**
   * Sends `file.copy` after the commit, with QUEUE_BACKEND=bullmq only (like original.completed;
   * on SQS the api has no media queue URL, and media.sweep sends it for `processing` rows with
   * `copied_from_file_id`). A failure is logged and doesn't fail the request.
   */
  private async startCopy(file: DriveFileRow, sourceFileId: string): Promise<void> {
    if (!apiSendsMediaJobs(this.config)) return;
    try {
      await this.queue.send(
        'media',
        fileCopyMessageSchema.parse({
          kind: 'file.copy',
          fileId: file.id,
          sourceFileId,
          photographerId: file.ownerId,
        }),
      );
    } catch (error) {
      this.events.warn('media.enqueue_failed', {
        fileId: file.id,
        photographerId: file.ownerId,
        queue: 'media',
        kind: 'file.copy',
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  // --- POST /drive/folders/:id/download, GET /drive/zip-jobs/:id --------------------------------

  async downloadFolder(
    ownerId: string,
    folderId: string,
    size: DownloadSize,
    idempotencyKey: string | undefined,
  ): Promise<{ job: ZipJobView }> {
    const folder = await liveFolder(this.db, ownerId, folderId);
    if (folder === null) throw notFound('Folder');
    if (idempotencyKey !== undefined) {
      const replay = await this.replayOwnerZip(ownerId, folderId, size, idempotencyKey);
      if (replay !== null) return { job: replay };
    }

    const { maxFiles, maxBytes } = this.config.share.zip;
    // Counted in SQL first, so a huge folder is refused without loading it.
    const totals = await this.folderZipTotals(ownerId, folder, size);
    if (totals.files === 0) {
      throw new ApiError('CONFLICT', 'The folder has no ready files to download');
    }
    const tooLarge = (message: string, files: number, bytes: number) =>
      new ApiError('ZIP_TOO_LARGE', message, { maxFiles, maxBytes, files, bytes });
    if (totals.files > maxFiles || totals.bytes > maxBytes) {
      throw tooLarge('Too many files or bytes for one zip', totals.files, totals.bytes);
    }
    const entries = await this.folderZipEntries(ownerId, folder, size, maxFiles + 1);
    const bytes = entries.reduce((sum, e) => sum + e.bytes, 0);
    // Files added since the count: check again on what will be zipped.
    if (entries.length > maxFiles || bytes > maxBytes) {
      throw tooLarge('Too many files or bytes for one zip', entries.length, bytes);
    }

    let job: ZipJobRow;
    try {
      job = await this.db.transaction(async (tx) => {
        // Serialises this owner's job creations, so the active-job cap holds.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`owner-zip:${ownerId}`}, 0))`,
        );
        // Active: queued or running within the zip processing window (WORKER_ZIP_MAX_PROCESSING_
        // SECONDS). Older ones were lost or stuck; they must not lock the photographer out.
        const since = new Date(this.clock.now().getTime() - this.config.zipJobActiveMs);
        const [active] = await rows<{ n: string }>(
          tx,
          sql`SELECT count(*)::text AS n FROM ${zipJobs}
              WHERE ${zipJobs.photographerId} = ${ownerId}::uuid AND ${zipJobs.shareId} IS NULL
                AND ((${zipJobs.status} = 'queued' AND ${zipJobs.createdAt} > ${since.toISOString()}::timestamptz)
                  OR (${zipJobs.status} = 'running' AND ${zipJobs.startedAt} > ${since.toISOString()}::timestamptz))`,
        );
        if (Number(active?.n ?? 0) >= this.config.drive.zipMaxActiveJobs) {
          throw rateLimited(30, 'Too many folder downloads in progress; try again later');
        }
        const [created] = await tx
          .insert(zipJobs)
          .values({
            photographerId: ownerId,
            shareId: null,
            viewerId: ownerId,
            anonId: null,
            downloadSize: size,
            fileCount: entries.length,
            totalBytes: bytes,
            idempotencyKey: idempotencyKey ?? null,
            archiveName: ownerArchiveName(folder.name),
            sourceFolderId: folder.id,
            // On the API's clock, which the active-job window above is measured on.
            createdAt: this.clock.now(),
          })
          .returning();
        if (created === undefined) throw new Error('zip_jobs insert returned no row');
        await tx.insert(zipJobEntries).values(
          entries.map((e, position) => ({
            jobId: created.id,
            photographerId: ownerId,
            position,
            fileId: e.fileId,
            name: e.path,
          })),
        );
        return created;
      });
    } catch (error) {
      if (
        idempotencyKey === undefined ||
        !isUniqueViolation(error, 'zip_jobs_owner_idempotency_unique')
      ) {
        throw error;
      }
      const raced = await this.replayOwnerZip(ownerId, folderId, size, idempotencyKey);
      if (raced === null) throw error;
      return { job: raced };
    }
    try {
      await this.queue.send('zip', { type: 'zip.create', jobId: job.id });
    } catch (error) {
      // Not left queued forever: fail the job (it no longer counts as active) and the request.
      await this.db
        .update(zipJobs)
        .set({ status: 'failed', errorCode: 'INTERNAL_ERROR', completedAt: this.clock.now() })
        .where(and(eq(zipJobs.id, job.id), eq(zipJobs.status, 'queued')));
      throw error;
    }
    return { job: await this.ownerJobView(job) };
  }

  /** The existing owner job of this Idempotency-Key, re-sent while queued; null if none. */
  private async replayOwnerZip(
    ownerId: string,
    folderId: string,
    size: DownloadSize,
    idempotencyKey: string,
  ): Promise<ZipJobView | null> {
    const [existing] = await this.db
      .select()
      .from(zipJobs)
      .where(
        and(
          eq(zipJobs.photographerId, ownerId),
          isNull(zipJobs.shareId),
          eq(zipJobs.idempotencyKey, idempotencyKey),
        ),
      );
    if (existing === undefined) return null;
    if (existing.sourceFolderId !== folderId || existing.downloadSize !== size) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was used before for another download',
      );
    }
    if (existing.status === 'queued') {
      await this.queue.send('zip', { type: 'zip.create', jobId: existing.id });
    }
    return this.ownerJobView(existing);
  }

  /** Which files of a folder zip in `size`, and the bytes each adds (as downloadObject). */
  private zippable(size: DownloadSize): { where: SQL | undefined; bytes: SQL } {
    if (size === 'original') return { where: undefined, bytes: sql`${files.sizeBytes}` };
    return {
      where: sql`((${inArray(files.mime, mimesOf('image'))} AND ${files.webKey} IS NOT NULL)
        OR (${inArray(files.mime, mimesOf('video'))} AND ${files.previewKey} IS NOT NULL))`,
      bytes: sql`coalesce(${files.webSizeBytes}, 0)`,
    };
  }

  /** `ready`, live files of the folder's live subtree that zip in `size`. */
  private zipFilesWhere(ownerId: string, folder: Folder, size: DownloadSize): SQL | undefined {
    return and(
      eq(files.ownerId, ownerId),
      eq(files.status, 'ready'),
      isNull(files.deletedAt),
      isNull(files.purgeRequestedAt),
      fileInSubtree(ownerId, folder.path, true),
      this.zippable(size).where,
    );
  }

  private async folderZipTotals(
    ownerId: string,
    folder: Folder,
    size: DownloadSize,
  ): Promise<{ files: number; bytes: number }> {
    const [row] = await this.db
      .select({
        files: sql<number>`count(*)`.mapWith(Number),
        bytes: sql<number>`coalesce(sum(${this.zippable(size).bytes}), 0)`.mapWith(Number),
      })
      .from(files)
      .where(this.zipFilesWhere(ownerId, folder, size));
    return { files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
  }

  /**
   * The archive entries of a folder (at most `limit`): its zippable files with their paths below
   * the folder (each segment sanitized, paths unique ignoring case), ordered by folder and name so
   * the archive is stable. Only the folders on those files' paths are loaded. A path too long or
   * too deep for an archive entry (ZIP_ENTRY_PATH_MAX_BYTES / _SEGMENTS) is ZIP_TOO_LARGE.
   */
  private async folderZipEntries(
    ownerId: string,
    folder: Folder,
    size: DownloadSize,
    limit: number,
  ): Promise<{ fileId: string; path: string; bytes: number }[]> {
    const found = await this.db
      .select()
      .from(files)
      .where(this.zipFilesWhere(ownerId, folder, size))
      .orderBy(files.folderId, driveNameKeySql(files.name), files.id)
      .limit(limit);
    const parentIds = [...new Set(found.flatMap((f) => (f.folderId === null ? [] : [f.folderId])))];
    const parents =
      parentIds.length === 0
        ? []
        : await this.db
            .select({ id: folders.id, path: folders.path })
            .from(folders)
            .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, parentIds)));
    const parentPath = new Map(parents.map((p) => [p.id, p.path]));
    const depth = pathFolderIds(folder.path).length;
    const below = [...new Set(parents.flatMap((p) => pathFolderIds(p.path).slice(depth)))];
    const named =
      below.length === 0
        ? []
        : await this.db
            .select({ id: folders.id, name: folders.name })
            .from(folders)
            .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, below)));
    const nameOf = new Map(named.map((f) => [f.id, f.name]));
    const items = found.flatMap((file) => {
      const path = file.folderId === null ? undefined : parentPath.get(file.folderId);
      if (path === undefined) return [];
      const object = downloadObject(
        {
          ...file,
          mediaKind: UPLOAD_FILE_TYPES.find((t) => t.mime === file.mime)?.kind ?? 'image',
        },
        size,
      );
      if (object === null) return [];
      const dirs = pathFolderIds(path)
        .slice(depth)
        .map((id) => sanitizeOriginalName(nameOf.get(id) ?? 'folder'));
      return [{ file, dirs, object, sortKey: `${path}\u0000${driveNameKey(file.name)}` }];
    });
    items.sort((a, b) =>
      a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.file.id < b.file.id ? -1 : 1,
    );
    let paths: string[];
    try {
      paths = uniqueZipEntryPaths(items.map((i) => [...i.dirs, i.object.fileName]));
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      const { maxFiles, maxBytes } = this.config.share.zip;
      throw new ApiError(
        'ZIP_TOO_LARGE',
        'A folder path is too long or too deep for a zip archive; zip a folder further down',
        {
          maxFiles,
          maxBytes,
          files: items.length,
          bytes: items.reduce((sum, i) => sum + i.object.bytes, 0),
        },
      );
    }
    return items.map((i, n) => ({
      fileId: i.file.id,
      path: paths[n] ?? i.object.fileName,
      bytes: i.object.bytes,
    }));
  }

  async ownerZipJob(ownerId: string, id: string): Promise<ZipJobView> {
    const [job] = await this.db
      .select()
      .from(zipJobs)
      .where(and(eq(zipJobs.id, id), eq(zipJobs.photographerId, ownerId), isNull(zipJobs.shareId)));
    if (job === undefined) throw notFound('Zip job');
    return this.ownerJobView(job);
  }

  /**
   * The job view; a ready, unexpired archive gets a signed URL, and the first response that
   * issues it writes one `zip` activity event with source `owner` (no share, no viewer).
   */
  private async ownerJobView(job: ZipJobRow): Promise<ZipJobView> {
    const now = this.clock.now();
    const fileName = job.archiveName ?? 'folder.zip';
    if (
      job.status !== 'ready' ||
      job.resultKey === null ||
      job.expiresAt === null ||
      job.expiresAt <= now
    ) {
      return zipJobView(job, fileName, null, now);
    }
    const signed = this.urls.download(job.resultKey, fileName);
    const [first] = await this.db
      .update(zipJobs)
      .set({ urlIssuedAt: now })
      .where(and(eq(zipJobs.id, job.id), isNull(zipJobs.urlIssuedAt)))
      .returning({ id: zipJobs.id });
    if (first !== undefined) {
      await recordActivity(this.db, {
        type: 'zip',
        source: 'owner',
        shareId: null,
        photographerId: job.photographerId,
        viewerId: null,
        anonId: null,
        fileId: null,
        bytes: job.resultBytes ?? 0,
        meta: { files: job.fileCount },
      });
    }
    return zipJobView(job, fileName, signed, now);
  }

  // --- GET /drive/recent -----------------------------------------------------------------------

  async recent(
    ownerId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<ListRecentResponse> {
    const limit = query.limit ?? this.config.drive.recentPageSize;
    let after: DriveCursor | null = null;
    if (query.cursor !== undefined) {
      after = decodeDriveCursor(query.cursor);
      if (after?.phase !== 'recent') {
        throw validationError(['query', 'cursor'], 'does not belong to this listing');
      }
    }
    const found = await this.db
      .select()
      .from(files)
      .where(
        and(
          eq(files.ownerId, ownerId),
          isNull(files.deletedAt),
          inArray(files.status, [...SHOWN_STATUSES]),
          after === null ? undefined : lt(files.id, after.id),
        ),
      )
      .orderBy(desc(files.id))
      .limit(limit + 1);
    const shown = found.slice(0, limit);
    const last = shown.at(-1);
    return {
      items: shown.map((row) => this.mapper.toDriveFile(row)),
      nextCursor:
        found.length > limit && last !== undefined
          ? encodeDriveCursor({
              v: 1,
              sort: 'createdAt',
              order: 'desc',
              phase: 'recent',
              key: null,
              kind: 'file',
              id: last.id,
            })
          : null,
    };
  }

  // --- GET /drive/stats (ADR 0023) ----------------------------------------------------------------

  async stats(ownerId: string, query: { days?: number | undefined }): Promise<DriveStatsResponse> {
    const length = query.days ?? DRIVE_STATS_DEFAULT_DAYS;
    const to = bangkokDate(this.clock.now());
    const from = addDays(to, -(length - 1));
    const tz = sql.raw(`'Asia/Bangkok'`);
    const day = sql`((${files.createdAt} AT TIME ZONE ${tz})::date)`;
    const livePhotos = and(
      eq(files.ownerId, ownerId),
      isNull(files.deletedAt),
      inArray(files.status, [...SHOWN_STATUSES]),
      sql`${files.mime} LIKE 'image/%'`,
    );
    const [photoTotal, photoDays, downloadTotal, downloadDays] = await Promise.all([
      this.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(files)
        .where(livePhotos),
      this.db
        .select({ date: sql<string>`${day}::text`, n: sql<number>`count(*)`.mapWith(Number) })
        .from(files)
        .where(
          and(
            livePhotos,
            sql`${files.createdAt} >= (${from}::date::timestamp AT TIME ZONE ${tz})`,
          ),
        )
        .groupBy(day),
      this.db
        .select({ n: sql<number>`coalesce(sum(${dailyStats.downloads}), 0)`.mapWith(Number) })
        .from(dailyStats)
        .where(eq(dailyStats.photographerId, ownerId)),
      this.db
        .select({ date: dailyStats.date, n: dailyStats.downloads })
        .from(dailyStats)
        .where(and(eq(dailyStats.photographerId, ownerId), gte(dailyStats.date, from))),
    ]);
    const photosOn = new Map(photoDays.map((r) => [r.date, r.n]));
    const downloadsOn = new Map(downloadDays.map((r) => [r.date, r.n]));
    const days = Array.from({ length }, (_, i) => {
      const date = addDays(from, i);
      return { date, photos: photosOn.get(date) ?? 0, downloads: downloadsOn.get(date) ?? 0 };
    });
    return {
      from,
      to,
      totals: { photos: photoTotal[0]?.n ?? 0, downloads: downloadTotal[0]?.n ?? 0 },
      period: {
        photos: days.reduce((sum, d) => sum + d.photos, 0),
        downloads: days.reduce((sum, d) => sum + d.downloads, 0),
      },
      days,
    };
  }

  // --- GET /drive/search -----------------------------------------------------------------------

  /**
   * Rate-limited per photographer (DRIVE_COPY_RATE_* reused as the drive's per-user action rate,
   * on its own `drive-search:` counter; a dedicated key is a CONTRACT CHANGE REQUEST). The
   * DRIVE_SEARCH_MAX_RESULTS cap is advisory: it is carried in the cursor's `seen`, which is not
   * signed, so a client could restart the count; each page stays bounded by `limit`, the rate
   * limit bounds the cost, and only the owner's own items are searched.
   */
  async search(ownerId: string, query: SearchQuery): Promise<SearchDriveResponse> {
    const rule = this.config.drive.copyRate;
    const rate = await this.limiter.hit(`drive-search:${ownerId}`, rule.limit, rule.windowSeconds);
    if (!rate.allowed) {
      throw rateLimited(rate.retryAfterSeconds, 'Too many searches; try again later');
    }
    const limit = query.limit ?? this.config.drive.search.pageSize;
    const maxResults = this.config.drive.search.maxResults;
    const withFolders = !searchExcludesFolders(query);
    const cursor = this.searchCursor(query, withFolders);
    const seen = cursor?.seen ?? 0;
    const pageLimit = Math.max(0, Math.min(limit, maxResults - seen));

    let root: Folder | null = null;
    if (query.folderId !== undefined) {
      const [found] = await this.db
        .select()
        .from(folders)
        .where(
          and(
            eq(folders.id, query.folderId),
            eq(folders.ownerId, ownerId),
            query.includeTrashed ? undefined : isNull(folders.deletedAt),
          ),
        );
      if (found === undefined) throw notFound('Folder');
      root = found;
    }
    const pattern = query.q === undefined ? null : driveSearchPattern(query.q);
    const like = (name: typeof folders.name | typeof files.name) =>
      pattern === null ? undefined : sql`${driveNameKeySql(name)} LIKE ${pattern} ESCAPE '\\'`;
    const uploaded = (col: typeof folders.createdAt | typeof files.createdAt) => [
      query.uploadedFrom === undefined ? undefined : gte(col, new Date(query.uploadedFrom)),
      query.uploadedTo === undefined ? undefined : lt(col, new Date(query.uploadedTo)),
    ];

    type Hit = { kind: 'folder'; row: Folder } | { kind: 'file'; row: DriveFileRow };
    const page: Hit[] = [];
    if (pageLimit > 0 && withFolders && (cursor === null || cursor.phase === 'search_folders')) {
      const o = listingOrder(folders, query.sort, query.order, cursor);
      const found = await this.db
        .select()
        .from(folders)
        .where(
          and(
            eq(folders.ownerId, ownerId),
            query.includeTrashed ? undefined : isNull(folders.deletedAt),
            like(folders.name),
            ...uploaded(folders.createdAt),
            root === null
              ? undefined
              : and(sql`${folders.path} <@ ${root.path}::ltree`, ne(folders.id, root.id)),
            o.where,
          ),
        )
        .orderBy(...o.orderBy)
        .limit(pageLimit + 1);
      page.push(...found.map((row) => ({ kind: 'folder' as const, row })));
    }
    if (pageLimit > 0 && page.length <= pageLimit) {
      const o = listingOrder(
        files,
        query.sort,
        query.order,
        cursor?.phase === 'search_files' ? cursor : null,
      );
      const found = await this.db
        .select()
        .from(files)
        .where(
          and(
            eq(files.ownerId, ownerId),
            inArray(files.status, [...SHOWN_STATUSES]),
            isNull(files.purgeRequestedAt),
            query.includeTrashed ? undefined : isNull(files.deletedAt),
            like(files.name),
            query.type === 'any' ? undefined : inArray(files.mime, mimesOf(query.type)),
            query.takenFrom === undefined
              ? undefined
              : gte(files.takenAt, new Date(query.takenFrom)),
            query.takenTo === undefined ? undefined : lt(files.takenAt, new Date(query.takenTo)),
            ...uploaded(files.createdAt),
            root === null ? undefined : fileInSubtree(ownerId, root.path, !query.includeTrashed),
            o.where,
          ),
        )
        .orderBy(...o.orderBy)
        .limit(pageLimit + 1 - page.length);
      page.push(...found.map((row) => ({ kind: 'file' as const, row })));
    }

    const hasMore = page.length > pageLimit;
    const shown = page.slice(0, pageLimit);
    const total = seen + shown.length;
    const truncated = hasMore && total >= maxResults;
    const last = shown.at(-1);
    const nextCursor =
      hasMore && !truncated && last !== undefined
        ? encodeDriveCursor({
            v: 1,
            sort: query.sort,
            order: query.order,
            phase: last.kind === 'folder' ? 'search_folders' : 'search_files',
            key: query.sort === 'name' ? driveNameKey(last.row.name) : null,
            kind: last.kind,
            id: last.row.id,
            seen: total,
          })
        : null;
    const crumbs = await this.breadcrumbs(ownerId, shown);
    const items: SearchResult[] = shown.map((hit, i) => ({
      item: hit.kind === 'folder' ? toDriveFolder(hit.row) : this.mapper.toDriveFile(hit.row),
      ancestors: crumbs[i] ?? [],
    }));
    return { items, nextCursor, truncated };
  }

  private searchCursor(query: SearchQuery, withFolders: boolean): DriveCursor | null {
    if (query.cursor === undefined) return null;
    const cursor = decodeDriveCursor(query.cursor);
    if (
      cursor === null ||
      (cursor.phase !== 'search_folders' && cursor.phase !== 'search_files') ||
      (cursor.phase === 'search_folders' && !withFolders) ||
      cursor.sort !== query.sort ||
      cursor.order !== query.order ||
      (cursor.sort === 'name' && cursor.key === null)
    ) {
      throw validationError(['query', 'cursor'], 'does not belong to this search, sort and order');
    }
    return cursor;
  }

  /**
   * Breadcrumbs of search hits, top-down: a folder's ancestors, or a file's folder with its
   * ancestors. Two queries for the whole page.
   */
  private async breadcrumbs(
    ownerId: string,
    hits: ({ kind: 'folder'; row: Folder } | { kind: 'file'; row: DriveFileRow })[],
  ): Promise<{ id: string; name: string }[][]> {
    const fileFolderIds = [
      ...new Set(
        hits.flatMap((h) => (h.kind === 'file' && h.row.folderId !== null ? [h.row.folderId] : [])),
      ),
    ];
    const parents =
      fileFolderIds.length === 0
        ? []
        : await this.db
            .select({ id: folders.id, path: folders.path })
            .from(folders)
            .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, fileFolderIds)));
    const parentPath = new Map(parents.map((p) => [p.id, p.path]));
    const chains = hits.map((h) => {
      if (h.kind === 'folder') return pathFolderIds(h.row.path).slice(0, -1);
      const path = h.row.folderId === null ? undefined : parentPath.get(h.row.folderId);
      return path === undefined ? [] : pathFolderIds(path);
    });
    const ids = [...new Set(chains.flat())];
    const named =
      ids.length === 0
        ? []
        : await this.db
            .select({ id: folders.id, name: folders.name })
            .from(folders)
            .where(and(eq(folders.ownerId, ownerId), inArray(folders.id, ids)));
    const byId = new Map(named.map((f) => [f.id, f]));
    return chains.map((chain) =>
      chain.flatMap((id) => {
        const f = byId.get(id);
        return f === undefined ? [] : [{ id: f.id, name: f.name }];
      }),
    );
  }

  // --- GET /drive/files/:id, GET /drive/folders/:id/summary ------------------------------------

  async getFile(ownerId: string, id: string): Promise<GetFileResponse> {
    const [file] = await this.db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.ownerId, ownerId), isNull(files.purgeRequestedAt)));
    if (file === undefined) throw notFound('File');
    let ancestors: { id: string; name: string }[] = [];
    if (file.folderId !== null) {
      const [folder] = await this.db
        .select()
        .from(folders)
        .where(and(eq(folders.id, file.folderId), eq(folders.ownerId, ownerId)));
      if (folder !== undefined) {
        ancestors = [
          ...(await ancestorsOf(this.db, ownerId, folder)),
          { id: folder.id, name: folder.name },
        ];
      }
    }
    return { file: this.mapper.toDriveFile(file), ancestors };
  }

  async folderSummary(ownerId: string, id: string): Promise<FolderSummaryResponse> {
    const folder = await liveFolder(this.db, ownerId, id);
    if (folder === null) throw notFound('Folder');
    const images = mimesOf('image');
    const videos = mimesOf('video');
    const [counts] = await this.db
      .select({
        fileCount: sql<number>`count(*)`.mapWith(Number),
        imageCount: sql<number>`count(*) FILTER (WHERE ${inArray(files.mime, images)})`.mapWith(
          Number,
        ),
        videoCount: sql<number>`count(*) FILTER (WHERE ${inArray(files.mime, videos)})`.mapWith(
          Number,
        ),
        totalBytes: sql<number>`coalesce(sum(${files.sizeBytes}), 0)`.mapWith(Number),
      })
      .from(files)
      .where(
        and(
          eq(files.ownerId, ownerId),
          isNull(files.deletedAt),
          inArray(files.status, [...SHOWN_STATUSES]),
          fileInSubtree(ownerId, folder.path, true),
        ),
      );
    const [sub] = await this.db
      .select({ folderCount: sql<number>`count(*)`.mapWith(Number) })
      .from(folders)
      .where(
        and(
          eq(folders.ownerId, ownerId),
          isNull(folders.deletedAt),
          sql`${folders.path} <@ ${folder.path}::ltree`,
          ne(folders.id, folder.id),
        ),
      );
    return {
      folder: toDriveFolder(folder),
      ancestors: await ancestorsOf(this.db, ownerId, folder),
      fileCount: counts?.fileCount ?? 0,
      imageCount: counts?.imageCount ?? 0,
      videoCount: counts?.videoCount ?? 0,
      folderCount: sub?.folderCount ?? 0,
      totalBytes: counts?.totalBytes ?? 0,
    };
  }
}
