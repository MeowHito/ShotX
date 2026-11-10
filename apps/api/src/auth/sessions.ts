import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { auditLog, authSessions, users } from '@shotx/db';
import { type AuthAuditAction, type AuthPool, OPAQUE_TOKEN_BYTES } from '@shotx/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db, Queryable } from '../db/db';
import { newId } from '../drive/folders';

// Refresh sessions of ShotX-issued tokens (auth_sessions, migration 0005; ADR 0008 section 4).

/** An opaque token (refresh token, OIDC state, admin challenge): 32 CSPRNG bytes, base64url. */
export function newOpaqueToken(): string {
  return randomBytes(OPAQUE_TOKEN_BYTES).toString('base64url');
}

/** auth_sessions.refresh_token_hash: lowercase hex SHA-256 (REFRESH_TOKEN_HASH_PATTERN). */
export function refreshTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssuedRefreshToken {
  refreshToken: string;
  /** auth_sessions.family_id: the access token's `sid`. */
  familyId: string;
  /** End of the family (never extended by rotation). */
  expiresAt: Date;
}

/** Starts a refresh family for a sign-in: one row whose id is the family id. */
export async function startSession(
  q: Queryable,
  input: { userId: string; pool: AuthPool; now: Date; ttlSeconds: number },
): Promise<IssuedRefreshToken> {
  const id = await newId(q);
  const refreshToken = newOpaqueToken();
  const expiresAt = new Date(input.now.getTime() + input.ttlSeconds * 1000);
  await q.insert(authSessions).values({
    id,
    userId: input.userId,
    pool: input.pool,
    refreshTokenHash: refreshTokenHash(refreshToken),
    familyId: id,
    expiresAt,
    createdAt: input.now,
    lastUsedAt: input.now,
  });
  return { refreshToken, familyId: id, expiresAt };
}

/** The user a session belongs to, as the token response needs it. */
export interface SessionUser {
  id: string;
  authSubject: string;
  email: string | null;
  name: string | null;
}

export type RotateResult =
  | { kind: 'rotated'; user: SessionUser; issued: IssuedRefreshToken }
  /** Unknown, expired, revoked by logout, or of another pool. */
  | { kind: 'invalid' }
  /** Already rotated: the family was revoked in the same transaction. */
  | { kind: 'reused'; userId: string; familyId: string };

/** Revokes every live row of a family. */
export async function revokeFamily(q: Queryable, familyId: string, now: Date): Promise<void> {
  await q
    .update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.familyId, familyId), isNull(authSessions.revokedAt)));
}

/** An audit_log row of a sign-in event (AUTH_AUDIT_ACTIONS; `actorId` null for unknown accounts). */
export async function writeAuthAudit(
  q: Queryable,
  entry: {
    actorId: string | null;
    action: AuthAuditAction;
    targetType: 'user' | 'admin_login' | 'photographer_login';
    targetId: string;
    meta: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await q.insert(auditLog).values({
    actorId: entry.actorId,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    meta: entry.meta,
    createdAt: entry.now,
  });
}

/**
 * Rotates a refresh token in one transaction. The presented row is locked (FOR UPDATE), so two
 * concurrent refreshes with one token serialize: the first rotates, the second sees a rotated
 * row and is treated as reuse.
 *
 * - live row of `pool`: insert the successor (same family, pool and `expires_at`), revoke the
 *   presented row and link it to the successor;
 * - revoked row with a successor (rotated before): within `grace` of its rotation, while the
 *   successor is still live and `grace.load` returns it, the same successor is answered again
 *   (two BFF instances refreshing at once); otherwise reuse: revoke the whole family and write
 *   `auth.refresh_reused` to audit_log;
 * - anything else: invalid.
 *
 * `grace.save` runs inside the transaction (before commit), so a concurrent request that waited
 * on the row lock always finds the successor.
 */
export async function rotateSession(
  db: Db,
  input: { refreshToken: string; pool: AuthPool; now: Date; grace?: RefreshGrace },
): Promise<RotateResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(authSessions)
      .where(eq(authSessions.refreshTokenHash, refreshTokenHash(input.refreshToken)))
      .for('update')
      .limit(1);
    if (row === undefined) return { kind: 'invalid' } as const;
    if (row.revokedAt !== null) {
      if (row.replacedById === null) return { kind: 'invalid' } as const;
      const again = await graceSuccessor(tx, row, input);
      if (again !== null) return again;
      await revokeFamily(tx, row.familyId, input.now);
      await writeAuthAudit(tx, {
        actorId: row.userId,
        action: 'auth.refresh_reused',
        targetType: 'user',
        targetId: row.userId,
        meta: { pool: row.pool, familyId: row.familyId },
        now: input.now,
      });
      return { kind: 'reused', userId: row.userId, familyId: row.familyId } as const;
    }
    if (row.pool !== input.pool || row.expiresAt.getTime() <= input.now.getTime()) {
      return { kind: 'invalid' } as const;
    }
    const [user] = await tx
      .select({
        id: users.id,
        authSubject: users.authSubject,
        email: users.email,
        name: users.name,
      })
      .from(users)
      .where(eq(users.id, row.userId))
      .limit(1);
    if (user === undefined) return { kind: 'invalid' } as const;
    return {
      kind: 'rotated',
      user,
      issued: {
        refreshToken: await insertSuccessor(tx, row, input),
        familyId: row.familyId,
        expiresAt: row.expiresAt,
      },
    } as const;
  });
}

