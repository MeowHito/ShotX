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
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, ltree, timestamptz } from './columns';
import { fileStatus } from './enums';

/**
 * Drive folders. `path` is the ltree of folder ids from the root down to this folder, each label
 * the id with `-` replaced by `_` (see src/ltree.ts); share scope checks use `path <@ root`.
 * Moving a folder rewrites the subtree's prefix in one transaction.
 *
 * Parents must belong to the same owner: the foreign key is on (parent_id, owner_id).
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
    faceIndexEnabled: boolean('face_index_enabled').notNull().default(false),
    faceIndexExpiresAt: timestamptz('face_index_expires_at'),
    deletedAt: timestamptz('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('folders_id_owner_unique').on(t.id, t.ownerId),
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
    check(
      'folders_name_valid',
      sql`length(${t.name}) BETWEEN 1 AND 255 AND strpos(${t.name}, '/') = 0`,
    ),
    check(
      'folders_path_ends_with_own_label',
      sql`subpath(${t.path}, -1) = text2ltree(replace(${t.id}::text, '-', '_'))`,
    ),
    check('folders_root_iff_no_parent', sql`(${t.parentId} IS NULL) = (nlevel(${t.path}) = 1)`),
  ],
);

/**
 * Uploaded files. `folder_id` is null for files at the drive root. The foreign key on
 * (folder_id, owner_id) keeps a file in its owner's folders. Keys are built with the s3-keys
 * helpers in @shotx/shared: `s3_key` is the original, the others are derivatives (null until the
 * worker writes them).
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
    deletedAt: timestamptz('deleted_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('files_s3_key_unique').on(t.s3Key),
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
 * Faces indexed in the photographer's Rekognition collection. A file can't be deleted while it
 * has faces (ON DELETE RESTRICT): purge must call DeleteFaces first, or the faces would outlive
 * every record of them.
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
    createdAt: createdAt(),
  },
  (t) => [
    unique('faces_rekognition_face_id_unique').on(t.rekognitionFaceId),
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
