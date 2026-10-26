import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { users } from './accounts';
import { bytea, createdAt, id, timestamptz } from './columns';
import { authPool } from './enums';

/**
 * Refresh sessions of ShotX-issued tokens (ADR 0008 section 4; migration 0005). One row per
 * refresh token. A sign-in starts a family (`family_id` = the first row's id); every refresh
 * revokes the presented row, links it to its successor (`replaced_by_id`) and inserts the
 * successor with the same family, pool and `expires_at` (rotation never extends a sign-in).
 *
 * - Presenting a row that is revoked and has a successor is reuse: revoke the whole family
 *   (`auth_sessions_family_idx`) and answer REFRESH_TOKEN_REUSED.
 * - Logout revokes the family. A user's sessions go with the user (cascade).
 * - auth.sessions.purge.daily deletes rows AUTH_SESSION_RETENTION_DAYS after `expires_at`
 *   (`auth_sessions_expires_idx`); revoked rows stay until then, for reuse detection.
 * - `refresh_token_hash` is the lowercase hex SHA-256 of the token; the token itself is never
 *   stored.
 * - (user_id, pool) references users (id, auth_pool), so the session's pool is its user's.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    pool: authPool('pool').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    familyId: uuid('family_id').notNull(),
    expiresAt: timestamptz('expires_at').notNull(),
    revokedAt: timestamptz('revoked_at'),
    /**
     * The successor after rotation. ON DELETE SET NULL (migration 0006), so
     * auth.sessions.purge.daily can delete expired rows in any batch order.
     */
    replacedById: uuid('replaced_by_id').references((): AnyPgColumn => authSessions.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    lastUsedAt: timestamptz('last_used_at').notNull().defaultNow(),
  },
  (t) => [
    unique('auth_sessions_refresh_token_hash_unique').on(t.refreshTokenHash),
    foreignKey({
      name: 'auth_sessions_user_pool_fk',
      columns: [t.userId, t.pool],
      foreignColumns: [users.id, users.authPool],
    }).onDelete('cascade'),
    index('auth_sessions_family_idx').on(t.familyId),
    index('auth_sessions_user_idx').on(t.userId),
    index('auth_sessions_expires_idx').on(t.expiresAt),
    check('auth_sessions_hash_format', sql`${t.refreshTokenHash} ~ '^[0-9a-f]{64}$'`),
    check('auth_sessions_expiry_order', sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      'auth_sessions_replaced_is_revoked',
      sql`${t.replacedById} IS NULL OR (${t.revokedAt} IS NOT NULL AND ${t.replacedById} <> ${t.id})`,
    ),
  ],
);

/**
 * Password + TOTP credentials of a ShotX admin (migration 0005). Admin accounts are created by the
 * operator CLI only (no sign-up).
 *
 * - `auth_pool` is always `admins` and (user_id, auth_pool) references users (id, auth_pool), so
 *   only admins-pool users (role `admin` by users' CHECK) can have credentials.
 * - `password_hash`: an argon2id PHC string (`$argon2id$v=19$m=...`).
 * - `totp_secret_encrypted`: the TOTP secret encrypted with AES-256-GCM under
 *   ADMIN_TOTP_ENCRYPTION_KEY, ciphertext followed by the 16-byte tag, with `totp_secret_nonce`
 *   (12 bytes) and the user id as additional authenticated data.
 * - `totp_confirmed_at`: null while enrolment is pending (the CLI created the secret and showed
 *   it once); set by the first valid code. Until then sign-in can only confirm it.
 * - `totp_last_used_step`: the last accepted time step (unix time / period); a code for this
 *   step or an earlier one is a replay (MFA_INVALID). Update it with
 *   `WHERE totp_last_used_step IS NULL OR totp_last_used_step < $step`.
 * - `failed_attempts` counts consecutive failures (password or code) and resets on success;
 *   reaching ADMIN_LOGIN_LOCKOUT_THRESHOLD sets `locked_until`.
 * - `updated_at`: set by every change (no trigger).
 */
export const adminCredentials = pgTable(
  'admin_credentials',
  {
    userId: uuid('user_id').primaryKey(),
    authPool: authPool('auth_pool').notNull().default('admins'),
    passwordHash: text('password_hash').notNull(),
    totpSecretEncrypted: bytea('totp_secret_encrypted').notNull(),
    totpSecretNonce: bytea('totp_secret_nonce').notNull(),
    totpConfirmedAt: timestamptz('totp_confirmed_at'),
    totpLastUsedStep: bigint('totp_last_used_step', { mode: 'number' }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'admin_credentials_admin_user_fk',
      columns: [t.userId, t.authPool],
      foreignColumns: [users.id, users.authPool],
    }).onDelete('cascade'),
    check('admin_credentials_admins_pool', sql`${t.authPool} = 'admins'`),
    check('admin_credentials_password_argon2id', sql`${t.passwordHash} LIKE '$argon2id$%'`),
    check(
      'admin_credentials_totp_sizes',
      sql`octet_length(${t.totpSecretNonce}) = 12 AND octet_length(${t.totpSecretEncrypted}) BETWEEN 17 AND 1024`,
    ),
    check(
      'admin_credentials_counters_valid',
      sql`${t.failedAttempts} >= 0 AND (${t.totpLastUsedStep} IS NULL OR ${t.totpLastUsedStep} >= 0)`,
    ),
  ],
);
