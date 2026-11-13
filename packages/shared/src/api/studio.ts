import { z } from 'zod';
import { DRIVE_PAGE_SIZE_LIMIT, DRIVE_SEARCH_QUERY_MAX_LENGTH } from '../config/drive';
import { DOWNLOAD_SIZES } from '../domain';
import { DRIVE_CURSOR_MAX_LENGTH, DRIVE_SORTS, SORT_ORDERS } from '../drive/cursor';
import { driveNameSchema } from '../drive/names';
import { MEDIA_KINDS } from '../media-types';
import { byteCountSchema, idSchema, isoDateTimeSchema } from './common';
import { driveFileSchema, driveFolderSchema, driveItemSchema, folderAncestorSchema } from './drive';
import { zipJobViewSchema } from './share-page';
import { bangkokDateSchema } from './shares';
import { UPLOAD_NAME_CONFLICT_MODES } from './uploads';

// Drive-style studio (Wave 7): copy, folder zip for the owner, recent, search and item info. Every
// route is the photographer's own drive: rows are filtered by `owner_id` = the caller (another
// owner's ids are NOT_FOUND), file bytes never pass through the API, and media is served by signed
// URLs only.

const limitSchema = z.coerce.number().int().min(1).max(DRIVE_PAGE_SIZE_LIMIT).optional();
const cursorSchema = z.string().min(1).max(DRIVE_CURSOR_MAX_LENGTH).optional();

// --- POST /drive/files/:id/copy ----------------------------------------------------------------

/**
 * "ทำสำเนา": copy one file (folders are out of scope in v1) into `targetFolderId` (null: the drive
 * root). The source must be the caller's, live (not trashed) and `ready`, else NOT_FOUND / CONFLICT;
 * the target folder must be live, else NOT_FOUND.
 *
 * - Name: `name` (it must keep an extension of the file's type, renameKeepsFileType:
 *   UNSUPPORTED_FILE_TYPE otherwise), else the source's name. Taken among the target's live
 *   children: `rename` (default) picks `stem (2).ext`, `stem (3).ext`, … (availableDriveName, the
 *   upload rule); `fail` answers NAME_TAKEN.
 * - Quota and gate, in one transaction with the insert: the subscription's upload gate
 *   (uploadsBlockedBy: SUBSCRIPTION_INACTIVE) and `used + reserved + size <= quota`
 *   (QUOTA_EXCEEDED with QuotaExceededDetails); `size_bytes` is reserved as for an upload init.
 * - The new row is `processing` with a new `originals/` key (originalKey), the source's metadata
 *   (mime, size, sha256, width, height, taken_at, web_size_bytes, and `faces_withheld_at`: a photo
 *   withheld from face search stays withheld in its copies), no derivative keys,
 *   `copied_from_file_id` = the source and `media_queued_at = now()`; after commit the API sends the
 *   `file.copy` media message (an enqueue failure doesn't fail the request: media.sweep re-sends).
 *   The worker copies the objects server-side and makes the copy `ready` (fileCopyMessageSchema).
 *   Faces are not copied: the copy is indexed through the normal path when a face index covers it.
 * - `clientCopyId`: the client's random id for this copy (stored in `files.client_upload_id`): the
 *   same id again returns the same copy; with another source or target: IDEMPOTENCY_KEY_REUSED.
 * - DRIVE_COPY_RATE_PER_USER per DRIVE_COPY_RATE_WINDOW_SECONDS: RATE_LIMITED.
 *
 * 201 with the copy as it now is (`processing`, no signed URLs yet).
 */
export const copyFileBodySchema = z.strictObject({
  targetFolderId: idSchema.nullable(),
  name: driveNameSchema.optional(),
  onNameConflict: z.enum(UPLOAD_NAME_CONFLICT_MODES).default('rename'),
  clientCopyId: idSchema.optional(),
});
export type CopyFileBody = z.input<typeof copyFileBodySchema>;

export const copyFileResponseSchema = driveFileSchema;
export type CopyFileResponse = z.output<typeof copyFileResponseSchema>;

// --- POST /drive/folders/:id/download, GET /drive/zip-jobs/:id ---------------------------------

/**
 * The owner downloads a live folder as a ZIP, in any subscription status (like the single-file
 * owner download). The zip pipeline of share downloads is reused: a `zip_jobs` row with
 * `share_id` null (an owner job, migration 0008: `viewer_id` = the photographer,
 * `archive_name` = the folder's name + `.zip`, `source_folder_id` = the folder) and one
 * `zip_job_entries` row per `ready`, non-trashed file of the subtree, inserted in one
 * transaction, then the `zip.create` message.
 *
 * - Entry names keep the folder structure below the zipped folder (`Day 1/IMG_0001.jpg`), each
 *   segment sanitized and the paths made unique with uniqueZipEntryPaths. Empty folders are not
 *   in the archive.
 * - `size`: `original` (default) zips `files.s3_key`; `web` zips each file's `web_key`.
 * - ZIP_MAX_FILES and ZIP_MAX_BYTES as for shares (ZIP_TOO_LARGE); no ready file in the subtree:
 *   CONFLICT; DRIVE_ZIP_MAX_ACTIVE_JOBS queued or running owner jobs already: RATE_LIMITED.
 * - `Idempotency-Key` (optional): the same key for the same folder and size returns the existing
 *   job; with another folder or size: IDEMPOTENCY_KEY_REUSED (unique per photographer for owner
 *   jobs).
 *
 * 202 with the job; poll `GET /drive/zip-jobs/:id`. The first poll that issues the archive's URL
 * writes one `zip` activity event with source `owner` (no share, no viewer), as owner downloads do.
 */
