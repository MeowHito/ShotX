import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, real, text, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { createdAt, id, timestamptz } from './columns';
import { files } from './drive';
import { downloadSize, faceFeedbackVerdict, shareMode, shareTargetType } from './enums';

/**
 * Share links, `/s/{token}`. The token is 128 random bits in base62 (~22 characters). The target
 * is a file or a folder of the owner; the API checks both, since a polymorphic target can't have
 * a foreign key.
 */
export const shares = pgTable(
  'shares',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    targetType: shareTargetType('target_type').notNull(),
    targetId: uuid('target_id').notNull(),
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
    index('shares_owner_idx').on(t.ownerId),
    index('shares_target_idx').on(t.targetType, t.targetId),
    check('shares_token_base62', sql`${t.token} ~ '^[0-9A-Za-z]{16,64}$'`),
  ],
);

/**
 * Face-search consent per share and viewer (logged in) or anonymous session (`anon_id` cookie),
 * for one policy version. A scan needs a row for the current version that is not withdrawn.
 * `ip_hash` is a keyed hash, never the address.
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
    check('consents_viewer_or_anon', sql`${t.viewerId} IS NOT NULL OR ${t.anonId} IS NOT NULL`),
    check('consents_policy_version_not_empty', sql`length(${t.policyVersion}) > 0`),
  ],
);

/** "ไม่ใช่ฉัน" feedback for threshold tuning. No biometrics and no viewer identity. */
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
    check('face_feedback_similarity_range', sql`${t.similarity} BETWEEN 0 AND 100`),
  ],
);
