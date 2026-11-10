import { authSessions, users } from '@shotx/db';
import {
  type AccountStatus,
  authIdentitySchema,
  isPasswordAccountSubject,
  newUserForIdentity,
  type UserRole,
} from '@shotx/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Queryable } from '../db/db';
import { ApiError } from '../http/api-error';
import type { VerifiedIdentity } from '../tokens';

/** A user as the guards resolve it. */
export interface AppUser {
  id: string;
  role: UserRole;
  /** `users.status` (ADR 0010): `disabled` is ACCOUNT_DISABLED on every signed-in route. */
  status: AccountStatus;
}

const appUserColumns = { id: users.id, role: users.role, status: users.status };

/** ACCOUNT_DISABLED for a disabled account (the guards, after the token is verified). */
export function assertAccountActive(user: Pick<AppUser, 'status'>): void {
  if (user.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled');
}

/** The bearer token of the Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  return match?.[1] ?? null;
}

/** Email and name only when they pass the shared identity schema; anything else is null. */
function provisioningIdentity(identity: VerifiedIdentity) {
  const email = authIdentitySchema.shape.email.safeParse(identity.email);
  const name = authIdentitySchema.shape.name.safeParse(identity.name);
  return {
    pool: identity.pool,
    sub: identity.sub,
    email: email.success ? email.data : null,
    name: name.success ? name.data : null,
  };
}

/**
 * The `users` row of a verified identity, created on first use (ADR 0002): one SELECT on the
 * common path; otherwise `INSERT ... ON CONFLICT (auth_pool, auth_subject) DO NOTHING` with
 * newUserForIdentity and a SELECT again (a concurrent first request may have inserted it).
 * Later sign-ins never change the role, email or name. Email + password accounts (`admin:` and
 * `password:` subjects, ADR 0010) are created by an admin or the operator CLI only, never here:
 * a token of one whose row is gone is UNAUTHENTICATED.
 */
export async function provisionUser(q: Queryable, identity: VerifiedIdentity): Promise<AppUser> {
  const find = async () => {
    const [row] = await q
      .select(appUserColumns)
      .from(users)
      .where(and(eq(users.authPool, identity.pool), eq(users.authSubject, identity.sub)))
      .limit(1);
    return row;
  };
  const existing = await find();
  if (existing !== undefined) return existing;
  if (isPasswordAccountSubject(identity.sub)) {
    throw new ApiError('UNAUTHENTICATED', 'Unknown account');
  }
  await q
    .insert(users)
    .values(newUserForIdentity(provisioningIdentity(identity)))
    .onConflictDoNothing({ target: [users.authPool, users.authSubject] });
  const created = await find();
  if (created === undefined) throw new Error('User provisioning returned no row');
  return created;
}

/** A user by id (viewer sessions); null when the row is gone. */
export async function userById(q: Queryable, id: string): Promise<AppUser | null> {
  const [row] = await q.select(appUserColumns).from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

/**
 * UNAUTHENTICATED unless a ShotX-issued users-pool token's session is still live: its `sid`
 * family has a row that is neither revoked nor expired. So logout, refresh-reuse revocation, a
 * password change, an admin reset or disable end access at once instead of when the access token
 * expires. Unlike AdminGuard, a lockout does NOT end live sessions: it only blocks new sign-ins
 * (and wrong current-password attempts), so someone who knows a photographer's email can't kill
 * their open studio session by guessing passwords. One indexed query per request (auth_sessions_family_idx), no cache. Cognito
 * tokens have no ShotX session and are not checked.
 */
export async function assertUserSessionLive(
  q: Queryable,
  identity: VerifiedIdentity,
  userId: string,
  now: Date,
): Promise<void> {
  if (identity.issuer !== 'shotx') return;
  const ended = () => new ApiError('UNAUTHENTICATED', 'Session ended; sign in again');
  if (identity.sessionId === undefined) throw ended();
  const [live] = await q
    .select({ id: authSessions.id })
    .from(authSessions)
    .where(
      and(
        eq(authSessions.familyId, identity.sessionId),
        eq(authSessions.userId, userId),
        eq(authSessions.pool, 'users'),
        isNull(authSessions.revokedAt),
        gt(authSessions.expiresAt, now),
      ),
    )
    .limit(1);
  if (live === undefined) throw ended();
}
