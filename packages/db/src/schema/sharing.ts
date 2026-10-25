import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  real,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import { files, folders } from './drive';
import { downloadSize, faceFeedbackVerdict, shareMode, shareTargetType } from './enums';

/**
 * Share links, `/s/{token}`. The token is 128 random bits in base62 (~22 characters).
 *
 * The target is a file (`target_file_id`) or a folder (`target_folder_id`) of the share's owner:
 * each has a foreign key on (target, owner_id), so a share can never point at another
 * photographer's file or folder. Exactly one is set, and `target_type` says which (it is kept,
 * although derivable, because the data model and API use it; the CHECKs keep the three columns
 * consistent). Files and folders with shares can't be deleted (ON DELETE RESTRICT): purge removes
 * their shares (and the shares' consents) first.
 */
export const shares = pgTable(
  'shares',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    targetType: shareTargetType('target_type').notNull(),
    /** Set exactly when `target_type` is `file`. */
    targetFileId: uuid('target_file_id'),
    /** Set exactly when `target_type` is `folder`. */
    targetFolderId: uuid('target_folder_id'),
    token: text('token').notNull(),
    mode: shareMode('mode').notNull().default('gallery'),
    allowDownload: boolean('allow_download').notNull().default(true),
    downloadSize: downloadSize('download_size').notNull().default('web'),
    requireLogin: boolean('require_login').notNull().default(false),
    /** argon2id. */
    passwordHash: text('password_hash'),
    expiresAt: timestamptz('expires_at'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    unique('shares_token_unique').on(t.token),
    unique('shares_id_owner_unique').on(t.id, t.ownerId),
    foreignKey({
      name: 'shares_target_file_same_owner_fk',
      columns: [t.targetFileId, t.ownerId],
      foreignColumns: [files.id, files.ownerId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'shares_target_folder_same_owner_fk',
      columns: [t.targetFolderId, t.ownerId],
      foreignColumns: [folders.id, folders.ownerId],
    }).onDelete('restrict'),
    // GET /shares: the owner's shares, newest first (ids are uuidv7).
    index('shares_owner_list_idx').on(t.ownerId, t.id),
    index('shares_target_file_idx')
      .on(t.targetFileId, t.ownerId)
      .where(sql`${t.targetFileId} IS NOT NULL`),
    index('shares_target_folder_idx')
      .on(t.targetFolderId, t.ownerId)
      .where(sql`${t.targetFolderId} IS NOT NULL`),
    check('shares_one_target', sql`num_nonnulls(${t.targetFileId}, ${t.targetFolderId}) = 1`),
    check(
      'shares_target_matches_type',
      sql`(${t.targetType} = 'file') = (${t.targetFileId} IS NOT NULL) AND (${t.targetType} = 'folder') = (${t.targetFolderId} IS NOT NULL)`,
    ),
    check('shares_token_base62', sql`${t.token} ~ '^[0-9A-Za-z]{16,64}$'`),
  ],
);

/**
 * Face-search consent per share and viewer (logged in) or anonymous session (`anon_id` cookie),
 * for one policy version. A scan needs a row for the current version that is not withdrawn.
 * `ip_hash` is a keyed hash, never the address (`v1:` + HMAC, see IP_HASH_VERSION).
 *
 * Exactly one of `viewer_id` and `anon_id` is set (viewerColumns in @shotx/shared). At most one
 * current (not withdrawn) consent exists per share, viewer or session, and version, so giving
 * consent is an idempotent upsert: `INSERT ... ON CONFLICT DO NOTHING` on the partial unique
 * index, then select. Withdrawal sets `withdrawn_at` on every current row of the viewer or session
 * for the share; a later consent inserts a new row, so the history stays.
 */
export const consents = pgTable(
  'consents',
  {
    id: id(),
    shareId: uuid('share_id')
      .notNull()
      .references(() => shares.id),
    viewerId: uuid('viewer_id').references(() => users.id),
    anonId: uuid('anon_id'),
    policyVersion: text('policy_version').notNull(),
    ipHash: text('ip_hash').notNull(),
    acceptedAt: timestamptz('accepted_at').notNull().defaultNow(),
    withdrawnAt: timestamptz('withdrawn_at'),
  },
  (t) => [
    index('consents_share_viewer_idx').on(t.shareId, t.viewerId),
    index('consents_share_anon_idx').on(t.shareId, t.anonId),
    uniqueIndex('consents_current_viewer_unique')
      .on(t.shareId, t.viewerId, t.policyVersion)
      .where(sql`${t.withdrawnAt} IS NULL AND ${t.viewerId} IS NOT NULL`),
    uniqueIndex('consents_current_anon_unique')
      .on(t.shareId, t.anonId, t.policyVersion)
      .where(sql`${t.withdrawnAt} IS NULL AND ${t.anonId} IS NOT NULL`),
    check('consents_viewer_or_anon', sql`num_nonnulls(${t.viewerId}, ${t.anonId}) = 1`),
    check(
      'consents_withdrawn_after_accepted',
      sql`${t.withdrawnAt} IS NULL OR ${t.withdrawnAt} >= ${t.acceptedAt}`,
    ),
    check('consents_policy_version_not_empty', sql`length(${t.policyVersion}) > 0`),
  ],
);

/**
 * "ไม่ใช่ฉัน" feedback for threshold tuning. No biometrics and no viewer identity. `similarity` is
 * the score the API stored in the viewer's face-search result (never sent by the client).
 */
export const faceFeedback = pgTable(
  'face_feedback',
  {
    id: id(),
    shareId: uuid('share_id')
      .notNull()
      .references(() => shares.id, { onDelete: 'cascade' }),
    fileId: uuid('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    similarity: real('similarity').notNull(),
    verdict: faceFeedbackVerdict('verdict').notNull().default('not_me'),
    createdAt: createdAt(),
  },
  (t) => [
    index('face_feedback_share_idx').on(t.shareId),
    index('face_feedback_file_idx').on(t.fileId),
    // Tuning exports and the "ไม่ใช่ฉัน" rate read by time.
    index('face_feedback_created_idx').on(t.createdAt),
    check('face_feedback_similarity_range', sql`${t.similarity} BETWEEN 0 AND 100`),
  ],
);
