import { adminCredentials, auditLog, users } from '@shotx/db';
import {
  type AdminSignInConfig,
  type Argon2idParams,
  type AuthAuditAction,
  authSubject,
  AUTH_SUBJECT_MAX_LENGTH,
} from '@shotx/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { findAdminByEmail, normalizeAdminEmail } from '../auth/admin-sign-in';
import { hashPassword } from '../auth/password';
import { revokeUserSessions } from '../auth/sessions';
import { base32Encode, encryptTotpSecret, generateTotpSecret, otpauthUri } from '../auth/totp';
import type { Db, Queryable } from '../db/db';
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
  userId: string;
  subject: string;
  otpauthUri: string;
  /** The same secret in base32, for manual entry. */
  secretBase32: string;
}

function checkPassword(ctx: AdminOpsContext, password: string): void {
  if (password.length < ctx.admin.passwordMinLength) {
    throw new AdminOpsError(`Password must be at least ${ctx.admin.passwordMinLength} characters`);
  }
  if (password.length > 1024) throw new AdminOpsError('Password must be at most 1024 characters');
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
  userId: string,
  email: string,
  secret: Buffer,
): TotpEnrolment {
  return {
    userId,
    subject: authSubject('admin', userId),
    otpauthUri: otpauthUri({
      issuer: ctx.stage === 'prod' ? 'ShotX Admin' : `ShotX Admin (${ctx.stage})`,
      account: email,
      secret,
      digits: ctx.admin.totp.digits,
      periodSeconds: ctx.admin.totp.periodSeconds,
    }),
    secretBase32: base32Encode(secret),
  };
}

async function requireAdmin(ctx: AdminOpsContext, email: string) {
  const row = await findAdminByEmail(ctx.db, email);
  if (row === null) throw new AdminOpsError('No ShotX admin with this email');
  return row;
}

/**
 * Creates an admin: a `users` row in the admins pool (role admin, subject `admin:<users.id>`) and
 * its credentials, in one transaction. TOTP stays unconfirmed (`totp_confirmed_at` null) until
 * the first valid code at sign-in.
 */
export async function createAdmin(
  ctx: AdminOpsContext,
  input: { email: string; name: string; password: string },
): Promise<TotpEnrolment> {
  const email = emailSchema.safeParse(input.email.trim());
  if (!email.success) throw new AdminOpsError('Invalid email');
  const name = nameSchema.safeParse(input.name);
  if (!name.success) throw new AdminOpsError('Invalid name (1-200 characters)');
  checkPassword(ctx, input.password);
  if ((await findAdminByEmail(ctx.db, email.data)) !== null) {
    throw new AdminOpsError('An admin with this email already exists');
  }
  const passwordHash = await hashPassword(input.password, ctx.argon2id);
  const secret = generateTotpSecret();
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const id = await newId(tx);
    const subject = authSubject('admin', id);
    if (subject.length > AUTH_SUBJECT_MAX_LENGTH) throw new Error('Subject too long');
    await tx.insert(users).values({
      id,
      authPool: 'admins',
      authSubject: subject,
      role: 'admin',
      email: email.data,
      name: name.data,
      createdAt: now,
    });
    const encrypted = encryptTotpSecret(ctx.admin.totp.encryptionKey, id, secret);
    await tx.insert(adminCredentials).values({
      userId: id,
      passwordHash,
      totpSecretEncrypted: encrypted.ciphertext,
      totpSecretNonce: encrypted.nonce,
      createdAt: now,
      updatedAt: now,
    });
    await audit(tx, ctx, 'auth.admin.created', id);
    return enrolment(ctx, id, email.data, secret);
  });
}

/**
 * A new TOTP secret (lost device, or an enrolment that expired unconfirmed): unconfirmed again
 * with a fresh enrolment time, replay state cleared, the account unlocked and every session of
 * the admin revoked.
 */
export async function resetAdminTotp(ctx: AdminOpsContext, email: string): Promise<TotpEnrolment> {
  const row = await requireAdmin(ctx, email);
  const secret = generateTotpSecret();
  const encrypted = encryptTotpSecret(ctx.admin.totp.encryptionKey, row.id, secret);
  const now = ctx.now();
  await ctx.db.transaction(async (tx) => {
    // A fresh credentials row (same password): its created_at is the enrolment time that
    // ADMIN_TOTP_ENROLMENT_TTL_SECONDS counts from while the new secret is unconfirmed.
    const [old] = await tx
      .delete(adminCredentials)
      .where(eq(adminCredentials.userId, row.id))
      .returning({ passwordHash: adminCredentials.passwordHash });
    if (old === undefined) throw new AdminOpsError('No ShotX admin with this email');
    await tx.insert(adminCredentials).values({
      userId: row.id,
      passwordHash: old.passwordHash,
      totpSecretEncrypted: encrypted.ciphertext,
      totpSecretNonce: encrypted.nonce,
      createdAt: now,
      updatedAt: now,
    });
    await revokeUserSessions(tx, row.id, now);
    await audit(tx, ctx, 'auth.admin.totp_reset', row.id);
  });
  return enrolment(ctx, row.id, normalizeAdminEmail(email), secret);
}

/** A new password; every session of the admin is revoked. */
export async function resetAdminPassword(
  ctx: AdminOpsContext,
  email: string,
  password: string,
): Promise<void> {
  checkPassword(ctx, password);
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
