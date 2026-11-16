import { createHash, createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { userPasswordCredentials, users } from '@shotx/db';
import {
  type AccountStatus,
  type AuthAuditAction,
  type AuthTokenResponse,
  normalizeAccountEmail,
  PHOTOGRAPHER_PASSWORD_RESET_PATH,
  type PhotographerSignInConfig,
  type PhotographerSignInResponse,
} from '@shotx/shared';
import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import type { Db, Queryable } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import {
  ACCOUNT_MAILER,
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  KEY_VALUE_STORE,
  type KeyValueStore,
  RATE_LIMITER,
  type RateLimiter,
  type RateLimitResult,
} from '../tokens';
import { type AccountMailer, passwordResetEmail } from './account-email';
import { markSignedIn, sessionUser, tokenResponse } from './auth.service';
import { hashPassword, verifyPassword } from './password';
import { assertPasswordPolicy, passwordTooWeak } from './password-policy';
import { newOpaqueToken, revokeUserSessions, startSession, writeAuthAudit } from './sessions';
import { SHOTX_AUTH, type ShotxAuth } from './shotx-auth';

// Photographer email + password (ADR 0010): accounts an admin created (users pool, `password:`
// subjects, user_password_credentials). Rate limits per account and per IP, a lockout after
// consecutive failures, one error and one argon2id verification for every wrong email or
// password, and a restricted session (PASSWORD_CHANGE_CLAIM) while the password is temporary.
// ADR 0025: the rate limits and the lockout apply only with PHOTOGRAPHER_LOGIN_LIMITS_ENABLED
// (off by default: nobody is told to wait), and a forgotten password is reset by an emailed link.

/**
 * The account key of rate limits and of audit rows without a known account
 * (`photographer_login` target): `v1:` + base64url(HMAC-SHA256(IP_HASH_SECRET,
 * "photographer-email:" + normalized email)). The email itself is never stored or used as a key.
 */
export function photographerAccountKey(secret: string, email: string): string {
  const mac = createHmac('sha256', secret)
    .update(`photographer-email:${normalizeAccountEmail(email)}`)
    .digest('base64url');
  return `v1:${mac}`;
}

interface PhotographerRow {
  id: string;
  email: string | null;
  name: string | null;
  status: AccountStatus;
  passwordHash: string;
  mustChangePassword: boolean;
  lockedUntil: Date | null;
}

const columns = {
  id: users.id,
  email: users.email,
  name: users.name,
  status: users.status,
  passwordHash: userPasswordCredentials.passwordHash,
  mustChangePassword: userPasswordCredentials.mustChangePassword,
  lockedUntil: userPasswordCredentials.lockedUntil,
};

/** Photographer password accounts only: users pool, `password:` subject, with credentials. */
const passwordAccount = and(
  eq(users.authPool, 'users'),
  eq(users.role, 'photographer'),
  sql`${users.authSubject} LIKE 'password:%'`,
);

/** The photographer password account with this email (ASCII case ignored), or null. */
async function findByEmail(q: Queryable, email: string): Promise<PhotographerRow | null> {
  const [row] = await q
    .select(columns)
    .from(users)
    .innerJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .where(
      and(
        passwordAccount,
        sql`lower(${users.email} COLLATE "C") = lower(${email.trim()} COLLATE "C")`,
      ),
    )
    .limit(1);
  return row ?? null;
}

async function findById(q: Queryable, id: string): Promise<PhotographerRow | null> {
  const [row] = await q
    .select(columns)
    .from(users)
    .innerJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .where(and(passwordAccount, eq(users.id, id)))
    .limit(1);
  return row ?? null;
}

const rateLimited = (retryAfterSeconds: number) =>
  new ApiError('RATE_LIMITED', 'Too many sign-in attempts; try again later', undefined, {
    'Retry-After': String(Math.max(1, retryAfterSeconds)),
  });

const invalidCredentials = () => new ApiError('INVALID_CREDENTIALS', 'Wrong email or password');

type Lockout =
  { kind: 'reserved' } | { kind: 'locked'; retryAfterSeconds: number; justLocked?: boolean };

/**
 * How long consecutive failures of an unknown email are remembered (Redis needs a TTL, ADR 0005);
 * known accounts keep theirs in user_password_credentials.
 */
export const UNKNOWN_PHOTOGRAPHER_FAILURE_TTL_SECONDS = 30 * 24 * 3600;
const unknownFailKey = (account: string) => `auth-photographer:fail:${account}`;
const unknownLockKey = (account: string) => `auth-photographer:locked:${account}`;
const windowKey = (kind: 'ip' | 'acct', id: string) => `auth-photographer:pwd:${kind}:${id}`;

// ADR 0025: password reset. The link token is never stored: Redis keeps its SHA-256 for
// PHOTOGRAPHER_PASSWORD_RESET_TTL_SECONDS, with the account and a fingerprint of the password hash
// it was issued against, so any password change (or admin reset) voids every older link.
const resetTokenKey = (token: string) =>
  `auth-photographer:reset:${createHash('sha256').update(token).digest('base64url')}`;
const resetEmailsKey = (account: string) => `auth-photographer:reset-emails:${account}`;
const RESET_EMAILS_WINDOW_SECONDS = 3600;
const passwordFingerprint = (passwordHash: string) =>
  createHash('sha256').update(passwordHash).digest('base64url').slice(0, 22);

interface ResetGrant {
  u: string;
  f: string;
}

function parseResetGrant(raw: string | null): ResetGrant | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<ResetGrant>;
    return typeof value.u === 'string' && typeof value.f === 'string'
      ? { u: value.u, f: value.f }
      : null;
  } catch {
    return null;
  }
}

