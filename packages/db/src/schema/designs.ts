import {
  DESIGN_ASSET_MIME_TYPES,
  DESIGN_DOC_MAX_BYTES_LIMIT,
  DESIGN_NAME_MAX_LENGTH,
  type DesignDoc,
} from '@shotx/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import { fileStatus } from './enums';

const nameMaxLength = sql.raw(String(DESIGN_NAME_MAX_LENGTH));
const docMaxBytes = sql.raw(String(DESIGN_DOC_MAX_BYTES_LIMIT));
const assetMimes = sql.raw(DESIGN_ASSET_MIME_TYPES.map((m) => `'${m}'`).join(', '));

/**
 * Share page designs (ADR 0013, migration 0013). `doc` is a design document (designDocSchema in
 * @shotx/shared), validated by the api on every write; the database only checks that it is an
 * object below the hard ceiling DESIGN_DOC_MAX_BYTES_LIMIT (measured on jsonb's text form, a
 * little longer than JSON.stringify; DESIGN_DOC_MAX_BYTES can be configured only up to half the
 * ceiling, DESIGN_DOC_MAX_BYTES_CONFIG_MAX, so a document the api accepts always fits).
 *
 * `revision`: optimistic concurrency. A save is `UPDATE ... SET revision = revision + 1 WHERE id
 * AND owner_id AND revision = $sent`; no row is DESIGN_REVISION_CONFLICT.
 *
 * `is_default`: at most one per owner (`share_designs_one_default_per_owner`, partial unique).
 * Setting the default clears the previous one first in the same transaction.
 *
 * Hard delete: `shares.design_id` is set to null by the shares foreign key (ON DELETE SET NULL of
 * design_id only). `design_assets` are not touched (the orphan purge decides).
 *
 * `(id, owner_id)` is unique so `shares` can reference a design together with its owner: a share
 * can only use its owner's design.
 */
export const shareDesigns = pgTable(
  'share_designs',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    name: text('name').notNull(),
    doc: jsonb('doc').$type<DesignDoc>().notNull(),
    revision: integer('revision').notNull().default(1),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    unique('share_designs_id_owner_unique').on(t.id, t.ownerId),
    uniqueIndex('share_designs_one_default_per_owner')
      .on(t.ownerId)
      .where(sql`${t.isDefault}`),
    // GET /designs: the owner's designs, most recently updated first.
    index('share_designs_owner_updated_idx').on(t.ownerId, t.updatedAt.desc()),
    check(
      'share_designs_name_valid',
      sql`char_length(${t.name}) BETWEEN 1 AND ${nameMaxLength} AND ${t.name} = btrim(${t.name})`,
    ),
    check('share_designs_revision_positive', sql`${t.revision} >= 1`),
    check(
      'share_designs_doc_valid',
      sql`jsonb_typeof(${t.doc}) = 'object' AND octet_length(${t.doc}::text) <= ${docMaxBytes}`,
    ),
  ],
);

/**
 * Images of share page designs (ADR 0013, migration 0013): logos and pictures, JPEG, PNG or WebP.
 * Keys are designAssetKey({ photographerId: owner_id, assetId: id }, 'original' | 'web') in
 * @shotx/shared; `width` and `height` are web.webp's, set with `ready`. See design/assets in
 * @shotx/shared for the status and quota transitions (counted in `storage_usage` like originals,
 * `verified_at` says which bucket, as for files).
 *
 * - `upload_expires_at`: end of the presigned PUT; required while `uploading`. The nightly
 *   reconciliation fails expired uploads and releases their reservation.
 * - `queued_at`, `requeues`: outbox mark of the `design.asset` job (set by complete, bumped by
 *   media.sweep), like `files.media_queued_at` / `media_requeues`.
 * - `orphaned_at`: when the nightly purge first found no design of the owner referencing the
 *   asset; cleared when one does again. Purged DESIGN_ASSET_ORPHAN_DAYS after it.
 * - `purge_requested_at`: the purge took the asset (bytes no longer counted); the job then deletes
 *   both objects and the row. The api treats such rows as missing.
 *
 * Not referenced by a foreign key from `share_designs`: documents hold asset ids in jsonb, and
 * the api checks them on every write (DESIGN_ASSET_NOT_FOUND).
 */
export const designAssets = pgTable(
  'design_assets',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    mime: text('mime').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    status: fileStatus('status').notNull().default('uploading'),
    uploadExpiresAt: timestamptz('upload_expires_at'),
    verifiedAt: timestamptz('verified_at'),
    queuedAt: timestamptz('queued_at'),
    requeues: integer('requeues').notNull().default(0),
    orphanedAt: timestamptz('orphaned_at'),
    purgeRequestedAt: timestamptz('purge_requested_at'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('design_assets_id_owner_unique').on(t.id, t.ownerId),
    // GET /designs/assets: the owner's live images, newest first (uuidv7 ids).
    index('design_assets_owner_list_idx')
      .on(t.ownerId, t.id.desc())
      .where(sql`${t.purgeRequestedAt} IS NULL`),
    // media.sweep: design.asset jobs outstanding.
    index('design_assets_processing_idx')
      .on(t.queuedAt)
      .where(sql`${t.status} = 'processing'`),
    // quota.reconcile.nightly: abandoned uploads.
    index('design_assets_upload_expiry_idx')
      .on(t.uploadExpiresAt)
      .where(sql`${t.status} = 'uploading'`),
    // trash.purge.daily: orphans due, and purges to finish.
    index('design_assets_orphaned_idx')
      .on(t.orphanedAt)
      .where(sql`${t.orphanedAt} IS NOT NULL AND ${t.purgeRequestedAt} IS NULL`),
    index('design_assets_purge_requested_idx')
      .on(t.purgeRequestedAt)
      .where(sql`${t.purgeRequestedAt} IS NOT NULL`),
    check('design_assets_mime_allowed', sql`${t.mime} IN (${assetMimes})`),
    check('design_assets_size_positive', sql`${t.sizeBytes} > 0`),
    check(
      'design_assets_dimensions_positive',
      sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0)`,
    ),
    check(
      'design_assets_ready_complete',
      sql`${t.status} <> 'ready' OR (${t.width} IS NOT NULL AND ${t.height} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`,
    ),
    check(
      'design_assets_uploading_has_expiry',
      sql`${t.status} <> 'uploading' OR ${t.uploadExpiresAt} IS NOT NULL`,
    ),
    check('design_assets_requeues_nonnegative', sql`${t.requeues} >= 0`),
  ],
);
