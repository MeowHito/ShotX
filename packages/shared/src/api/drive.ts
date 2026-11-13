import { z } from 'zod';
import { DRIVE_ITEMS_BATCH_MAX, DRIVE_PAGE_SIZE_LIMIT } from '../config/drive';
import { DOWNLOAD_SIZES, FILE_STATUSES, SHARE_STATUSES, SUBSCRIPTION_STATUSES } from '../domain';
import { DRIVE_CURSOR_MAX_LENGTH, DRIVE_SORTS, SORT_ORDERS } from '../drive/cursor';
import { driveNameSchema } from '../drive/names';
import { MEDIA_KINDS } from '../media-types';
import { byteCountSchema, idSchema, isoDateTimeSchema, signedUrlSchema } from './common';

/**
 * The drive root is not a folder row. In JSON it is `null` (`parentId: null`, `folderId: null`,
 * as in the database); in a URL path, where null can't be written, it is the literal `root`:
 * `GET /api/drive/folders/root/children`. Nothing else accepts `root`.
 */
export const DRIVE_ROOT = 'root';

/** `:id` of `GET /drive/folders/:id/children`: a folder id or {@link DRIVE_ROOT}. */
export const folderRefSchema = z.union([z.literal(DRIVE_ROOT), idSchema]);
export type FolderRef = z.output<typeof folderRefSchema>;

/** The folder id a {@link FolderRef} names: null for the root. */
export function folderIdFromRef(ref: FolderRef): string | null {
  return ref === DRIVE_ROOT ? null : ref;
}

/** The path segment for a folder id: `root` for null. */
export function folderRefFromId(folderId: string | null): FolderRef {
  return folderId ?? DRIVE_ROOT;
}

export const DRIVE_ITEM_KINDS = ['folder', 'file'] as const;
export type DriveItemKind = (typeof DRIVE_ITEM_KINDS)[number];

export const driveItemRefSchema = z.object({ kind: z.enum(DRIVE_ITEM_KINDS), id: idSchema });
export type DriveItemRef = z.output<typeof driveItemRefSchema>;

export const driveFolderSchema = z.object({
  kind: z.literal('folder'),
  id: idSchema,
  /** null at the drive root. */
  parentId: idSchema.nullable(),
  name: z.string(),
  createdAt: isoDateTimeSchema,
  /** null unless the folder is in the trash (directly or through a trashed ancestor). */
  deletedAt: isoDateTimeSchema.nullable(),
  /**
   * This folder's own face-index switch. Indexing covers the folder's whole subtree while the
   * switch is on and `faceIndexExpiresAt` is in the future (see isCoveredByFaceIndex). ADR 0011:
   * on for every new folder (with an expiry of creation + FACE_INDEX_EXPIRY_DAYS); migration 0012
   * switched existing folders on.
   */
  faceIndexEnabled: z.boolean(),
  faceIndexExpiresAt: isoDateTimeSchema.nullable(),
  /**
   * The photographer's chosen cover photo (ADR 0011), or null for the default (the first ready
   * image of the share scope). Not re-checked here: the share page falls back to the default when
   * the file is no longer a live, ready image inside the folder's subtree.
   */
  coverFileId: idSchema.nullable(),
  /**
   * The folder as an event (ADR 0016: every folder is an "Event" in the studio). Only in
   * `GET /drive/folders/:id/children`; absent from other responses.
   */
  event: z
    .object({
      /**
       * Signed thumb.webp URL of the cover: the chosen cover while it is a live, ready image in
       * the folder's subtree, else its first ready image (share-page order). Null: no image yet.
       */
      coverThumbUrl: signedUrlSchema.nullable(),
      /** The newest share of the folder that isn't revoked; null when there is none. */
      link: z
        .object({
          shareId: idSchema,
          /** `active` (published), `paused` (unpublished), `expired`. Never `revoked`. */
          status: z.enum(SHARE_STATUSES),
          path: z.string().startsWith('/'),
          url: z.url(),
        })
        .nullable(),
    })
    .optional(),
});
export type DriveFolder = z.output<typeof driveFolderSchema>;