const resetInvalid = () =>
  new ApiError('PASSWORD_RESET_INVALID', 'The reset link is invalid, expired or already used');

/**
 * POST /auth/photographer/sign-in and POST /auth/photographer/password. The same pattern as admin
 * sign-in (AdminSignIn): every attempt is counted before it is evaluated, so a burst of parallel
 * guesses never gets more than the limits evaluated, and unknown emails behave exactly like known
 * ones (dummy hash, Redis-kept lockout).
 */
@Injectable()
export class PhotographerSignIn {
  /** A real argon2id hash of a random password, verified for unknown emails (same timing). */
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SHOTX_AUTH) private readonly auth: ShotxAuth | null,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(ACCOUNT_MAILER) private readonly mailer: AccountMailer,
  ) {}

  /** Reset emails still being sent (the request answers before the send; tests await these). */
  private readonly deliveries = new Set<Promise<void>>();

  /** Waits for every reset email in flight (tests). */
  async settled(): Promise<void> {
    await Promise.all([...this.deliveries]);
  }

  /** The issuer and settings, or NOT_FOUND with AUTH_PROVIDER=cognito. */
  private shotx(): { auth: ShotxAuth; settings: PhotographerSignInConfig } {
    if (this.auth === null) throw notFound('Route');
    return { auth: this.auth, settings: this.auth.config.photographer };
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword(newOpaqueToken(), this.config.password.argon2id);
    return this.dummyHash;
  }

  private async reserveWindows(
    settings: PhotographerSignInConfig,
    ipHash: string,
    account: string,
  ): Promise<RateLimitResult> {
    if (!settings.limitsEnabled) return { allowed: true, retryAfterSeconds: 0 };
    const { perIp, perAccount } = settings.rateLimits;
    const [ip, acct] = await Promise.all([
      this.limiter.hit(windowKey('ip', ipHash), perIp.limit, perIp.windowSeconds),
      this.limiter.hit(windowKey('acct', account), perAccount.limit, perAccount.windowSeconds),
    ]);
    return {
      allowed: ip.allowed && acct.allowed,
      retryAfterSeconds: Math.max(
        ip.allowed ? 0 : ip.retryAfterSeconds,
        acct.allowed ? 0 : acct.retryAfterSeconds,
      ),
    };
  }

  private audit(
    q: Queryable,
    action: AuthAuditAction,
    row: { id: string } | null,
    account: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    return writeAuthAudit(q, {
      actorId: row?.id ?? null,
      action,
      targetType: row === null ? 'photographer_login' : 'user',
      targetId: row?.id ?? account,
      meta,
      now: this.clock.now(),
    });
  }

  /**
   * Reserves one attempt against the lockout, atomically and before evaluation (see
   * AdminSignIn.reserveLockout): a conditional UPDATE for known accounts, a Redis counter and lock
   * marker per account HMAC for unknown emails.
   */
  private async reserveLockout(
    settings: PhotographerSignInConfig,
    row: PhotographerRow | null,
    account: string,
  ): Promise<Lockout> {
    if (!settings.limitsEnabled) return { kind: 'reserved' };
    const now = this.clock.now();
    const { threshold, seconds } = settings.lockout;
    const lockedFor = (until: Date | null) => ({
      kind: 'locked' as const,
      retryAfterSeconds: Math.ceil(
        ((until?.getTime() ?? now.getTime() + seconds * 1000) - now.getTime()) / 1000,
      ),
    });
    const until = new Date(now.getTime() + seconds * 1000);
    if (row === null) {
      const marker = await this.store.get(unknownLockKey(account));
      if (marker !== null) return lockedFor(new Date(Number(marker)));
      const reserved = await this.limiter.hit(
        unknownFailKey(account),
        threshold,
        UNKNOWN_PHOTOGRAPHER_FAILURE_TTL_SECONDS,
      );
      if (reserved.allowed) return { kind: 'reserved' };
      await this.store.setWithTtl(unknownLockKey(account), String(until.getTime()), seconds);
      await this.limiter.reset(unknownFailKey(account));
      return { ...lockedFor(until), justLocked: true };
    }
    const c = userPasswordCredentials;
    const pastThreshold = sql`${c.failedAttempts} + 1 > ${threshold}`;
    const [reserved] = await this.db
      .update(c)
      .set({
        failedAttempts: sql`CASE WHEN ${pastThreshold} THEN 0 ELSE ${c.failedAttempts} + 1 END`,
        lockedUntil: sql`CASE WHEN ${pastThreshold} THEN ${until.toISOString()}::timestamptz ELSE ${c.lockedUntil} END`,
        updatedAt: now,
      })
      .where(and(eq(c.userId, row.id), or(isNull(c.lockedUntil), lte(c.lockedUntil, now))))
      .returning({ lockedUntil: c.lockedUntil });
    if (reserved === undefined) return lockedFor(row.lockedUntil);
    if (reserved.lockedUntil?.getTime() === until.getTime()) {
      return { ...lockedFor(until), justLocked: true };
    }
    return { kind: 'reserved' };
  }

  /**
   * After a failed (reserved) attempt: locks the account once its consecutive failures reach
   * PHOTOGRAPHER_LOGIN_LOCKOUT_THRESHOLD and audits the failure (and the lock).
   */
  private async recordFailure(
    settings: PhotographerSignInConfig,
    row: PhotographerRow | null,
    account: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await this.audit(this.db, 'auth.photographer.sign_in_failed', row, account, meta);
    if (!settings.limitsEnabled) return;
    const now = this.clock.now();
    const { threshold, seconds } = settings.lockout;
    const until = new Date(now.getTime() + seconds * 1000);
    let locked = false;
    if (row === null) {
      const full = await this.limiter.peek(
        unknownFailKey(account),
        threshold,
        UNKNOWN_PHOTOGRAPHER_FAILURE_TTL_SECONDS,
      );
      if (!full.allowed) {
        await this.store.setWithTtl(unknownLockKey(account), String(until.getTime()), seconds);
        await this.limiter.reset(unknownFailKey(account));
        locked = true;
      }
    } else {
      const c = userPasswordCredentials;
      const [updated] = await this.db
        .update(c)
        .set({ lockedUntil: until, failedAttempts: 0, updatedAt: now })
        .where(
          and(
            eq(c.userId, row.id),
            gte(c.failedAttempts, threshold),
            or(isNull(c.lockedUntil), lte(c.lockedUntil, now)),
          ),
        )
        .returning({ userId: c.userId });
      locked = updated !== undefined;
    }
    if (locked) {
      await this.audit(this.db, 'auth.photographer.locked', row, account, {
        ...meta,
        until: until.toISOString(),
      });
    }
  }

  /** Hands a reserved attempt back after a correct password (the failure count isn't raised). */
  private async releaseReservation(row: PhotographerRow): Promise<void> {
    if (!this.shotx().settings.limitsEnabled) return;
    const c = userPasswordCredentials;
    await this.db
      .update(c)
      .set({
        failedAttempts: sql`greatest(${c.failedAttempts} - 1, 0)`,
        updatedAt: this.clock.now(),
      })
      .where(eq(c.userId, row.id));
  }

  /**
   * POST /auth/photographer/sign-in. Order: count the attempt per IP and per account (refused:
   * RATE_LIMITED), reserve it against the lockout (locked: RATE_LIMITED, unknown emails too), one
   * argon2id verification (a dummy hash for unknown emails). Wrong email or password, or an
   * account without password credentials: INVALID_CREDENTIALS. A disabled account with the right
   * password: ACCOUNT_DISABLED. Success clears the failure count and the account window, sets
   * `last_sign_in_at` and starts a session: a normal one, or a restricted one
   * (PASSWORD_CHANGE_CLAIM, PHOTOGRAPHER_PASSWORD_CHANGE_SESSION_TTL_SECONDS) while the password
   * is temporary.
   */
  async signIn(
    email: string,
    password: string,
    ipHash: string,
  ): Promise<PhotographerSignInResponse> {
    const { auth, settings } = this.shotx();
    const account = photographerAccountKey(this.config.consent.ipHashSecret, email);
    const limits = await this.reserveWindows(settings, ipHash, account);
    const row = await findByEmail(this.db, email);
    if (!limits.allowed) {
      await this.audit(this.db, 'auth.photographer.sign_in_failed', row, account, {
        reason: 'rate_limited',
        ipHash,
      });
      throw rateLimited(limits.retryAfterSeconds);
    }
    const lockout = await this.reserveLockout(settings, row, account);
    if (lockout.kind === 'locked') {
      if (lockout.justLocked === true) {
        await this.audit(this.db, 'auth.photographer.locked', row, account, { ipHash });
      }
      await this.audit(this.db, 'auth.photographer.sign_in_failed', row, account, {
        reason: 'locked',
        ipHash,
      });
      throw rateLimited(lockout.retryAfterSeconds);
    }
    const passwordOk = await verifyPassword(password, row?.passwordHash ?? (await this.dummy()));
    if (row === null || !passwordOk) {
      await this.recordFailure(settings, row, account, { reason: 'invalid_credentials', ipHash });
      throw invalidCredentials();
    }
    if (row.status !== 'active') {
      await this.releaseReservation(row);
      await this.audit(this.db, 'auth.photographer.sign_in_disabled', row, account, { ipHash });
      throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled');
    }

    const now = this.clock.now();
    const restricted = row.mustChangePassword;
    const ttlSeconds = restricted
      ? settings.passwordChangeSessionTtlSeconds
      : auth.config.pools.users.refreshTokenTtlSeconds;
    const { session, user } = await this.db.transaction(async (tx) => {
      await tx
        .update(userPasswordCredentials)
        .set({ failedAttempts: 0, lockedUntil: null, updatedAt: now })
        .where(eq(userPasswordCredentials.userId, row.id));
      await markSignedIn(tx, row.id, now);
      await this.audit(tx, 'auth.photographer.sign_in', row, account, {
        ipHash,
        amr: ['pwd'],
        passwordChangeRequired: restricted,
      });
      return {
        session: await startSession(tx, {
          userId: row.id,
          pool: 'users',
          now,
          ttlSeconds,
          amr: ['pwd'],
        }),
        user: await sessionUser(tx, row.id),
      };
    });
    await this.limiter.reset(windowKey('acct', account));
    const tokens = await tokenResponse(auth, 'users', user, session, ['pwd'], now, {
      passwordChange: restricted,
    });
    return { ...tokens, step: restricted ? 'change_password' : 'signed_in' };
  }

  /**
   * POST /auth/photographer/password: the forced first change (restricted session) and any later
   * one. The current password is checked like a sign-in attempt against the lockout (locked:
   * RATE_LIMITED; wrong: PASSWORD_INCORRECT, counted), then the policy (PASSWORD_TOO_WEAK). In one
   * transaction: the new hash, `must_change_password = false`, `password_changed_at`, every
   * session of the account revoked (this one too), a new normal session and the audit row.
   * Accounts without password credentials (LINE/Google photographers) are FORBIDDEN.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ipHash: string,
  ): Promise<AuthTokenResponse> {
    const { auth, settings } = this.shotx();
    const row = await findById(this.db, userId);
    if (row === null) throw new ApiError('FORBIDDEN', 'This account has no password');
    if (row.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled');
    const account = photographerAccountKey(this.config.consent.ipHashSecret, row.email ?? row.id);
    const lockout = await this.reserveLockout(settings, row, account);
    if (lockout.kind === 'locked') {
      if (lockout.justLocked === true) {
        await this.audit(this.db, 'auth.photographer.locked', row, account, { ipHash });
      }
      throw rateLimited(lockout.retryAfterSeconds);
    }
    if (!(await verifyPassword(currentPassword, row.passwordHash))) {
      await this.recordFailure(settings, row, account, {
        reason: 'password_incorrect',
        route: 'change_password',
        ipHash,
      });
      throw new ApiError('PASSWORD_INCORRECT', 'The current password is wrong');
    }
    await this.releaseReservation(row);
    await assertPasswordPolicy(newPassword, {
      minLength: settings.passwordMinLength,
      email: row.email,
    });
    // The current password is verified, so same_as_current needs no second hash check (both
    // sides NFC-normalized, as hashPassword does).
    if (newPassword.normalize('NFC') === currentPassword.normalize('NFC')) {
      throw passwordTooWeak('same_as_current', settings.passwordMinLength);
    }
    const passwordHash = await hashPassword(newPassword, this.config.password.argon2id);
    const now = this.clock.now();
    const outcome = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ passwordHash: userPasswordCredentials.passwordHash, status: users.status })
        .from(userPasswordCredentials)
        .innerJoin(users, eq(users.id, userPasswordCredentials.userId))
        .where(eq(userPasswordCredentials.userId, row.id))
        .for('update', { of: userPasswordCredentials })
        .limit(1);
      // Changed (or reset) meanwhile, or disabled: the current password no longer holds.
      if (locked === undefined || locked.passwordHash !== row.passwordHash) return null;
      if (locked.status !== 'active') return 'disabled' as const;
      await tx
        .update(userPasswordCredentials)
        .set({
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: now,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(userPasswordCredentials.userId, row.id));
      const revokedSessions = await revokeUserSessions(tx, row.id, now);
      await this.audit(tx, 'auth.photographer.password_changed', row, account, {
        ipHash,
        forced: row.mustChangePassword,
        revokedSessions,
      });
      return {
        session: await startSession(tx, {
          userId: row.id,
          pool: 'users',
          now,
          ttlSeconds: auth.config.pools.users.refreshTokenTtlSeconds,
          amr: ['pwd'],
        }),
        user: await sessionUser(tx, row.id),
      };
    });
    if (outcome === 'disabled') throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled');
    if (outcome === null) throw new ApiError('PASSWORD_INCORRECT', 'The current password is wrong');
    return tokenResponse(auth, 'users', outcome.user, outcome.session, ['pwd'], now);
  }

  // --- Password reset by email (ADR 0025) --------------------------------------------------------

  private requireMailer(): void {
    if (!this.mailer.available) {
      throw new ApiError('FEATURE_DISABLED', 'Password reset by email is not available');
    }
  }

  /**
   * POST /auth/photographer/password-reset/request. Answers the same (nothing) for every email:
   * an active photographer password account gets a one-time link (unless it already got
   * PHOTOGRAPHER_PASSWORD_RESET_EMAILS_PER_HOUR this hour); unknown and disabled accounts get
   * nothing. The email is sent after the answer, so the timing doesn't tell either. Audited.
   */
  async requestPasswordReset(email: string, ipHash: string): Promise<void> {
    const { settings } = this.shotx();
    this.requireMailer();
    const account = photographerAccountKey(this.config.consent.ipHashSecret, email);
    const row = await findByEmail(this.db, email);
    const audit = (outcome: string) =>
      this.audit(this.db, 'auth.photographer.password_reset_requested', row, account, {
        outcome,
        ipHash,
      });
    if (row === null || row.email === null) return audit('no_account');
    if (row.status !== 'active') return audit('disabled');
    const quota = await this.limiter.hit(
      resetEmailsKey(account),
      settings.passwordReset.emailsPerHour,
      RESET_EMAILS_WINDOW_SECONDS,
    );
    if (!quota.allowed) return audit('throttled');

    const { key, link } = await this.issueResetToken(row, settings.passwordReset.ttlSeconds);
    const message = passwordResetEmail({
      to: row.email,
      name: row.name,
      link,
      ttlMinutes: Math.round(settings.passwordReset.ttlSeconds / 60),
    });
    const delivery = this.mailer
      .send(message)
      .then(() => audit('sent'))
      .catch(async () => {
        // The link never arrived: drop it, and record the failure (never the address or link).
        await this.store.del(key).catch(() => undefined);
        await audit('send_failed').catch(() => undefined);
      })
      .finally(() => this.deliveries.delete(delivery));
    this.deliveries.add(delivery);
  }

  /**
   * Stores a one-time reset grant for `row` (SHA-256 of the token, the account and the fingerprint
   * of its current password hash) for `ttlSeconds`, and returns its Redis key and the link
   * (PUBLIC_BASE_URL + PHOTOGRAPHER_PASSWORD_RESET_PATH + `#token=`). The token itself is only in
   * the link; never log it.
   */
  private async issueResetToken(
    row: { id: string; passwordHash: string },
    ttlSeconds: number,
  ): Promise<{ key: string; link: string }> {
    const token = newOpaqueToken();
    const key = resetTokenKey(token);
    const grant: ResetGrant = { u: row.id, f: passwordFingerprint(row.passwordHash) };
    await this.store.setWithTtl(key, JSON.stringify(grant), ttlSeconds);
    const link = `${new URL(this.config.app.publicBaseUrl).origin}${PHOTOGRAPHER_PASSWORD_RESET_PATH}#token=${token}`;
    return { key, link };
  }

  /**
   * ADR 0026: a "ตั้งรหัสผ่าน" link for an account a paid order created: the ADR 0025 reset token
   * (same page, same confirm route, same single use) with its own TTL
   * (PACKAGE_SET_PASSWORD_TTL_SECONDS). Null unless `userId` is an active photographer password
   * account. `discard` drops the grant (when its email couldn't be sent).
   */
  async issuePasswordSetLink(
    userId: string,
    ttlSeconds: number,
  ): Promise<{ link: string; discard: () => Promise<void> } | null> {
    const row = await findById(this.db, userId);
    if (row === null || row.status !== 'active') return null;
    const { key, link } = await this.issueResetToken(row, ttlSeconds);
    return { link, discard: () => this.store.del(key) };
  }

  /**
   * POST /auth/photographer/password-reset/confirm. The token must be live, for an active
   * account whose password hasn't changed since it was issued (else PASSWORD_RESET_INVALID); the
   * new password must pass the policy (else PASSWORD_TOO_WEAK, and the token stays usable). Then
   * the token is used up and, in one transaction: the new hash, `must_change_password = false`,
   * the lockout cleared, every session revoked, the audit row and a new normal session.
   */
  async confirmPasswordReset(
    token: string,
    newPassword: string,
    ipHash: string,
  ): Promise<AuthTokenResponse> {
    const { auth, settings } = this.shotx();
    this.requireMailer();
    const key = resetTokenKey(token);
    const grant = parseResetGrant(await this.store.get(key));
    if (grant === null) throw resetInvalid();
    const row = await findById(this.db, grant.u);
    if (
      row === null ||
      row.status !== 'active' ||
      passwordFingerprint(row.passwordHash) !== grant.f
    ) {
      await this.store.del(key);
      throw resetInvalid();
    }
    await assertPasswordPolicy(newPassword, {
      minLength: settings.passwordMinLength,
      email: row.email,
    });
    // One use, even when two tabs submit at once.
    if ((await this.store.take(key)) === null) throw resetInvalid();

    const passwordHash = await hashPassword(newPassword, this.config.password.argon2id);
    const now = this.clock.now();
    const account = photographerAccountKey(this.config.consent.ipHashSecret, row.email ?? row.id);
    const outcome = await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ passwordHash: userPasswordCredentials.passwordHash, status: users.status })
        .from(userPasswordCredentials)
        .innerJoin(users, eq(users.id, userPasswordCredentials.userId))
        .where(eq(userPasswordCredentials.userId, row.id))
        .for('update', { of: userPasswordCredentials })
        .limit(1);
      if (
        locked === undefined ||
        locked.status !== 'active' ||
        locked.passwordHash !== row.passwordHash
      ) {
        return null;
      }
      await tx
        .update(userPasswordCredentials)
        .set({
          passwordHash,
          mustChangePassword: false,
          passwordChangedAt: now,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
        })
        .where(eq(userPasswordCredentials.userId, row.id));
      const revokedSessions = await revokeUserSessions(tx, row.id, now);
      await markSignedIn(tx, row.id, now);
      await this.audit(tx, 'auth.photographer.password_reset', row, account, {
        ipHash,
        revokedSessions,
      });
      return {
        session: await startSession(tx, {
          userId: row.id,
          pool: 'users',
          now,
          ttlSeconds: auth.config.pools.users.refreshTokenTtlSeconds,
          amr: ['pwd'],
        }),
        user: await sessionUser(tx, row.id),
      };
    });
    if (outcome === null) throw resetInvalid();
    return tokenResponse(auth, 'users', outcome.user, outcome.session, ['pwd'], now);
  }
}