export const downloadFolderBodySchema = z.strictObject({
  size: z.enum(DOWNLOAD_SIZES).default('original'),
});
export type DownloadFolderBody = z.input<typeof downloadFolderBodySchema>;

export const downloadFolderResponseSchema = z.object({ job: zipJobViewSchema });
export type DownloadFolderResponse = z.output<typeof downloadFolderResponseSchema>;

/**
 * An owner zip job of the caller (`share_id IS NULL AND photographer_id` = the caller); share
 * jobs and other photographers' jobs are NOT_FOUND. Same view as the share route; the archive's
 * download name is `archive_name`.
 */
export const ownerZipJobResponseSchema = zipJobViewSchema;
export type OwnerZipJobResponse = z.output<typeof ownerZipJobResponseSchema>;

// --- GET /drive/recent -------------------------------------------------------------------------

/**
 * "ล่าสุด": the caller's live files newest first (ORDER BY id DESC: ids are uuidv7, so creation
 * order; cursors of phase `recent`). Only `processing` and `ready` files (not uploads in progress,
 * not failed ones). `limit` defaults to DRIVE_RECENT_PAGE_SIZE. Items carry signed thumb/preview/
 * poster URLs like children listings.
 */
export const listRecentQuerySchema = z.object({ cursor: cursorSchema, limit: limitSchema });
export type ListRecentQuery = z.input<typeof listRecentQuerySchema>;

export const listRecentResponseSchema = z.object({
  items: z.array(driveFileSchema),
  nextCursor: z.string().nullable(),
});
export type ListRecentResponse = z.output<typeof listRecentResponseSchema>;

// --- GET /drive/stats --------------------------------------------------------------------------

/** Days a studio stats chart can cover (ADR 0023). */
export const DRIVE_STATS_DAYS = [7, 30, 90] as const;
export const DRIVE_STATS_DEFAULT_DAYS = 30;

/**
 * ADR 0023: the photographer's own numbers on the Events page (studio.drive). `days` (7, 30 or 90; default
 * DRIVE_STATS_DEFAULT_DAYS) Bangkok calendar days ending today.
 */
export const driveStatsQuerySchema = z.object({
  days: z.coerce
    .number()
    .int()
    .refine((d) => (DRIVE_STATS_DAYS as readonly number[]).includes(d), {
      error: 'days must be 7, 30 or 90',
    })
    .optional(),
});
export type DriveStatsQuery = z.input<typeof driveStatsQuerySchema>;

const statCount = z.number().int().nonnegative();

/**
 * - `photos`: the caller's live (not trashed) image files that are `processing` or `ready`
 *   (copies included), counted from `files`; per day by the Bangkok day of `created_at`.
 * - `downloads`: share-page single-photo downloads (`daily_stats.downloads`).
 * - `visitors` (ADR 0024): people who opened a share page (`daily_stats.visitors`; a person
 *   counts once per day).
 * Downloads and visitors come from the hourly rollup of activity_events (they lag by up to about
 * an hour), never from raw events.
 */
const driveStatsValuesSchema = z.object({
  photos: statCount,
  downloads: statCount,
  visitors: statCount,
});

export const driveStatsResponseSchema = z.object({
  from: bangkokDateSchema,
  to: bangkokDateSchema,
  /** All time: photos in the drive now, downloads and visitors ever. */
  totals: driveStatsValuesSchema,
  /** Within from..to. */
  period: driveStatsValuesSchema,
  /** The same number of days just before `from` (ADR 0024: the change shown on each tile). */
  previous: driveStatsValuesSchema,
  /** Every day of from..to, ascending, zeros included. */
  days: z.array(driveStatsValuesSchema.extend({ date: bangkokDateSchema })),
});
export type DriveStatsResponse = z.output<typeof driveStatsResponseSchema>;

// --- GET /drive/search -------------------------------------------------------------------------

/** `type` of a search: one media kind, or both. */
export const DRIVE_SEARCH_TYPES = ['any', ...MEDIA_KINDS] as const;
export type DriveSearchType = (typeof DRIVE_SEARCH_TYPES)[number];

const searchText = z
  .string()
  .transform((q) => q.normalize('NFC').trim())
  .pipe(z.string().min(1).max(DRIVE_SEARCH_QUERY_MAX_LENGTH));