export const driveFileSchema = z.object({
  kind: z.literal('file'),
  id: idSchema,
  /** null at the drive root. */
  folderId: idSchema.nullable(),
  /** Display name; downloads use it for Content-Disposition. */
  name: z.string(),
  mime: z.string(),
  mediaKind: z.enum(MEDIA_KINDS),
  sizeBytes: byteCountSchema,
  /**
   * `uploading` until the client completes the upload, `processing` until the worker has written
   * the derivatives, then `ready`; `failed` when the bytes were rejected.
   */
  status: z.enum(FILE_STATUSES),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  takenAt: isoDateTimeSchema.nullable(),
  /** Distinct faces; null until indexed, or after the face index expired. */
  faceCount: z.number().int().nonnegative().nullable(),
  createdAt: isoDateTimeSchema,
  deletedAt: isoDateTimeSchema.nullable(),
  /** Signed URL of thumb.webp, set by the API once the derivative exists (images and videos). */
  thumbUrl: signedUrlSchema.optional(),
  /** Signed URL of preview.webp (images) or preview.mp4 (videos). */
  previewUrl: signedUrlSchema.optional(),
  /** Signed URL of poster.jpg (videos). */
  posterUrl: signedUrlSchema.optional(),
});
export type DriveFile = z.output<typeof driveFileSchema>;

export const driveItemSchema = z.discriminatedUnion('kind', [driveFolderSchema, driveFileSchema]);
export type DriveItem = z.output<typeof driveItemSchema>;

// --- GET /drive/folders/:id/children ------------------------------------------------------

export const listChildrenParamsSchema = z.object({ id: folderRefSchema });

const limitSchema = z.coerce.number().int().min(1).max(DRIVE_PAGE_SIZE_LIMIT).optional();
const cursorSchema = z.string().min(1).max(DRIVE_CURSOR_MAX_LENGTH).optional();

/**
 * Query of a children listing. `limit` defaults to DRIVE_PAGE_SIZE (config, ~100); folders come
 * before files whatever the sort (see drive/cursor).
 */
export const listChildrenQuerySchema = z.object({
  cursor: cursorSchema,
  limit: limitSchema,
  sort: z.enum(DRIVE_SORTS).default('name'),
  order: z.enum(SORT_ORDERS).default('asc'),
});
export type ListChildrenQuery = z.input<typeof listChildrenQuerySchema>;

export const folderAncestorSchema = z.object({ id: idSchema, name: z.string() });

export const listChildrenResponseSchema = z.object({
  /** The listed folder; null for the root. */
  folder: driveFolderSchema.nullable(),
  /** Breadcrumbs from the top-level folder down to the listed folder's parent. Empty at the root. */
  ancestors: z.array(folderAncestorSchema),
  items: z.array(driveItemSchema),
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: z.string().nullable(),
});
export type ListChildrenResponse = z.output<typeof listChildrenResponseSchema>;

// --- POST /drive/folders, PATCH /drive/folders/:id, PATCH /drive/files/:id ----------------

export const createFolderBodySchema = z.object({
  /** null creates the folder at the drive root. */
  parentId: idSchema.nullable(),
  name: driveNameSchema,
});
export type CreateFolderBody = z.input<typeof createFolderBodySchema>;

const atLeastOne = (keys: readonly string[]) => (value: Record<string, unknown>) =>
  keys.some((key) => value[key] !== undefined);

/**
 * Rename and/or move a folder, and/or set its cover. `parentId: null` moves it to the root; an
 * absent `parentId` leaves it where it is. Moving rewrites the ltree path of the whole subtree in
 * one transaction.
 *
 * `coverFileId` (ADR 0011): a file id sets the share page cover, `null` returns to the default
 * (the first ready image). The file must be the caller's (else NOT_FOUND, like any other id) and,
 * checked by the API in the same transaction, live, `ready`, an image and inside this folder's
 * subtree (its folder's path `<@` this folder's path), else COVER_FILE_INVALID with the reason.
 * The database enforces only the same owner (`folders_cover_file_same_owner_fk`) and clears the
 * column when the file row is purged (ON DELETE SET NULL). Later moves or trashing of the file are
 * handled at read time (share meta falls back to the default); the API need not clear the column.
 */
