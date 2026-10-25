import { S3_MULTIPART_MAX_PART_BYTES, S3_MULTIPART_MIN_PART_BYTES } from '@shotx/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, driveNameKeySql, id, ltree, parentKeySql, timestamptz } from './columns';
import { fileStatus } from './enums';

const minPart = sql.raw(String(S3_MULTIPART_MIN_PART_BYTES));
const maxPart = sql.raw(String(S3_MULTIPART_MAX_PART_BYTES));

/**
 * Drive folders. `path` is the ltree of folder ids from the root down to this folder, each label
 * the id with `-` replaced by `_` (see src/ltree.ts); share scope checks use `path <@ root`.
 * Moving a folder rewrites the subtree's prefix in one transaction.
 *
 * Parents must belong to the same owner: the foreign key is on (parent_id, owner_id).
 *
 * Names: unique among live siblings ignoring ASCII case (`folders_live_name_unique`, see
 * driveNameSchema in @shotx/shared); the drive root is parent key nil.
 *
 * Trash: trashing a folder sets `deleted_at` on it and, with the same timestamp, on every live
 * folder and file below it, which also get `trashed_via_folder_id` = the trashed folder. Rows with
 * `deleted_at` set and no `trashed_via_folder_id` are what the user trashed: the trash listing,
 * restore and the 30-day purge work on those and take their `trashed_via` rows along. Emptying the
 * trash (or the purge) sets `purge_requested_at`; the worker then deletes the objects and rows.
 */
