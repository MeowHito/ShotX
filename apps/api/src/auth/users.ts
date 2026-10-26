import { users } from '@shotx/db';
import { authIdentitySchema, newUserForIdentity, type UserRole } from '@shotx/shared';
import { and, eq } from 'drizzle-orm';
import type { Queryable } from '../db/db';
import type { VerifiedIdentity } from '../tokens';

/** A users-pool user as the guards resolve it. */
export interface AppUser {
  id: string;
  role: UserRole;
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
 * Later sign-ins never change the role, email or name.
 */
export async function provisionUser(q: Queryable, identity: VerifiedIdentity): Promise<AppUser> {
  const find = async () => {
    const [row] = await q
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.authPool, identity.pool), eq(users.authSubject, identity.sub)))
      .limit(1);
    return row;
  };
  const existing = await find();
  if (existing !== undefined) return existing;
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
  const [row] = await q
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}
