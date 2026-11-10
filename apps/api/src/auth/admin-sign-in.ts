import { createHmac } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { adminCredentials, users } from '@shotx/db';
import {
  ADMIN_SIGN_IN_STEPS,
  type AccountStatus,
  type AdminChangePasswordResponse,
  type AdminLoginResponse,
  type AdminSignInConfig,
  type AdminSignInStep,
  type AuthAuditAction,
  type AuthTokenResponse,
  normalizeAccountEmail,
} from '@shotx/shared';
import { and, eq, gte, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ApiConfig } from '../config';
import type { Db, Queryable } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { sha256Hex } from '../http/client';
import {
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
import { markSignedIn, parseJson, sessionUser, tokenResponse } from './auth.service';
import { hashPassword, verifyPassword } from './password';
import { assertPasswordPolicy } from './password-policy';
import { newOpaqueToken, startSession, writeAuthAudit } from './sessions';
import { SHOTX_AUTH, type ShotxAuth } from './shotx-auth';
import {
  adminTotpIssuer,
  decryptTotpSecret,
  encryptTotpSecret,
  generateTotpSecret,
  matchTotp,
  otpauthUri,
} from './totp';

// Admin sign-in (ADR 0008 section 4, ADR 0010): email + password (argon2id), then one-time
// challenges in Redis for the steps (ADMIN_SIGN_IN_STEPS: change a temporary password, enrol
// TOTP, enter the code). Admins-pool tokens are issued only by verifyMfa, with amr pwd + otp +
// mfa, and only verifyMfa writes what the earlier steps changed (new password hash, new TOTP
// secret), in one transaction.

/** Admin email as accounts are keyed: trimmed, ASCII-lowercased (users_admin_email_unique). */
export const normalizeAdminEmail = normalizeAccountEmail;

/**
 * The account key of rate limits and of audit rows without a known account (`admin_login`
 * target): `v1:` + base64url(HMAC-SHA256(IP_HASH_SECRET, "admin-email:" + normalized email)).
 * The email itself is never stored or used as a key.
 */
export function adminAccountKey(secret: string, email: string): string {
  const mac = createHmac('sha256', secret)
    .update(`admin-email:${normalizeAdminEmail(email)}`)
    .digest('base64url');
  return `v1:${mac}`;
}

/** Redis key of a pending MFA step (the challenge id is stored hashed). */
export const adminChallengeKey = (challengeId: string) =>
  `auth:admin-mfa:${sha256Hex(challengeId)}`;

/**
 * A pending sign-in step in Redis. `pwdFp`: SHA-256 of the password hash the sign-in verified, so
 * a password reset (or change) in between ends the sign-in. `newPasswordHash`: the argon2id hash
 * of the password chosen at the `change_password` step; `enrolment`: the TOTP secret generated
 * for the `enrol_totp` step, AES-256-GCM under ADMIN_TOTP_ENCRYPTION_KEY with the user id as AAD
 * (like admin_credentials). Both are stored only by a successful verifyMfa.
 */
const challengeSchema = z.object({
  userId: z.uuid(),
  account: z.string().min(1),
  step: z.enum(ADMIN_SIGN_IN_STEPS),
  pwdFp: z.string().regex(/^[0-9a-f]{64}$/),
  newPasswordHash: z.string().startsWith('$argon2id$').optional(),
  enrolment: z.object({ ciphertext: z.base64url(), nonce: z.base64url() }).optional(),
});
type Challenge = z.output<typeof challengeSchema>;

const loginStateInvalid = () => new ApiError('LOGIN_STATE_INVALID', 'Sign-in expired; start again');
const accountDisabled = () => new ApiError('ACCOUNT_DISABLED', 'This account is disabled');

interface AdminRow {
  id: string;
  authSubject: string;
  email: string | null;
  status: AccountStatus;
  passwordHash: string;
  /** Null for an admin created in the admin app until a sign-in enrols TOTP (ADR 0010). */
  totpSecretEncrypted: Buffer | null;
  totpSecretNonce: Buffer | null;
  totpConfirmedAt: Date | null;
  /** The password is temporary (admin-app creation or reset): the first step changes it. */
  mustChangePassword: boolean;
  totpLastUsedStep: number | null;
  lockedUntil: Date | null;
  /**
   * admin_credentials.created_at: while TOTP is unconfirmed, when the current secret was enrolled
   * (create and reset-totp both write a fresh row; see cli/admin-ops).
   */
  credentialsCreatedAt: Date;
}

const adminColumns = {
  id: users.id,
  authSubject: users.authSubject,
  email: users.email,
  status: users.status,
  passwordHash: adminCredentials.passwordHash,
  totpSecretEncrypted: adminCredentials.totpSecretEncrypted,
  totpSecretNonce: adminCredentials.totpSecretNonce,
  totpConfirmedAt: adminCredentials.totpConfirmedAt,
  mustChangePassword: adminCredentials.mustChangePassword,
  totpLastUsedStep: adminCredentials.totpLastUsedStep,
  lockedUntil: adminCredentials.lockedUntil,
  credentialsCreatedAt: adminCredentials.createdAt,
};

/** ShotX admins only: admins pool, `admin:` subject, with credentials. */
const shotxAdmin = and(eq(users.authPool, 'admins'), sql`${users.authSubject} LIKE 'admin:%'`);

/** The admin with this email (case-insensitive like users_admin_email_unique), or null. */
export async function findAdminByEmail(q: Queryable, email: string): Promise<AdminRow | null> {
  const [row] = await q
    .select(adminColumns)
    .from(users)
    .innerJoin(adminCredentials, eq(adminCredentials.userId, users.id))
    .where(
      and(shotxAdmin, sql`lower(${users.email} COLLATE "C") = lower(${email.trim()} COLLATE "C")`),
    )
    .limit(1);
  return row ?? null;
}

export async function findAdminById(q: Queryable, id: string): Promise<AdminRow | null> {
  const [row] = await q
    .select(adminColumns)
    .from(users)
    .innerJoin(adminCredentials, eq(adminCredentials.userId, users.id))
    .where(and(shotxAdmin, eq(users.id, id)))
    .limit(1);
  return row ?? null;
}

const rateLimited = (retryAfterSeconds: number) =>
  new ApiError('RATE_LIMITED', 'Too many sign-in attempts; try again later', undefined, {
    'Retry-After': String(Math.max(1, retryAfterSeconds)),
  });

/** The two sign-in steps; each has its own rate-limit windows. */
type Step = 'pwd' | 'otp';

type Lockout =
  | { kind: 'reserved' }
  /** `justLocked`: this reservation applied the lock (audit `auth.admin.locked`). */
  | { kind: 'locked'; retryAfterSeconds: number; justLocked?: boolean };

/**
 * How long consecutive failures of an unknown email are remembered. Known accounts keep theirs
 * in admin_credentials without expiry; this only has to outlast any realistic guessing pause so
 * both behave alike (every Redis key needs a TTL, ADR 0005).
 */
export const UNKNOWN_ACCOUNT_FAILURE_TTL_SECONDS = 30 * 24 * 3600;
const unknownFailKey = (account: string) => `auth-admin:fail:${account}`;
const unknownLockKey = (account: string) => `auth-admin:locked:${account}`;

const invalidCredentials = () => new ApiError('INVALID_CREDENTIALS', 'Wrong email or password');

/** The fingerprint of a password hash a challenge is bound to. */
const passwordFingerprint = (hash: string) => sha256Hex(hash);

/** Admin sign-in: POST /auth/admin/login, POST /auth/admin/password and POST /auth/admin/mfa. */
@Injectable()
export class AdminSignIn {
  /** A real argon2id hash of a random password, verified for unknown emails (same timing). */
  private dummyHash: Promise<string> | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SHOTX_AUTH) private readonly auth: ShotxAuth | null,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(RATE_LIMITER) private readonly limiter: RateLimiter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** The issuer and admin settings, or NOT_FOUND when admin sign-in is off here. */
  private admin(): { auth: ShotxAuth; settings: AdminSignInConfig } {
    const auth = this.auth;
    if (auth === null || auth.config.admin === null || !auth.issuer.poolEnabled('admins')) {
      throw notFound('Route');
    }
    return { auth, settings: auth.config.admin };
  }

  private dummy(): Promise<string> {
    this.dummyHash ??= hashPassword(newOpaqueToken(), this.config.password.argon2id);
    return this.dummyHash;
  }

  /** Rate-limit window keys, per sign-in step (password, code) and per IP or account. */
  private windowKey = (step: Step, kind: 'ip' | 'acct', id: string) =>
    `auth-admin:${step}:${kind}:${id}`;

  /**
   * Counts this attempt in both windows of its step before anything is evaluated (atomic INCR;
   * the post-increment count decides), so a burst of parallel requests gets at most the limit
   * evaluated. Successes count too; a completed sign-in resets the account's windows.
   */
  private async reserveWindows(
    settings: AdminSignInConfig,
    step: Step,
    ipHash: string,
    account: string,
  ): Promise<RateLimitResult> {
    const { perIp, perAccount } = settings.rateLimits;
    const [ip, acct] = await Promise.all([
      this.limiter.hit(this.windowKey(step, 'ip', ipHash), perIp.limit, perIp.windowSeconds),
      this.limiter.hit(
        this.windowKey(step, 'acct', account),
        perAccount.limit,
        perAccount.windowSeconds,
      ),
    ]);
    return {
      allowed: ip.allowed && acct.allowed,
      retryAfterSeconds: Math.max(
        ip.allowed ? 0 : ip.retryAfterSeconds,
        acct.allowed ? 0 : acct.retryAfterSeconds,
      ),
    };
  }

  /** The account window of `step` is used up (the next attempt would be refused). */
  private async accountWindowFull(
    settings: AdminSignInConfig,
    step: Step,
    account: string,
  ): Promise<boolean> {
    const { perAccount } = settings.rateLimits;
    const result = await this.limiter.peek(
      this.windowKey(step, 'acct', account),
      perAccount.limit,
      perAccount.windowSeconds,
    );
    return !result.allowed;
  }

  private audit(
    action: AuthAuditAction,
    row: { id: string } | null,
    account: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    return writeAuthAudit(this.db, {
      actorId: row?.id ?? null,
      action,
      targetType: row === null ? 'admin_login' : 'user',
      targetId: row?.id ?? account,
      meta,
      now: this.clock.now(),
    });
  }

  /**
   * Reserves one attempt against the lockout, atomically and before evaluation. Known accounts:
   * `UPDATE ... SET failed_attempts = failed_attempts + 1 ... RETURNING`, refused while
   * `locked_until` is in the future. Unknown emails get the same behaviour from a Redis counter
   * per account HMAC (UNKNOWN_ACCOUNT_FAILURE_TTL_SECONDS) and a lock marker, so a lockout never
   * tells a real admin email from an unknown one. Attempts past the threshold are refused as
   * locked without being evaluated.
   */
  private async reserveLockout(
    settings: AdminSignInConfig,
    row: AdminRow | null,
    account: string,
  ): Promise<Lockout> {
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
        UNKNOWN_ACCOUNT_FAILURE_TTL_SECONDS,
      );
      if (reserved.allowed) return { kind: 'reserved' };
      // Past the threshold without a lock (a lost race): lock now, so the refusal expires.
      await this.store.setWithTtl(unknownLockKey(account), String(until.getTime()), seconds);
      await this.limiter.reset(unknownFailKey(account));
      return { ...lockedFor(until), justLocked: true };
    }
    // One statement: count the attempt, or, when that would pass the threshold (concurrent
    // attempts reserved the remaining ones), lock the account with an expiry and restart the
    // count, so a refusal is never left without a lock that ends.
    const pastThreshold = sql`${adminCredentials.failedAttempts} + 1 > ${threshold}`;
    const [reserved] = await this.db
      .update(adminCredentials)
      .set({
        failedAttempts: sql`CASE WHEN ${pastThreshold} THEN 0 ELSE ${adminCredentials.failedAttempts} + 1 END`,
        lockedUntil: sql`CASE WHEN ${pastThreshold} THEN ${until.toISOString()}::timestamptz ELSE ${adminCredentials.lockedUntil} END`,
        updatedAt: now,
      })
      .where(
        and(
          eq(adminCredentials.userId, row.id),
          or(isNull(adminCredentials.lockedUntil), lte(adminCredentials.lockedUntil, now)),
        ),
      )
      .returning({ lockedUntil: adminCredentials.lockedUntil });
    if (reserved === undefined) return lockedFor(row.lockedUntil);
    if (reserved.lockedUntil?.getTime() === until.getTime()) {
      return { ...lockedFor(until), justLocked: true };
    }
    return { kind: 'reserved' };
  }

  /**
   * After a failed (reserved) attempt: locks the account when its consecutive failures reached
   * ADMIN_LOGIN_LOCKOUT_THRESHOLD (restarting the count), audits the failure and the lock.
   * Returns whether the account is now locked.
   */
  private async recordFailure(
    settings: AdminSignInConfig,
    row: AdminRow | null,
    account: string,
    ipHash: string,
    action: 'auth.admin.sign_in_failed' | 'auth.admin.mfa_failed',
    reason: string,
  ): Promise<boolean> {
    await this.audit(action, row, account, { reason, ipHash });
    const now = this.clock.now();
    const { threshold, seconds } = settings.lockout;
    const until = new Date(now.getTime() + seconds * 1000);
    let locked = false;
    if (row === null) {
      const full = await this.limiter.peek(
        unknownFailKey(account),
        threshold,
        UNKNOWN_ACCOUNT_FAILURE_TTL_SECONDS,
      );
      if (!full.allowed) {
        await this.store.setWithTtl(unknownLockKey(account), String(until.getTime()), seconds);
        await this.limiter.reset(unknownFailKey(account));
        locked = true;
      }
    } else {
      const [updated] = await this.db
        .update(adminCredentials)
        .set({ lockedUntil: until, failedAttempts: 0, updatedAt: now })
        .where(
          and(
            eq(adminCredentials.userId, row.id),
            gte(adminCredentials.failedAttempts, threshold),
            or(isNull(adminCredentials.lockedUntil), lte(adminCredentials.lockedUntil, now)),
          ),
        )
        .returning({ userId: adminCredentials.userId });
      locked = updated !== undefined;
    }
    if (locked) {
      await this.audit('auth.admin.locked', row, account, { ipHash, until: until.toISOString() });
    }
    return locked;
  }

  /**
   * Step 1. Order: count the attempt in the password windows (refused: RATE_LIMITED), reserve
   * it against the lockout (locked: RATE_LIMITED, for unknown emails too), then one argon2id
   * verification (a dummy hash for unknown emails, so timing never reveals whether an admin
   * exists). Wrong email or password: INVALID_CREDENTIALS. A correct password hands back its
   * lockout reservation; only the TOTP step clears the count.
   */
  async login(email: string, password: string, ipHash: string): Promise<AdminLoginResponse> {
    const { settings } = this.admin();
    const account = adminAccountKey(this.config.consent.ipHashSecret, email);
    const limits = await this.reserveWindows(settings, 'pwd', ipHash, account);
    const row = await findAdminByEmail(this.db, email);
    if (!limits.allowed) {
      await this.audit('auth.admin.sign_in_failed', row, account, {
        reason: 'rate_limited',
        ipHash,
      });
      throw rateLimited(limits.retryAfterSeconds);
    }
    const lockout = await this.reserveLockout(settings, row, account);
    if (lockout.kind === 'locked') {
      if (lockout.justLocked === true) {
        await this.audit('auth.admin.locked', row, account, { ipHash });
      }
      await this.audit('auth.admin.sign_in_failed', row, account, { reason: 'locked', ipHash });
      throw rateLimited(lockout.retryAfterSeconds);
    }
    const passwordOk = await verifyPassword(password, row?.passwordHash ?? (await this.dummy()));
    if (row === null || !passwordOk) {
      await this.recordFailure(
        settings,
        row,
        account,
        ipHash,
        'auth.admin.sign_in_failed',
        'invalid_credentials',
      );
      throw invalidCredentials();
    }
    await this.db
      .update(adminCredentials)
      .set({
        failedAttempts: sql`greatest(${adminCredentials.failedAttempts} - 1, 0)`,
        updatedAt: this.clock.now(),
      })
      .where(eq(adminCredentials.userId, row.id));
    // Only after the password was verified, so it reveals nothing to someone without it.
    if (row.status !== 'active') {
      await this.audit('auth.admin.sign_in_failed', row, account, {
        reason: 'account_disabled',
        ipHash,
      });
      throw accountDisabled();
    }
    const base = { userId: row.id, account, pwdFp: passwordFingerprint(row.passwordHash) };
    if (row.mustChangePassword) {
      return this.issueChallenge(settings, { ...base, step: 'change_password' });
    }
    return this.nextCodeStep(settings, base, row, ipHash);
  }

  /**
   * The step after the password (and after a password change): `enrol_totp` with a new secret
   * for an account without one (UI-created admins), else `totp`.
   */
  private async nextCodeStep(
    settings: AdminSignInConfig,
    base: Pick<Challenge, 'userId' | 'account' | 'pwdFp' | 'newPasswordHash'>,
    row: AdminRow,
    ipHash: string,
  ): Promise<Extract<AdminLoginResponse, { step: 'enrol_totp' | 'totp' }>> {
    if (row.totpSecretEncrypted !== null) {
      return this.issueChallenge(settings, { ...base, step: 'totp' });
    }
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(settings.totp.encryptionKey, row.id, secret);
    const uri = otpauthUri({
      issuer: adminTotpIssuer(this.config.app.stage),
      account: row.email ?? row.id,
      secret,
      digits: settings.totp.digits,
      periodSeconds: settings.totp.periodSeconds,
    });
    secret.fill(0);
    const response = await this.issueChallenge(settings, {
      ...base,
      step: 'enrol_totp',
      enrolment: {
        ciphertext: encrypted.ciphertext.toString('base64url'),
        nonce: encrypted.nonce.toString('base64url'),
      },
    });
    await this.audit('auth.admin.totp_enrolment_started', row, base.account, { ipHash });
    return { ...response, step: 'enrol_totp', otpauthUri: uri };
  }

  /** Stores a fresh one-time challenge for `challenge.step` and answers it. */
  private async issueChallenge<S extends AdminSignInStep>(
    settings: AdminSignInConfig,
    challenge: Challenge & { step: S },
  ): Promise<{ step: S; challengeId: string; expiresIn: number }> {
    const challengeId = newOpaqueToken();
    await this.store.setWithTtl(
      adminChallengeKey(challengeId),
      JSON.stringify(challenge),
      settings.challengeTtlSeconds,
    );
    return { step: challenge.step, challengeId, expiresIn: settings.challengeTtlSeconds };
  }

  /** The challenge of `challengeId` if it is for one of `steps`, else LOGIN_STATE_INVALID. */
  private async readChallenge(
    challengeId: string,
    steps: readonly AdminSignInStep[],
  ): Promise<{ key: string; challenge: Challenge }> {
    const key = adminChallengeKey(challengeId);
    const parsed = challengeSchema.safeParse(parseJson(await this.store.get(key)));
    if (!parsed.success || !steps.includes(parsed.data.step)) throw loginStateInvalid();
    return { key, challenge: parsed.data };
  }

  /**
   * The `change_password` step (ADR 0010): the new password must pass the policy
   * (ADMIN_PASSWORD_MIN_LENGTH, passwordPolicyViolation, the common list, not the current
   * password); a refused one keeps the challenge usable. Success uses the challenge up and answers
   * the next step with a fresh one carrying the new hash; nothing is written to admin_credentials
   * until verifyMfa succeeds. The account must still be active with the password the sign-in
   * verified.
   */
  async changePassword(
    challengeId: string,
    newPassword: string,
    ipHash: string,
  ): Promise<AdminChangePasswordResponse> {
    const { settings } = this.admin();
    const { key, challenge } = await this.readChallenge(challengeId, ['change_password']);
    const row = await findAdminById(this.db, challenge.userId);
    if (row === null || passwordFingerprint(row.passwordHash) !== challenge.pwdFp) {
      await this.store.del(key);
      throw loginStateInvalid();
    }
    if (row.status !== 'active') {
      await this.store.del(key);
      throw accountDisabled();
    }
    await assertPasswordPolicy(newPassword, {
      minLength: settings.passwordMinLength,
      email: row.email,
      currentHash: row.passwordHash,
    });
    if ((await this.store.take(key)) === null) throw loginStateInvalid();
    const newPasswordHash = await hashPassword(newPassword, this.config.password.argon2id);
    return this.nextCodeStep(
      settings,
      {
        userId: row.id,
        account: challenge.account,
        pwdFp: challenge.pwdFp,
        newPasswordHash,
      },
      row,
      ipHash,
    );
  }

  /**
   * The final step, for a `totp` or an `enrol_totp` challenge. Like step 1, the attempt is counted
   * in the code windows and reserved against the lockout before the code is checked, so parallel
   * guesses can't exceed the limits. The challenge stays usable after a wrong code until it
   * expires, the account window is used up or the account locks (then it is deleted). A code is
   * accepted once: the credentials row is locked FOR UPDATE and totp_last_used_step must be below
   * the code's step, so a replay (or a concurrent second use) is MFA_INVALID. The first valid code
   * of an unconfirmed enrolment confirms it: a CLI enrolment unless it is older than
   * ADMIN_TOTP_ENROLMENT_TTL_SECONDS (MFA_INVALID, audited `enrolment_expired`, until reset-totp),
   * or the secret of this sign-in's `enrol_totp` step. In the same transaction as the session:
   * the new password hash and TOTP secret of earlier steps, `must_change_password = false`, the
   * replay step, the cleared failure count, `last_sign_in_at` and the audit rows (ADR 0010).
   * Success also clears the account's windows.
   */
  async verifyMfa(challengeId: string, code: string, ipHash: string): Promise<AuthTokenResponse> {
    const { auth, settings } = this.admin();
    const { key, challenge } = await this.readChallenge(challengeId, ['totp', 'enrol_totp']);
    const { userId, account } = challenge;

    const limits = await this.reserveWindows(settings, 'otp', ipHash, account);
    const row = await findAdminById(this.db, userId);
    if (!limits.allowed) {
      await this.store.del(key);
      await this.audit('auth.admin.mfa_failed', row, account, { reason: 'rate_limited', ipHash });
      throw rateLimited(limits.retryAfterSeconds);
    }
    if (row === null || !this.challengeMatches(challenge, row)) {
      await this.store.del(key);
      throw loginStateInvalid();
    }
    if (row.status !== 'active') {
      await this.store.del(key);
      throw accountDisabled();
    }
    const lockout = await this.reserveLockout(settings, row, account);
    if (lockout.kind === 'locked') {
      await this.store.del(key);
      if (lockout.justLocked === true) {
        await this.audit('auth.admin.locked', row, account, { ipHash });
      }
      await this.audit('auth.admin.mfa_failed', row, account, { reason: 'locked', ipHash });
      throw rateLimited(lockout.retryAfterSeconds);
    }

    const now = this.clock.now();
    const enrolling = challenge.enrolment !== undefined;
    const stored = enrolling
      ? {
          ciphertext: Buffer.from(challenge.enrolment?.ciphertext ?? '', 'base64url'),
          nonce: Buffer.from(challenge.enrolment?.nonce ?? '', 'base64url'),
        }
      : // challengeMatches: a `totp` challenge's account has a secret.
        { ciphertext: row.totpSecretEncrypted as Buffer, nonce: row.totpSecretNonce as Buffer };
    const enrolmentExpired =
      !enrolling &&
      row.totpConfirmedAt === null &&
      now.getTime() - row.credentialsCreatedAt.getTime() > settings.totpEnrolmentTtlSeconds * 1000;
    let secret: Buffer;
    try {
      secret = decryptTotpSecret(settings.totp.encryptionKey, row.id, stored);
    } catch {
      // A challenge written under another key (rotated ADMIN_TOTP_ENCRYPTION_KEY): start again.
      await this.store.del(key);
      throw loginStateInvalid();
    }
    const check = {
      nowMs: now.getTime(),
      periodSeconds: settings.totp.periodSeconds,
      digits: settings.totp.digits,
      window: settings.totp.window,
      lastUsedStep: enrolling ? null : row.totpLastUsedStep,
    };
    const step = matchTotp(secret, code, check);
    // For the audit row only: a code that is valid but for an already used step is a replay.
    const replayed =
      step === null && matchTotp(secret, code, { ...check, lastUsedStep: null }) !== null;
    secret.fill(0);
    const fail = async (reason: string): Promise<never> => {
      const locked = await this.recordFailure(
        settings,
        row,
        account,
        ipHash,
        'auth.admin.mfa_failed',
        reason,
      );
      if (locked || (await this.accountWindowFull(settings, 'otp', account))) {
        await this.store.del(key);
      }
      throw new ApiError('MFA_INVALID', 'Wrong or expired code');
    };
    // An enrolment not confirmed within ADMIN_TOTP_ENROLMENT_TTL_SECONDS needs reset-totp.
    if (enrolmentExpired) return fail('enrolment_expired');
    if (step === null) return fail(replayed ? 'replayed' : 'invalid_code');

    const outcome = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          status: users.status,
          passwordHash: adminCredentials.passwordHash,
          totpSecretEncrypted: adminCredentials.totpSecretEncrypted,
          totpConfirmedAt: adminCredentials.totpConfirmedAt,
          totpLastUsedStep: adminCredentials.totpLastUsedStep,
        })
        .from(adminCredentials)
        .innerJoin(users, eq(users.id, adminCredentials.userId))
        .where(eq(adminCredentials.userId, row.id))
        .for('update', { of: adminCredentials })
        .limit(1);
      if (current === undefined) return { kind: 'gone' } as const;
      if (current.status !== 'active') return { kind: 'disabled' } as const;
      // The password, or the secret, changed since this sign-in started (reset, reset-totp, a
      // concurrent enrolment): start again.
      const sameSecret = enrolling
        ? current.totpSecretEncrypted === null
        : current.totpSecretEncrypted !== null &&
          Buffer.from(current.totpSecretEncrypted).equals(stored.ciphertext);
      if (passwordFingerprint(current.passwordHash) !== challenge.pwdFp || !sameSecret) {
        return { kind: 'gone' } as const;
      }
      if (!enrolling && current.totpLastUsedStep !== null && current.totpLastUsedStep >= step) {
        return { kind: 'replayed' } as const;
      }
      // One sign-in per challenge (taken inside the transaction: a concurrent use waits on the
      // row lock and then finds it gone).
      if ((await this.store.take(key)) === null) return { kind: 'gone' } as const;
      await tx
        .update(adminCredentials)
        .set({
          totpLastUsedStep: step,
          totpConfirmedAt: enrolling
            ? now
            : sql`coalesce(${adminCredentials.totpConfirmedAt}, ${now.toISOString()}::timestamptz)`,
          failedAttempts: 0,
          lockedUntil: null,
          updatedAt: now,
          ...(enrolling
            ? { totpSecretEncrypted: stored.ciphertext, totpSecretNonce: stored.nonce }
            : {}),
          ...(challenge.newPasswordHash === undefined
            ? {}
            : { passwordHash: challenge.newPasswordHash, mustChangePassword: false }),
        })
        .where(eq(adminCredentials.userId, row.id));
      await markSignedIn(tx, row.id, now);
      const audit = (action: AuthAuditAction, meta: Record<string, unknown>) =>
        writeAuthAudit(tx, {
          actorId: row.id,
          action,
          targetType: 'user',
          targetId: row.id,
          meta,
          now,
        });
      if (challenge.newPasswordHash !== undefined) {
        await audit('auth.admin.password_changed', { ipHash });
      }
      if (current.totpConfirmedAt === null) {
        await audit('auth.admin.totp_confirmed', { ipHash, enrolledAtSignIn: enrolling });
      }
      await audit('auth.admin.sign_in', { ipHash, amr: ['pwd', 'otp', 'mfa'] });
      const session = await startSession(tx, {
        userId: row.id,
        pool: 'admins',
        now,
        ttlSeconds: auth.config.pools.admins?.refreshTokenTtlSeconds ?? 0,
      });
      return { kind: 'signed_in', session, user: await sessionUser(tx, row.id) } as const;
    });
    if (outcome.kind === 'replayed') return fail('replayed');
    if (outcome.kind === 'disabled') {
      await this.store.del(key);
      throw accountDisabled();
    }
    if (outcome.kind === 'gone') {
      await this.store.del(key);
      throw loginStateInvalid();
    }
    await Promise.all(
      (['pwd', 'otp'] as const).map((s) => this.limiter.reset(this.windowKey(s, 'acct', account))),
    );
    return tokenResponse(auth, 'admins', outcome.user, outcome.session, ['pwd', 'otp', 'mfa'], now);
  }

  /**
   * The challenge still describes the account: the password the sign-in verified, a temporary
   * password only together with its replacement, and a code step that fits the TOTP state (a
   * `totp` challenge needs a secret; an `enrol_totp` one an account without).
   */
  private challengeMatches(challenge: Challenge, row: AdminRow): boolean {
    if (passwordFingerprint(row.passwordHash) !== challenge.pwdFp) return false;
    if (row.mustChangePassword && challenge.newPasswordHash === undefined) return false;
    if (challenge.step === 'enrol_totp') {
      return challenge.enrolment !== undefined && row.totpSecretEncrypted === null;
    }
    return (
      challenge.enrolment === undefined &&
      row.totpSecretEncrypted !== null &&
      row.totpSecretNonce !== null
    );
  }
}
