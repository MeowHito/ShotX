import { AUTH_METHODS } from '@shotx/shared';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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

const authMethods = sql.raw(`ARRAY[${AUTH_METHODS.map((m) => `'${m}'`).join(', ')}]::text[]`);

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
 * - `amr` (migration 0012, ADR 0011 decision 4): the methods of the family's sign-in, copied to
 *   every successor; refresh re-issues exactly these (never more) and refuses an admins-pool
 *   family that no longer satisfies ADMIN_MFA_MODE (adminSessionSatisfiesMfaMode). Null: a row
 *   from before 0012, whose methods follow from the subject as before (admins: pwd, otp, mfa).
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
    amr: text('amr').array(),
    /**
     * ADR 0018 (migration 0015): the admin working in this photographer's account through an
     * act-as link; null for the photographer's own sessions. Copied to every successor. The api
     * audits every change made in such a session and shows a banner in the studio.
     */
    actingAdminId: uuid('acting_admin_id').references((): AnyPgColumn => users.id, {
      onDelete: 'cascade',
    }),
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
      'auth_sessions_amr_valid',
      sql`${t.amr} IS NULL OR (cardinality(${t.amr}) >= 1 AND ${t.amr} <@ ${authMethods})`,
    ),
    check(
      'auth_sessions_replaced_is_revoked',
      sql`${t.replacedById} IS NULL OR (${t.revokedAt} IS NOT NULL AND ${t.replacedById} <> ${t.id})`,
    ),
  ],
);

/**
 * Password + TOTP credentials of a ShotX admin (migration 0005; 0011 for ADR 0010). Admin accounts
 * are created by the operator CLI or by an admin in the admin app (never by sign-up).
 *
 * - `auth_pool` is always `admins` and (user_id, auth_pool) references users (id, auth_pool), so
 *   only admins-pool users (role `admin` by users' CHECK) can have credentials.
 * - `password_hash`: an argon2id PHC string (`$argon2id$v=19$m=...`).
 * - `totp_secret_encrypted`: the TOTP secret encrypted with AES-256-GCM under
 *   ADMIN_TOTP_ENCRYPTION_KEY, ciphertext followed by the 16-byte tag, with `totp_secret_nonce`
 *   (12 bytes) and the user id as additional authenticated data.
 * - `totp_secret_encrypted` / `totp_secret_nonce` (nullable since migration 0011): both set or
 *   both null (`admin_credentials_totp_secret_complete`). Null for an admin created in the admin
 *   app until their first sign-in confirms a TOTP code: that sign-in generates the secret, keeps it
 *   in the sign-in challenge and stores it here together with `totp_confirmed_at`
 *   (ADMIN_SIGN_IN_STEPS in @shotx/shared). The CLI always sets them.
 * - `totp_confirmed_at`: null while enrolment is pending (the CLI created the secret and showed
 *   it once); set by the first valid code. Until then sign-in can only confirm it. Never set
 *   without a secret (`admin_credentials_totp_state_needs_secret`, which also covers
 *   `totp_last_used_step`).
 * - `must_change_password` (migration 0011): the password is temporary; sign-in asks for a new one
 *   before the TOTP step. False for CLI-created admins, true for admin-app creations and resets.
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
    totpSecretEncrypted: bytea('totp_secret_encrypted'),
    totpSecretNonce: bytea('totp_secret_nonce'),
    totpConfirmedAt: timestamptz('totp_confirmed_at'),
    totpLastUsedStep: bigint('totp_last_used_step', { mode: 'number' }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
    mustChangePassword: boolean('must_change_password').notNull().default(false),
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
    // Migration 0011.
    check(
      'admin_credentials_totp_secret_complete',
      sql`(${t.totpSecretEncrypted} IS NULL) = (${t.totpSecretNonce} IS NULL)`,
    ),
    check(
      'admin_credentials_totp_state_needs_secret',
      sql`(${t.totpConfirmedAt} IS NULL AND ${t.totpLastUsedStep} IS NULL) OR ${t.totpSecretEncrypted} IS NOT NULL`,
    ),
  ],
);

/**
 * Password credentials of a photographer account an admin created (migration 0011, ADR 0010):
 * users pool, `password:<users.id>` subject (passwordAccountSubject in @shotx/shared). Admins keep
 * admin_credentials (password + TOTP).
 *
 * - `auth_pool` is always `users` and (user_id, auth_pool) references users (id, auth_pool), so
 *   an admin can never get these credentials. The api creates the row only for `password:`
 *   subjects, in the transaction that creates the user (`users_password_subject_photographer`
 *   makes those photographers with an email).
 * - `password_hash`: an argon2id PHC string, like admin_credentials.
 * - `must_change_password`: true after an admin sets the password (create or reset); sign-in then
 *   answers a restricted session until POST /auth/photographer/password, which clears it and sets
 *   `password_changed_at`.
 * - `failed_attempts` counts consecutive failures (sign-in, or a wrong current password) and
 *   resets on success; reaching PHOTOGRAPHER_LOGIN_LOCKOUT_THRESHOLD sets `locked_until`
 *   (PHOTOGRAPHER_LOGIN_LOCKOUT_SECONDS). An admin reset clears both.
 * - `updated_at`: set by every change (no trigger).
 */
export const userPasswordCredentials = pgTable(
  'user_password_credentials',
  {
    userId: uuid('user_id').primaryKey(),
    authPool: authPool('auth_pool').notNull().default('users'),
    passwordHash: text('password_hash').notNull(),
    mustChangePassword: boolean('must_change_password').notNull().default(true),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamptz('locked_until'),
    passwordChangedAt: timestamptz('password_changed_at'),
    createdAt: createdAt(),
    updatedAt: timestamptz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'user_password_credentials_user_fk',
      columns: [t.userId, t.authPool],
      foreignColumns: [users.id, users.authPool],
    }).onDelete('cascade'),
    check('user_password_credentials_users_pool', sql`${t.authPool} = 'users'`),
    check('user_password_credentials_password_argon2id', sql`${t.passwordHash} LIKE '$argon2id$%'`),
    check('user_password_credentials_failed_attempts_valid', sql`${t.failedAttempts} >= 0`),
  ],
);