/**
 * Search the caller's drive (drive/search for the SQL). Every criterion narrows; at least one of
 * `q`, `type` other than `any`, a date bound or `folderId` is required.
 *
 * - `q`: the name contains it, ignoring ASCII case (driveSearchPattern); Thai works as typed.
 * - `type`: `image` or `video` (files only).
 * - `takenFrom` / `takenTo`: files whose `taken_at` is in [from, to) (files without a date are
 *   excluded).
 * - `uploadedFrom` / `uploadedTo`: items whose `created_at` is in [from, to).
 * - `folderId`: only below that folder (`path <@` its path; the folder itself is not a result);
 *   unknown or another owner's: NOT_FOUND.
 * - `includeTrashed` (default false): also items in the trash.
 *
 * Folders are results only when no file-only criterion (`type` other than `any`, `takenFrom`,
 * `takenTo`) is set. Folders come before files, each in `sort`/`order` (as children listings;
 * cursors of phases `search_folders` and `search_files`). Files that are `uploading` or `failed`
 * are never results. At most DRIVE_SEARCH_MAX_RESULTS items over all pages: the page that reaches
 * the cap has `truncated: true` and no next cursor.
 */
export const searchDriveQuerySchema = z
  .object({
    q: searchText.optional(),
    type: z.enum(DRIVE_SEARCH_TYPES).default('any'),
    takenFrom: isoDateTimeSchema.optional(),
    takenTo: isoDateTimeSchema.optional(),
    uploadedFrom: isoDateTimeSchema.optional(),
    uploadedTo: isoDateTimeSchema.optional(),
    folderId: idSchema.optional(),
    includeTrashed: z.stringbool().default(false),
    sort: z.enum(DRIVE_SORTS).default('name'),
    order: z.enum(SORT_ORDERS).default('asc'),
    cursor: cursorSchema,
    limit: limitSchema,
  })
  .refine(
    (q) =>
      q.q !== undefined ||
      q.type !== 'any' ||
      q.takenFrom !== undefined ||
      q.takenTo !== undefined ||
      q.uploadedFrom !== undefined ||
      q.uploadedTo !== undefined ||
      q.folderId !== undefined,
    { error: 'at least one search criterion is required' },
  )
  .refine((q) => !(q.takenFrom && q.takenTo) || Date.parse(q.takenFrom) < Date.parse(q.takenTo), {
    error: 'takenFrom must be before takenTo',
    path: ['takenTo'],
  })
  .refine(
    (q) =>
      !(q.uploadedFrom && q.uploadedTo) || Date.parse(q.uploadedFrom) < Date.parse(q.uploadedTo),
    { error: 'uploadedFrom must be before uploadedTo', path: ['uploadedTo'] },
  );
export type SearchDriveQuery = z.input<typeof searchDriveQuerySchema>;

/** True when the query has a criterion folders can't meet (they have no type or date taken). */
export function searchExcludesFolders(query: z.output<typeof searchDriveQuerySchema>): boolean {
  return query.type !== 'any' || query.takenFrom !== undefined || query.takenTo !== undefined;
}

/** A search result: the item and where it is (breadcrumbs from the top down to its parent). */
export const searchResultSchema = z.object({
  item: driveItemSchema,
  ancestors: z.array(folderAncestorSchema),
});
export type SearchResult = z.output<typeof searchResultSchema>;

export const searchDriveResponseSchema = z.object({
  items: z.array(searchResultSchema),
  nextCursor: z.string().nullable(),
  /** True when DRIVE_SEARCH_MAX_RESULTS stopped the search: ask for a narrower one. */
  truncated: z.boolean(),
});
export type SearchDriveResponse = z.output<typeof searchDriveResponseSchema>;

// --- GET /drive/files/:id, GET /drive/folders/:id/summary --------------------------------------

/**
 * "ข้อมูลไฟล์" of a file: the file (trashed ones too) and its location, breadcrumbs from the
 * top-level folder down to the file's own folder (empty at the drive root).
 */
export const getFileResponseSchema = z.object({
  file: driveFileSchema,
  ancestors: z.array(folderAncestorSchema),
});
export type GetFileResponse = z.output<typeof getFileResponseSchema>;

/**
 * "ข้อมูลไฟล์" of a live folder (trashed: NOT_FOUND), over its live subtree (`path <@`, not
 * trashed): files that are `processing` or `ready`, and folders below it (not itself).
 * `totalBytes` sums the originals (`size_bytes`). `ancestors` runs from the top-level folder down
 * to the folder's parent.
 */
export const folderSummaryResponseSchema = z.object({
  folder: driveFolderSchema,
  ancestors: z.array(folderAncestorSchema),
  fileCount: z.number().int().nonnegative(),
  imageCount: z.number().int().nonnegative(),
  videoCount: z.number().int().nonnegative(),
  folderCount: z.number().int().nonnegative(),
  totalBytes: byteCountSchema,
});
export type FolderSummaryResponse = z.output<typeof folderSummaryResponseSchema>;