export const updateFolderBodySchema = z
  .object({
    name: driveNameSchema.optional(),
    parentId: idSchema.nullable().optional(),
    coverFileId: idSchema.nullable().optional(),
  })
  .refine(atLeastOne(['name', 'parentId', 'coverFileId']), {
    error: 'name, parentId or coverFileId is required',
  });
export type UpdateFolderBody = z.input<typeof updateFolderBodySchema>;

/**
 * Rename and/or move a file. The new name must keep an extension of the file's type
 * (renameKeepsFileType). `folderId: null` moves it to the root.
 */
export const updateFileBodySchema = z
  .object({ name: driveNameSchema.optional(), folderId: idSchema.nullable().optional() })
  .refine(atLeastOne(['name', 'folderId']), { error: 'name or folderId is required' });
export type UpdateFileBody = z.input<typeof updateFileBodySchema>;

// --- POST /drive/items/trash, POST /drive/items/restore -----------------------------------

/** 1 to DRIVE_ITEMS_BATCH_MAX distinct items of the caller. */
export const driveItemsBodySchema = z.object({
  items: z
    .array(driveItemRefSchema)
    .min(1)
    .max(DRIVE_ITEMS_BATCH_MAX)
    .refine((items) => new Set(items.map((i) => `${i.kind}:${i.id}`)).size === items.length, {
      error: 'items must be distinct',
    }),
});
export type DriveItemsBody = z.input<typeof driveItemsBodySchema>;

/**
 * Trash moves the items, and everything inside trashed folders, to the trash in one transaction
 * (all or nothing: any unknown id is NOT_FOUND). Items already in the trash are left as they are.
 * Trashed files still count toward quota until purged.
 */
export const trashItemsResponseSchema = z.object({
  items: z.array(driveItemRefSchema.extend({ deletedAt: isoDateTimeSchema })),
});
export type TrashItemsResponse = z.output<typeof trashItemsResponseSchema>;

/**
 * Restore takes items listed by `GET /drive/trash` (things inside a trashed folder come back with
 * it and can't be restored on their own: NOT_FOUND). Each returns to its old parent, or to the
 * root when that parent is no longer live. A name now taken there gets ` (2)`, ` (3)`, … (see
 * availableDriveName). The response has the restored items as they now are.
 */
export const restoreItemsResponseSchema = z.object({ items: z.array(driveItemSchema) });
export type RestoreItemsResponse = z.output<typeof restoreItemsResponseSchema>;

// --- GET /drive/trash, DELETE /drive/trash ------------------------------------------------

export const listTrashQuerySchema = z.object({ cursor: cursorSchema, limit: limitSchema });
export type ListTrashQuery = z.input<typeof listTrashQuerySchema>;

const purgeAt = {
  deletedAt: isoDateTimeSchema,
  /** When the trash purge will delete it: deletedAt + TRASH_RETENTION_DAYS. */
  purgeAt: isoDateTimeSchema,
};

export const trashItemSchema = z.discriminatedUnion('kind', [
  driveFolderSchema.extend(purgeAt),
  driveFileSchema.extend(purgeAt),
]);
export type TrashItem = z.output<typeof trashItemSchema>;

/** The items the caller trashed (not what is inside them), newest first. */
export const listTrashResponseSchema = z.object({
  items: z.array(trashItemSchema),
  nextCursor: z.string().nullable(),
});
export type ListTrashResponse = z.output<typeof listTrashResponseSchema>;

/**
 * Empty trash (202). Everything in the trash is marked for purge and disappears from the trash
 * at once, and its bytes leave the quota in the same transaction; the worker deletes the S3
 * objects and faces afterwards.
 */
export const emptyTrashResponseSchema = z.object({
  folders: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
  /** Bytes of originals released from the quota. */
  bytes: byteCountSchema,
});
export type EmptyTrashResponse = z.output<typeof emptyTrashResponseSchema>;

// --- GET /drive/usage ---------------------------------------------------------------------

