import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { adminCredentials, authSessions, users } from '@shotx/db';
import { hasRequiredAmr } from '@shotx/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Request } from 'express';
import type { Db } from '../db/db';
import { ApiError } from '../http/api-error';
import type { ApiConfig } from '../config';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  TOKEN_VERIFIER,
  type TokenVerifier,
  type VerifiedIdentity,
} from '../tokens';
import { type AppUser, assertAccountActive, bearerToken, provisionUser } from './users';

const ADMIN = Symbol('admin');
type AdminRequest = Request & { [ADMIN]?: AppUser };

/**
 * The admin user of a verified admins-pool identity. ShotX admins (`admin:` subjects) are created
 * by the operator CLI or another admin (ADR 0010), so their row must exist; Cognito admins are
 * provisioned on first use (ADR 0002).
 */
async function adminUser(db: Db, identity: VerifiedIdentity): Promise<AppUser | null> {
  if (identity.issuer !== 'shotx') return provisionUser(db, identity);
  const [row] = await db
    .select({ id: users.id, role: users.role, status: users.status })
    .from(users)
    .where(and(eq(users.authPool, 'admins'), eq(users.authSubject, identity.sub)))
    .limit(1);
  return row ?? null;
}

/**
 * True while a ShotX admin's session family is live (not revoked, not expired): logout, reuse
 * revocation, a reset (operator or admin), a disable and a password change end admin access at
 * once, not when the access token expires. A lockout does NOT end live sessions (ADR 0010 round
 * 2): it only blocks new sign-ins, so someone who knows an admin's email can't sign them out by
 * guessing passwords.
 */
async function adminSessionLive(
  db: Db,
  userId: string,
  sessionId: string | undefined,
  now: Date,
): Promise<boolean> {
  if (sessionId === undefined) return false;
  const [live] = await db
    .select({ id: authSessions.id })
    .from(authSessions)
    .innerJoin(adminCredentials, eq(adminCredentials.userId, authSessions.userId))
    .where(
      and(
        eq(authSessions.familyId, sessionId),
        eq(authSessions.userId, userId),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return live !== undefined;
}

/**
 * The guard of every `/admin/*` route (Phase 5): an admins-pool token only (a users-pool token is
 * UNAUTHENTICATED: it can never become an admin, ADR 0002). ShotX-issued admins tokens must carry
 * adminRequiredAmr(ADMIN_MFA_MODE) (`pwd`, plus `otp` with `totp`), else MFA_REQUIRED, and a live session (adminSessionLive)
 * else UNAUTHENTICATED; Cognito enforces MFA in the admins pool itself. A disabled admin is
 * ACCOUNT_DISABLED (checked before the session, which disabling revoked).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(API_CONFIG) private readonly config?: ApiConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AdminRequest>();
    const token = bearerToken(req.headers.authorization);
    if (token === null) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
    const identity = await this.verifier.verify(token);
    if (identity.pool !== 'admins') {
      throw new ApiError('UNAUTHENTICATED', 'This route needs an admins-pool token');
    }
    // ADR 0011 decision 4: what the token must carry follows the api's ADMIN_MFA_MODE, never the
    // token; without the config (tests that build the guard by hand) the stricter `totp`.
    const mfaMode = this.config?.shotxAuth?.admin?.mfaMode ?? 'totp';
    if (identity.issuer === 'shotx' && !hasRequiredAmr('admins', identity.amr ?? [], mfaMode)) {
      throw new ApiError('MFA_REQUIRED', 'Sign in with your authenticator code');
    }
    const user = await adminUser(this.db, identity);
    if (user?.role !== 'admin') throw new ApiError('UNAUTHENTICATED', 'Unknown admin');
    assertAccountActive(user);
    if (
      identity.issuer === 'shotx' &&
      !(await adminSessionLive(this.db, user.id, identity.sessionId, this.clock.now()))
    ) {
      throw new ApiError('UNAUTHENTICATED', 'Session ended; sign in again');
    }
    req[ADMIN] = user;
    return true;
  }
}

/** The admin the guard resolved. Use only on routes behind AdminGuard. */
export const CurrentAdmin = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const admin = context.switchToHttp().getRequest<AdminRequest>()[ADMIN];
  if (admin === undefined) throw new Error('AdminGuard did not run');
  return admin;
});