type SessionRow = typeof authSessions.$inferSelect;

/** Inserts the successor of `row`, revokes and links `row`, records the grace entry. */
async function insertSuccessor(
  tx: Queryable,
  row: SessionRow,
  input: { refreshToken: string; now: Date; grace?: RefreshGrace },
): Promise<string> {
  const successorId = await newId(tx);
  const refreshToken = newOpaqueToken();
  await tx.insert(authSessions).values({
    id: successorId,
    userId: row.userId,
    pool: row.pool,
    refreshTokenHash: refreshTokenHash(refreshToken),
    familyId: row.familyId,
    expiresAt: row.expiresAt,
    createdAt: input.now,
    lastUsedAt: input.now,
  });
  await tx
    .update(authSessions)
    .set({ revokedAt: input.now, replacedById: successorId, lastUsedAt: input.now })
    .where(eq(authSessions.id, row.id));
  if (input.grace !== undefined && input.grace.seconds > 0) {
    await input.grace.save(input.refreshToken, refreshToken);
  }
  return refreshToken;
}

/** The successor answered again inside the grace window, or null (then it is reuse). */
async function graceSuccessor(
  tx: Queryable,
  row: SessionRow,
  input: { refreshToken: string; pool: AuthPool; now: Date; grace?: RefreshGrace },
): Promise<RotateResult | null> {
  const { grace } = input;
  if (
    grace === undefined ||
    grace.seconds <= 0 ||
    row.replacedById === null ||
    row.revokedAt === null
  )
    return null;
  if (input.now.getTime() - row.revokedAt.getTime() > grace.seconds * 1000) return null;
  if (row.pool !== input.pool) return null;
  const [successor] = await tx
    .select()
    .from(authSessions)
    .where(eq(authSessions.id, row.replacedById))
    .limit(1);
  if (successor?.revokedAt !== null || successor.expiresAt.getTime() <= input.now.getTime()) {
    return null;
  }
  const token = await grace.load(input.refreshToken);
  if (token === null || refreshTokenHash(token) !== successor.refreshTokenHash) return null;
  const [user] = await tx
    .select({ id: users.id, authSubject: users.authSubject, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1);
  if (user === undefined) return null;
  return {
    kind: 'rotated',
    user,
    issued: { refreshToken: token, familyId: row.familyId, expiresAt: row.expiresAt },
  };
}

/**
 * Keeps a rotated token's successor for the grace window (AUTH_REFRESH_REUSE_GRACE_SECONDS; 0
 * disables it) in Redis.
 */
export interface RefreshGrace {
  seconds: number;
  save(presented: string, successor: string): Promise<void>;
  load(presented: string): Promise<string | null>;
}

const GRACE_KEY_LABEL = 'shotx-refresh-grace-key:';

/** AES-256-GCM key derived from the presented token: only its holder can read the successor. */
function graceKey(presented: string): Buffer {
  return createHash('sha256').update(GRACE_KEY_LABEL).update(presented, 'utf8').digest();
}

/**
 * RefreshGrace on a key-value store: the successor encrypted under a key derived from the
 * presented token (the store key is the presented token's hash, which can't be turned into that
 * key), with the grace window as TTL.
 */
export function storeRefreshGrace(
  store: {
    setWithTtl(k: string, v: string, ttl: number): Promise<void>;
    get(k: string): Promise<string | null>;
  },
  seconds: number,
): RefreshGrace {
  const storeKey = (presented: string) => `auth:refresh-grace:${refreshTokenHash(presented)}`;
  return {
    seconds,
    async save(presented, successor) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', graceKey(presented), nonce);
      const body = Buffer.concat([
        cipher.update(successor, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      await store.setWithTtl(
        storeKey(presented),
        Buffer.concat([nonce, body]).toString('base64url'),
        seconds,
      );
    },
    async load(presented) {
      const raw = await store.get(storeKey(presented));
      if (raw === null) return null;
      try {
        const bytes = Buffer.from(raw, 'base64url');
        const decipher = createDecipheriv(
          'aes-256-gcm',
          graceKey(presented),
          bytes.subarray(0, 12),
        );
        decipher.setAuthTag(bytes.subarray(bytes.length - 16));
        return Buffer.concat([
          decipher.update(bytes.subarray(12, bytes.length - 16)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Sign out: revokes the family of the token. Unknown or revoked tokens are fine (idempotent).
 * With `pool`, a token of another pool is treated as unknown (nothing revoked): POST /auth/logout
 * only signs out sessions of the calling app's pool (BffKeyScope `request`).
 */
export async function revokeSessionByToken(
  q: Queryable,
  refreshToken: string,
  now: Date,
  pool?: AuthPool,
): Promise<void> {
  const [row] = await q
    .select({ familyId: authSessions.familyId, pool: authSessions.pool })
    .from(authSessions)
    .where(eq(authSessions.refreshTokenHash, refreshTokenHash(refreshToken)))
    .limit(1);
  if (row === undefined || (pool !== undefined && row.pool !== pool)) return;
  await revokeFamily(q, row.familyId, now);
}

/**
 * Revokes every session of a user (operator CLI resets; admin disable, reset-password and a
 * photographer's password change, ADR 0010). Returns how many live families were revoked.
 */
export async function revokeUserSessions(q: Queryable, userId: string, now: Date): Promise<number> {
  const revoked = await q
    .update(authSessions)
    .set({ revokedAt: now })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
    .returning({ familyId: authSessions.familyId });
  return new Set(revoked.map((r) => r.familyId)).size;
}