/** The storage meter in the studio. Quota counts originals, trash included. */
export const driveUsageResponseSchema = z.object({
  usedBytes: byteCountSchema,
  /** Uploads in progress (reserved at init, not yet verified by the worker). */
  reservedBytes: byteCountSchema,
  /**
   * The live subscription's plan quota; 0 without a live subscription. Null while
   * STORAGE_QUOTA_ENFORCED is false (ADR 0010: no storage limit; show the used bytes only).
   */
  quotaBytes: byteCountSchema.nullable(),
  /** max(0, quota - used - reserved); null when quotaBytes is null. */
  availableBytes: byteCountSchema.nullable(),
  /** Part of usedBytes + reservedBytes that is in the trash. */
  trashBytes: byteCountSchema,
  subscription: z
    .object({
      status: z.enum(SUBSCRIPTION_STATUSES),
      planCode: z.string(),
      periodEnd: isoDateTimeSchema,
    })
    .nullable(),
  /**
   * Why uploads are blocked right now (uploadsBlockedBy), or null. Always null while
   * BILLING_MODE=offline and STORAGE_QUOTA_ENFORCED=false (ADR 0010).
   */
  uploadsBlockedBy: z.enum(['SUBSCRIPTION_INACTIVE', 'QUOTA_EXCEEDED']).nullable(),
});
export type DriveUsageResponse = z.output<typeof driveUsageResponseSchema>;

// --- PATCH /drive/folders/:id/face-index ---------------------------------------------------

/**
 * Extend face indexing of a folder subtree (or turn it back on), or turn it off.
 *
 * ADR 0011 decision 1 (owner, risk accepted): face indexing is always on. Every folder is created
 * with it on and every upload into a folder is indexed; the photographer no longer enables it or
 * confirms that attendees were informed. This route remains for extending the expiry.
 *
 * - `enabled: true` sets `face_index_enabled` and
 *   `face_index_expires_at = max(current, now + FACE_INDEX_EXPIRY_DAYS)`, so calling it again
 *   extends the index. No confirmation is needed any more: `attendeesInformedConfirmed` is
 *   accepted for older clients and ignored, and `face_index_informed_at` is no longer written. If
 *   the folder had no active index, the API sends `index.folder`.
 *   FEATURE_DISABLED while FACE_SEARCH_ENABLED is false; SUBSCRIPTION_INACTIVE unless the
 *   subscription is trial, active or grace (BILLING_MODE=gateway only).
 * - `enabled: false` clears the switch and the expiry and sends `unindex.folder`, which deletes the
 *   faces of files no longer covered by another active folder. Always allowed (kept as the
 *   photographer's opt-out; whether the studio still shows it is a product decision).
 *
 * The response is the folder as it now is. Every upload into a folder whose switch is on renews
 * the expiry of its enabled covering folders (the folder and its ancestors) to at least last
 * upload + FACE_INDEX_EXPIRY_DAYS, also when that expiry had already passed (ADR 0011: "every
 * folder is indexed on upload"; the worker does it before it decides whether to index).
 */
export const updateFaceIndexBodySchema = z.discriminatedUnion('enabled', [
  z.strictObject({
    enabled: z.literal(true),
    /** Deprecated (ADR 0011): ignored; accepted so clients from before it keep working. */
    attendeesInformedConfirmed: z.literal(true).optional(),
  }),
  z.strictObject({ enabled: z.literal(false) }),
]);
export type UpdateFaceIndexBody = z.input<typeof updateFaceIndexBodySchema>;

// --- GET /drive/files/:id/download -----------------------------------------------------------

/**
 * A photographer's download of their own file, allowed in any subscription status (spec: an
 * expired photographer can still download their files). `size` defaults to `original`; `web`
 * serves web.jpg (images) or preview.mp4 (videos), CONFLICT until the file is `ready`. Trashed
 * files can be downloaded too. Logs an `owner` download activity event.
 */
export const ownerDownloadQuerySchema = z.object({
  size: z.enum(DOWNLOAD_SIZES).default('original'),
});
export type OwnerDownloadQuery = z.input<typeof ownerDownloadQuerySchema>;

/** A signed download URL with `Content-Disposition: attachment` and the file's name. */
export const signedDownloadSchema = z.object({
  fileId: idSchema,
  url: signedUrlSchema,
  /** The name the browser saves (Content-Disposition). */
  fileName: z.string().min(1),
  expiresAt: isoDateTimeSchema,
});
export type SignedDownload = z.output<typeof signedDownloadSchema>;
