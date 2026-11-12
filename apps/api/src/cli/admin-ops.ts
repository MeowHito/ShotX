import { adminCredentials, auditLog, users } from '@shotx/db';
import {
  type AdminSignInConfig,
  type Argon2idParams,
  type AuthAuditAction,
  authSubject,
  AUTH_SUBJECT_MAX_LENGTH,
  passwordPolicyViolation,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { findAdminByEmail, normalizeAdminEmail } from '../auth/admin-sign-in';
import { hashPassword } from '../auth/password';
import { isCommonPassword } from '../auth/password-policy';
import { revokeUserSessions } from '../auth/sessions';
import {
  adminTotpIssuer,
  base32Encode,
  encryptTotpSecret,
  generateTotpSecret,
  otpauthUri,
} from '../auth/totp';
import { type Db, isUniqueViolation, type Queryable } from '../db/db';
import { newId } from '../drive/folders';

// Operator actions on ShotX admin accounts (ADR 0008 section 4), used by cli/admin.ts. Admins
// are created here only (no sign-up). Every action is written to audit_log without an actor (the
// operator has no account), so the action names carry the `auth.` prefix that allows that.

/** audit_log actions of the operator CLI (AUTH_AUDIT_ACTIONS; written without an actor). */
type OperatorAuditAction = Extract<
  AuthAuditAction,
  | 'auth.admin.created'
  | 'auth.admin.totp_reset'
  | 'auth.admin.password_reset'
  | 'auth.admin.unlocked'
>;

export interface AdminOpsContext {
  db: Db;
  stage: string;
  admin: AdminSignInConfig;
  argon2id: Argon2idParams;
  now: () => Date;
  /** Who ran the command (the OS user), for the audit row. */
  operator: string;
}

/** Thrown for operator mistakes (unknown admin, weak password, ...): printed, exit code 1. */
export class AdminOpsError extends Error {
  override readonly name = 'AdminOpsError';
}

const emailSchema = z.email().max(254);
const nameSchema = z.string().trim().min(1).max(200);

/** What the operator hands to the new admin's authenticator app (shown once). */
export interface TotpEnrolment {
  mfa: 'totp';
  userId: string;
  subject: string;
  otpauthUri: string;
  /** The same secret in base32, for manual entry. */
  secretBase32: string;
}

/**
 * The same policy as passwords set in the admin app (ADR 0010): ADMIN_PASSWORD_MIN_LENGTH, not too
 * simple, not containing the email, not on the common list. Messages never include the password.
 */
function checkPassword(ctx: AdminOpsContext, password: string, email: string): void {
  const min = ctx.admin.passwordMinLength;
  if (password.length > 1024) throw new AdminOpsError('Password must be at most 1024 characters');
  const violation = passwordPolicyViolation(password, { minLength: min, email });
  if (violation === 'too_short')
    throw new AdminOpsError(`Password must be at least ${min} characters`);
  if (violation === 'contains_email')
    throw new AdminOpsError('Password must not contain the email');
  if (violation !== null)
    throw new AdminOpsError('Password is too simple; use a longer, random one');
  if (isCommonPassword(password)) throw new AdminOpsError('Password is too common');
}

async function audit(
  q: Queryable,
  ctx: AdminOpsContext,
  action: OperatorAuditAction,
  userId: string,
): Promise<void> {
  await q.insert(auditLog).values({
    actorId: null,
    action,
    targetType: 'user',
    targetId: userId,
    meta: { via: 'cli', operator: ctx.operator.slice(0, 64) },
    createdAt: ctx.now(),
  });
}

function enrolment(
  ctx: AdminOpsContext,
  totp: { digits: 6 | 8; periodSeconds: number },
  userId: string,
  email: string,
  secret: Buffer,
): TotpEnrolment {
  return {
    mfa: 'totp',
    userId,
    subject: authSubject('admin', userId),
    otpauthUri: otpauthUri({
      issuer: adminTotpIssuer(ctx.stage),
      account: email,
      secret,
      digits: totp.digits,
      periodSeconds: totp.periodSeconds,
    }),
    secretBase32: base32Encode(secret),
  };
}

/** `create` with ADMIN_MFA_MODE=off (ADR 0011 decision 4): no TOTP secret, nothing to show. */
export interface PasswordOnlyAdmin {
  mfa: 'off';
  userId: string;
  subject: string;
}

export type CreatedAdmin = TotpEnrolment | PasswordOnlyAdmin;

/** The TOTP settings, or an operator error naming what is missing. */
function totpSettings(ctx: AdminOpsContext, command: string) {
  if (ctx.admin.mfaMode !== 'totp' || ctx.admin.totp === null) {
    throw new AdminOpsError(
      `${command} needs ADMIN_MFA_MODE=totp and ADMIN_TOTP_ENCRYPTION_KEY (admin MFA is off)`,
    );
  }
  return ctx.admin.totp;
}

async function requireAdmin(ctx: AdminOpsContext, email: string) {
  const row = await findAdminByEmail(ctx.db, email);
  if (row === null) throw new AdminOpsError('No ShotX admin with this email');
  return row;
}

/**
 * Creates an admin: a `users` row in the admins pool (role admin, subject `admin:<users.id>`) and
 * its credentials, in one transaction. TOTP stays unconfirmed (`totp_confirmed_at` null) until
 * the first valid code at sign-in. The operator typed the password, so it is not temporary
 * (`must_change_password = false`, ADR 0010). The email must not belong to any password account
 * (admin or photographer, users_password_account_email_unique). ADMIN_MFA_MODE=off (ADR 0011
 * decision 4): no TOTP secret is created and nothing is shown; should the mode go back to `totp`,
 * the admin enrols at the first sign-in (`enrol_totp`).
 */
export async function createAdmin(
  ctx: AdminOpsContext,
  input: { email: string; name: string; password: string },
): Promise<CreatedAdmin> {
  const email = emailSchema.safeParse(input.email.trim());
  if (!email.success) throw new AdminOpsError('Invalid email');
  const name = nameSchema.safeParse(input.name);
  if (!name.success) throw new AdminOpsError('Invalid name (1-200 characters)');
  checkPassword(ctx, input.password, email.data);
  if ((await findAdminByEmail(ctx.db, email.data)) !== null) {
    throw new AdminOpsError('An admin with this email already exists');
  }
  const passwordHash = await hashPassword(input.password, ctx.argon2id);
  const secret = ctx.admin.mfaMode === 'totp' ? generateTotpSecret() : null;
  const now = ctx.now();
  try {
    return await insertAdmin(ctx, {
      email: email.data,
      name: name.data,
      passwordHash,
      secret,
      now,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AdminOpsError('An account with this email already exists');
    }
    throw error;
  }
}

function insertAdmin(
  ctx: AdminOpsContext,
  input: { email: string; name: string; passwordHash: string; secret: Buffer | null; now: Date },
): Promise<CreatedAdmin> {
  const { email, name, passwordHash, secret, now } = input;
  return ctx.db.transaction(async (tx) => {
    const id = await newId(tx);
    const subject = authSubject('admin', id);
    if (subject.length > AUTH_SUBJECT_MAX_LENGTH) throw new Error('Subject too long');
    await tx.insert(users).values({
      id,
      authPool: 'admins',
      authSubject: subject,
      role: 'admin',
      email,
      name,
      createdAt: now,
    });
    const totp = secret === null ? null : totpSettings(ctx, 'create');
    const encrypted =
      secret === null || totp === null ? null : encryptTotpSecret(totp.encryptionKey, id, secret);
    await tx.insert(adminCredentials).values({
      userId: id,
      passwordHash,
      totpSecretEncrypted: encrypted?.ciphertext ?? null,
      totpSecretNonce: encrypted?.nonce ?? null,
      mustChangePassword: false,
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, ctx, 'auth.admin.created', id);
    if (secret === null || totp === null) {
      return { mfa: 'off', userId: id, subject: authSubject('admin', id) } as const;
    }
    return enrolment(ctx, totp, id, email, secret);
  });
}

/**
 * A new TOTP secret (lost device, or an enrolment that expired unconfirmed): unconfirmed again
 * with a fresh enrolment time, replay state cleared, the account unlocked and every session of
 * the admin revoked.
 */
export async function resetAdminTotp(ctx: AdminOpsContext, email: string): Promise<TotpEnrolment> {
  const totp = totpSettings(ctx, 'reset-totp');
  const row = await requireAdmin(ctx, email);
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(totp.encryptionKey, row.id, secret);
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    // A fresh credentials row (same password): its created_at is the enrolment time that
    // ADMIN_TOTP_ENROLMENT_TTL_SECONDS counts from while the new secret is unconfirmed.
    const [old] = await tx
      .delete(adminCredentials)
      .where(eq(adminCredentials.userId, row.id))
      .returning({
        passwordHash: adminCredentials.passwordHash,
        mustChangePassword: adminCredentials.mustChangePassword,
      });
    if (old === undefined) throw new AdminOpsError('No ShotX admin with this email');
    await tx.insert(adminCredentials).values({
      userId: row.id,
      passwordHash: old.passwordHash,
      // A temporary password set by an admin stays temporary.
      mustChangePassword: old.mustChangePassword,
      totpSecretEncrypted: encrypted.ciphertext,
      totpSecretNonce: encrypted.nonce,
      createdAt: now,
      updatedAt: now,
    });
    await revokeUserSessions(tx, row.id, now);
    await audit(tx, ctx, 'auth.admin.totp_reset', row.id);
  });
  return enrolment(ctx, totp, row.id, normalizeAdminEmail(email), secret);
}

/** A new password; every session of the admin is revoked. */
export async function resetAdminPassword(
  ctx: AdminOpsContext,
  email: string,
  password: string,
): Promise<void> {
  checkPassword(ctx, password, email.trim());
  const row = await requireAdmin(ctx, email);
  const passwordHash = await hashPassword(password, ctx.argon2id);
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(adminCredentials)
      .set({ passwordHash, failedAttempts: 0, lockedUntil: null, updatedAt: now })
      .where(eq(adminCredentials.userId, row.id));
    await revokeUserSessions(tx, row.id, now);
    await audit(tx, ctx, 'auth.admin.password_reset', row.id);
  });
}

/** Clears the lockout and the failure count. Redis rate-limit windows still run out on their own. */
export async function unlockAdmin(ctx: AdminOpsContext, email: string): Promise<void> {
  const row = await requireAdmin(ctx, email);
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(adminCredentials)
      .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now })
      .where(eq(adminCredentials.userId, row.id));
    await audit(tx, ctx, 'auth.admin.unlocked', row.id);
  });
}