export const folders = pgTable(
  'folders',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    path: ltree('path').notNull(),
    /**
     * This folder's own switch; indexing covers the whole subtree while it is on and
     * `face_index_expires_at` is in the future (isCoveredByFaceIndex in @shotx/shared).
     */
    faceIndexEnabled: boolean('face_index_enabled').notNull().default(false),
    faceIndexExpiresAt: timestamptz('face_index_expires_at'),
    /**
     * When the photographer last confirmed that attendees were informed (PDPA checklist), which
     * enabling face indexing requires. Kept when indexing is turned off, as a record.
     */
    faceIndexInformedAt: timestamptz('face_index_informed_at'),
    deletedAt: timestamptz('deleted_at'),
    /** The trashed ancestor that took this folder to the trash; null if trashed directly. */
    trashedViaFolderId: uuid('trashed_via_folder_id'),
    /** Set when the trash was emptied or the trash purge picked the folder up. */
    purgeRequestedAt: timestamptz('purge_requested_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('folders_id_owner_unique').on(t.id, t.ownerId),
    uniqueIndex('folders_live_name_unique')
      .on(t.ownerId, parentKeySql(t.parentId), driveNameKeySql(t.name))
      .where(sql`${t.deletedAt} IS NULL`),
    // Children listings: ORDER BY name key or id, live rows only.
    index('folders_children_name_idx')
      .on(t.ownerId, t.parentId, driveNameKeySql(t.name), t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index('folders_children_id_idx')
      .on(t.ownerId, t.parentId, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    // The trash listing: what the owner trashed directly and hasn't emptied.
    index('folders_trash_idx')
      .on(t.ownerId, t.deletedAt, t.id)
      .where(
        sql`${t.deletedAt} IS NOT NULL AND ${t.trashedViaFolderId} IS NULL AND ${t.purgeRequestedAt} IS NULL`,
      ),
    index('folders_trashed_via_idx')
      .on(t.trashedViaFolderId)
      .where(sql`${t.trashedViaFolderId} IS NOT NULL`),
    index('folders_trashed_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    index('folders_purge_requested_idx')
      .on(t.purgeRequestedAt)
      .where(sql`${t.purgeRequestedAt} IS NOT NULL`),
    foreignKey({
      name: 'folders_parent_same_owner_fk',
      columns: [t.parentId, t.ownerId],
      foreignColumns: [t.id, t.ownerId],
    }),
    index('folders_path_gist').using('gist', t.path),
    index('folders_parent_owner_idx').on(t.parentId, t.ownerId),
    index('folders_owner_idx').on(t.ownerId),
    index('folders_face_index_expiry_idx')
      .on(t.faceIndexExpiresAt)
      .where(sql`${t.faceIndexEnabled}`),
    // Coverage lookups: the owner's folders with indexing on (then path @> / <@ via the GiST index).
    index('folders_face_index_owner_idx')
      .on(t.ownerId)
      .where(sql`${t.faceIndexEnabled}`),
    check(
      'folders_face_index_needs_confirmation',
      sql`NOT ${t.faceIndexEnabled} OR (${t.faceIndexInformedAt} IS NOT NULL AND ${t.faceIndexExpiresAt} IS NOT NULL)`,
    ),
    check(
      'folders_name_valid',
      sql`length(${t.name}) BETWEEN 1 AND 255 AND strpos(${t.name}, '/') = 0`,
    ),
    check(
      'folders_path_ends_with_own_label',
      sql`subpath(${t.path}, -1) = text2ltree(replace(${t.id}::text, '-', '_'))`,
    ),
    check('folders_root_iff_no_parent', sql`(${t.parentId} IS NULL) = (nlevel(${t.path}) = 1)`),
    check(
      'folders_trash_fields_need_deleted',
      sql`${t.deletedAt} IS NOT NULL OR (${t.trashedViaFolderId} IS NULL AND ${t.purgeRequestedAt} IS NULL)`,
    ),
    check(
      'folders_trashed_via_not_self',
      sql`${t.trashedViaFolderId} IS NULL OR ${t.trashedViaFolderId} <> ${t.id}`,
    ),
  ],
);

/**
 * Uploaded files. `folder_id` is null for files at the drive root. The foreign key on
 * (folder_id, owner_id) keeps a file in its owner's folders. Keys are built with the s3-keys
 * helpers in @shotx/shared: `s3_key` is the original, the others are derivatives (null until the
 * worker writes them).
 *
 * Names: unique among live, not-failed siblings ignoring ASCII case (`files_live_name_unique`).
 * Trash works as for folders (`trashed_via_folder_id`, `purge_requested_at`).
 *
 * Upload and quota state (see drive/quota in @shotx/shared for the transitions):
 *   uploading, upload_id set      multipart upload open until upload_expires_at; bytes reserved;
 *                                 upload_part_bytes is the plan's part size
 *   uploading/processing,         completed by the client (upload_id cleared), waiting for the
 *     verified_at null            worker; bytes still reserved
 *   verified_at set               the worker checked size and magic bytes; bytes are used
 *   failed, verified_at null      bytes rejected; nothing counted
 *   failed, verified_at set       verified, then processing failed (e.g. a corrupt image); the
 *                                 bytes stay in used until the file is purged
 *   purge_requested_at set        nothing counted; the worker deletes objects and the row
 *
 * Upload init idempotency (migration 0003): `client_upload_id` is the client's random id for one
 * intended upload, unique per owner (`files_client_upload_id_unique`); see `clientUploadId` of
 * `POST /uploads/init` in @shotx/shared.
 */
export const files = pgTable(
  'files',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    folderId: uuid('folder_id'),
    /** Display name as uploaded; used for Content-Disposition. */
    name: text('name').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    /** Lowercase hex, set by the worker. */
    sha256: text('sha256'),
    s3Key: text('s3_key').notNull(),
    thumbKey: text('thumb_key'),
    previewKey: text('preview_key'),
    webKey: text('web_key'),
    /** Videos only. */
    posterKey: text('poster_key'),
    width: integer('width'),
    height: integer('height'),
    takenAt: timestamptz('taken_at'),
    status: fileStatus('status').notNull().default('uploading'),
    /** Distinct faces after tile de-duplication; null until indexed or after the index expires. */
    faceCount: integer('face_count'),
    /** S3 multipart UploadId while `uploading`; cleared on complete or abort. */
    uploadId: text('upload_id'),
    /**
     * Part size of the upload's multipart plan, fixed at init (multipartPlan with the
     * UPLOAD_PART_BYTES of that moment), so signing parts and completing use the same plan even
     * if the setting changes. Required while `upload_id` is set.
     */
    uploadPartBytes: bigint('upload_part_bytes', { mode: 'number' }),
    /** The client's idempotency id of `POST /uploads/init`; null for older clients. */
    clientUploadId: uuid('client_upload_id'),
    /**
     * Size of the `web` download variant (web.jpg for images, preview.mp4 for videos), written by
     * the worker with the derivatives; for download activity `bytes` and zip totals.
     */
    webSizeBytes: bigint('web_size_bytes', { mode: 'number' }),
    /** End of the upload session (`expiresAt` of `POST /uploads/init`). */
    uploadExpiresAt: timestamptz('upload_expires_at'),
    /** When the worker verified the object; from then on the bytes are in used_bytes. */
    verifiedAt: timestamptz('verified_at'),
    deletedAt: timestamptz('deleted_at'),
    /** The trashed folder that took this file to the trash; null if trashed directly. */
    trashedViaFolderId: uuid('trashed_via_folder_id'),
    /** Set when the trash was emptied or the trash purge picked the file up. */
    purgeRequestedAt: timestamptz('purge_requested_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('files_s3_key_unique').on(t.s3Key),
    uniqueIndex('files_live_name_unique')
      .on(t.ownerId, parentKeySql(t.folderId), driveNameKeySql(t.name))
      .where(sql`${t.deletedAt} IS NULL AND ${t.status} <> 'failed'`),
    index('files_children_name_idx')
      .on(t.ownerId, t.folderId, driveNameKeySql(t.name), t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index('files_children_id_idx')
      .on(t.ownerId, t.folderId, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index('files_trash_idx')
      .on(t.ownerId, t.deletedAt, t.id)
      .where(
        sql`${t.deletedAt} IS NOT NULL AND ${t.trashedViaFolderId} IS NULL AND ${t.purgeRequestedAt} IS NULL`,
      ),
    index('files_trashed_via_idx')
      .on(t.trashedViaFolderId)
      .where(sql`${t.trashedViaFolderId} IS NOT NULL`),
    index('files_purge_requested_idx')
      .on(t.purgeRequestedAt)
      .where(sql`${t.purgeRequestedAt} IS NOT NULL`),
    uniqueIndex('files_client_upload_id_unique')
      .on(t.ownerId, t.clientUploadId)
      .where(sql`${t.clientUploadId} IS NOT NULL`),
    // Expired upload sessions, for the nightly cleanup.
    index('files_upload_expiry_idx')
      .on(t.uploadExpiresAt)
      .where(sql`${t.uploadId} IS NOT NULL`),
    unique('files_id_owner_unique').on(t.id, t.ownerId),
    foreignKey({
      name: 'files_folder_same_owner_fk',
      columns: [t.folderId, t.ownerId],
      foreignColumns: [folders.id, folders.ownerId],
    }),
    index('files_folder_owner_idx').on(t.folderId, t.ownerId),
    index('files_owner_idx').on(t.ownerId),
    index('files_trashed_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} IS NOT NULL`),
    check('files_name_valid', sql`length(${t.name}) BETWEEN 1 AND 1024`),
    check('files_size_nonnegative', sql`${t.sizeBytes} >= 0`),
    check('files_sha256_hex', sql`${t.sha256} IS NULL OR ${t.sha256} ~ '^[0-9a-f]{64}$'`),
    check(
      'files_dimensions_positive',
      sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0)`,
    ),
    check('files_face_count_nonnegative', sql`${t.faceCount} IS NULL OR ${t.faceCount} >= 0`),
    check(
      'files_upload_id_while_uploading',
      sql`${t.uploadId} IS NULL OR (${t.status} = 'uploading' AND ${t.uploadExpiresAt} IS NOT NULL)`,
    ),
    check(
      'files_upload_part_bytes_valid',
      sql`(${t.uploadId} IS NULL OR ${t.uploadPartBytes} IS NOT NULL) AND (${t.uploadPartBytes} IS NULL OR ${t.uploadPartBytes} BETWEEN ${minPart} AND ${maxPart})`,
    ),
    check('files_web_size_nonnegative', sql`${t.webSizeBytes} IS NULL OR ${t.webSizeBytes} >= 0`),
    check(
      'files_trash_fields_need_deleted',
      sql`${t.deletedAt} IS NOT NULL OR (${t.trashedViaFolderId} IS NULL AND ${t.purgeRequestedAt} IS NULL)`,
    ),
  ],
);

/** A face box in ratios of the oriented original's width and height. */
export interface FaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * "ขอลบใบหน้าของฉัน" requests (migration 0003), counts only: no selfie, no face ids, no viewer.
 * `POST /s/:token/face-deletion` inserts the row and sets `faces.deletion_id` on the matched faces
 * in one transaction, then sends `delete.faces`; the worker deletes the faces from the collection
 * and the database and sets `faces_deleted` and `completed_at`. `share_id` records which link was
 * used; it has no foreign key so the record survives the share's purge.
 */
export const faceDeletions = pgTable(
  'face_deletions',
  {
    id: id(),
    photographerId: uuid('photographer_id')
      .notNull()
      .references(() => users.id),
    shareId: uuid('share_id').notNull(),
    facesMatched: integer('faces_matched').notNull(),
    facesDeleted: integer('faces_deleted'),
    createdAt: createdAt(),
    completedAt: timestamptz('completed_at'),
  },
  (t) => [
    unique('face_deletions_id_photographer_unique').on(t.id, t.photographerId),
    index('face_deletions_photographer_created_idx').on(t.photographerId, t.createdAt),
    index('face_deletions_pending_idx')
      .on(t.createdAt)
      .where(sql`${t.completedAt} IS NULL`),
    check(
      'face_deletions_counts_nonnegative',
      sql`${t.facesMatched} >= 0 AND (${t.facesDeleted} IS NULL OR ${t.facesDeleted} >= 0)`,
    ),
    check(
      'face_deletions_completed_has_count',
      sql`(${t.completedAt} IS NULL) = (${t.facesDeleted} IS NULL)`,
    ),
  ],
);

/**
 * Faces indexed in the photographer's Rekognition collection. A file can't be deleted while it
 * has faces (ON DELETE RESTRICT): purge must call DeleteFaces first, or the faces would outlive
 * every record of them.
 *
 * `deletion_id` (migration 0003) marks a face a "ขอลบใบหน้าของฉัน" request matched. From then on
 * it is not searchable: face search maps Rekognition matches to rows `WHERE deletion_id IS NULL`
 * (searchableFaceSql), until the worker deletes the face and the row.
 */
export const faces = pgTable(
  'faces',
  {
    id: id(),
    fileId: uuid('file_id').notNull(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    rekognitionFaceId: text('rekognition_face_id').notNull(),
    bbox: jsonb('bbox').$type<FaceBox>().notNull(),
    confidence: real('confidence').notNull(),
    deletionId: uuid('deletion_id'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('faces_rekognition_face_id_unique').on(t.rekognitionFaceId),
    foreignKey({
      name: 'faces_deletion_same_owner_fk',
      columns: [t.deletionId, t.ownerId],
      foreignColumns: [faceDeletions.id, faceDeletions.photographerId],
    }),
    index('faces_deletion_idx')
      .on(t.deletionId)
      .where(sql`${t.deletionId} IS NOT NULL`),
    foreignKey({
      name: 'faces_file_same_owner_fk',
      columns: [t.fileId, t.ownerId],
      foreignColumns: [files.id, files.ownerId],
    }).onDelete('restrict'),
    index('faces_file_owner_idx').on(t.fileId, t.ownerId),
    index('faces_owner_idx').on(t.ownerId),
    check('faces_confidence_range', sql`${t.confidence} BETWEEN 0 AND 100`),
    check('faces_bbox_object', sql`jsonb_typeof(${t.bbox}) = 'object'`),
  ],
);
