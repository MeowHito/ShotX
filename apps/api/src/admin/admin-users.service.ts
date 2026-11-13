import { Inject, Injectable } from '@nestjs/common';
import { adminCredentials, storageUsage, userPasswordCredentials, users } from '@shotx/db';
import {
  type AccountRole,
  type AccountStatus,
  adminAccountSubject,
  type AdminUser,
  decodeAdminUserCursor,
  encodeAdminUserCursor,
  isPasswordAccountSubject,
  type ListAdminUsersResponse,
  passwordAccountSubject,
  temporaryPasswordViolation,
} from '@shotx/shared';
import { and, desc, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import { hashPassword } from '../auth/password';
import { passwordTooWeak } from '../auth/password-policy';
import { revokeUserSessions } from '../auth/sessions';
import type { ApiConfig } from '../config';
import { type Db, isUniqueViolation, type Queryable, type Tx } from '../db/db';
import { newId } from '../drive/folders';
import { ApiError, notFound } from '../http/api-error';
import { validationError } from '../http/zod';
import { API_CONFIG, CLOCK, type Clock, DATABASE } from '../tokens';
import { writeAdminAudit } from './admin-audit';

// Admin user management (ADR 0010; ADMIN_ROUTES in @shotx/shared). Only these routes create
// `admin` and `photographer` accounts. Every mutation runs in one transaction with its audit_log
// row. Passwords are hashed (argon2id) before the transaction and never logged, audited or
// returned.

/** The two unique indexes an account email can collide with (EMAIL_TAKEN). */
const EMAIL_INDEXES = ['users_password_account_email_unique', 'users_admin_email_unique'];

const ACCOUNT_ROLE_FILTER = inArray(users.role, ['admin', 'photographer']);

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  status: users.status,
  authSubject: users.authSubject,
  createdAt: users.createdAt,
  createdAtText: sql<string>`${users.createdAt}::text`,
  createdById: users.createdById,
  disabledAt: users.disabledAt,
  lastSignInAt: users.lastSignInAt,
  adminMustChange: adminCredentials.mustChangePassword,
  adminLockedUntil: adminCredentials.lockedUntil,
  adminTotpConfirmedAt: adminCredentials.totpConfirmedAt,
  photographerMustChange: userPasswordCredentials.mustChangePassword,
  photographerLockedUntil: userPasswordCredentials.lockedUntil,
  usedBytes: storageUsage.usedBytes,
};

function selectUsers(q: Queryable) {
  return q
    .select(userColumns)
    .from(users)
    .leftJoin(adminCredentials, eq(adminCredentials.userId, users.id))
    .leftJoin(userPasswordCredentials, eq(userPasswordCredentials.userId, users.id))
    .leftJoin(storageUsage, eq(storageUsage.photographerId, users.id));
}

type UserRow = Awaited<ReturnType<typeof selectUsers>>[number];

/** `%`, `_` and `\` taken literally in a LIKE pattern (backslash is the default escape). */
function likeContains(text: string): string {
  const folded = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  return `%${folded.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const role = (r: string): AccountRole => (r === 'admin' ? 'admin' : 'photographer');

/** One account as the admin users page shows it (adminUserSchema). */
function toAdminUser(row: UserRow, now: Date): AdminUser {
  const accountRole = role(row.role);
  const passwordAccount = isPasswordAccountSubject(row.authSubject);
  const mustChange =
    (accountRole === 'admin' ? row.adminMustChange : row.photographerMustChange) ?? false;
  const lockedUntil = accountRole === 'admin' ? row.adminLockedUntil : row.photographerLockedUntil;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: accountRole,
    status: row.status,
    passwordAccount,
    mustChangePassword: passwordAccount && mustChange,
    lockedUntil:
      lockedUntil !== null && lockedUntil.getTime() > now.getTime()
        ? lockedUntil.toISOString()
        : null,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    lastSignInAt: row.lastSignInAt?.toISOString() ?? null,
    usedBytes: accountRole === 'photographer' ? (row.usedBytes ?? 0) : null,
    // Only ShotX admins (`admin:` subjects, admin_credentials) enrol TOTP here; Cognito admins
    // have MFA in their pool and no credentials row.
    totpEnrolled:
      accountRole === 'admin' && passwordAccount ? row.adminTotpConfirmedAt !== null : null,
  };
}

/** A locked row of the mutation's lock set. */
interface LockedUser {
  id: string;
  role: string;
  status: AccountStatus;
  name: string | null;
}

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * PASSWORD_TOO_WEAK (`too_short`) unless an admin-set password has TEMPORARY_PASSWORD_MIN_LENGTH
   * code points. Only the length counts (ADR 0015): the password is temporary, and the first
   * sign-in must replace it under the pool's full policy. Password accounts need the API's own
   * sign-in (AUTH_PROVIDER=shotx or local; for admins also the admins pool): otherwise CONFLICT,
   * since an account created there could never sign in.
   */
  private assertTemporaryPassword(accountRole: AccountRole, password: string): void {
    const auth = this.config.shotxAuth;
    if (auth === null) {
      throw new ApiError('CONFLICT', 'Password accounts need AUTH_PROVIDER=shotx');
    }
    if (accountRole === 'admin' && auth.admin === null) {
      throw new ApiError('CONFLICT', 'Admin sign-in is not configured');
    }
    const minLength = auth.temporaryPasswordMinLength;
    const violation = temporaryPasswordViolation(password, minLength);
    if (violation !== null) throw passwordTooWeak(violation, minLength);
  }

  private async find(q: Queryable, id: string): Promise<AdminUser | null> {
    const [row] = await selectUsers(q)
      .where(and(eq(users.id, id), ACCOUNT_ROLE_FILTER))
      .limit(1);
    return row === undefined ? null : toAdminUser(row, this.clock.now());
  }

  /** GET /admin/users/:id. Viewers and unknown ids are NOT_FOUND. */
  async get(id: string): Promise<AdminUser> {
    const user = await this.find(this.db, id);
    if (user === null) throw notFound('User');
    return user;
  }

  /** GET /admin/users: newest first (created_at DESC, id DESC), keyset-paginated. */
  async list(query: {
    q?: string | undefined;
    role?: AccountRole | undefined;
    status?: AccountStatus | undefined;
    cursor?: string | undefined;
    limit?: number | undefined;
  }): Promise<ListAdminUsersResponse> {
    const limit = query.limit ?? this.config.adminConsole.listPageSize;
    const filters: SQL[] = [ACCOUNT_ROLE_FILTER];
    if (query.q !== undefined) {
      const pattern = likeContains(query.q);
      const match = or(
        sql`lower(${users.email} COLLATE "C") LIKE ${pattern}`,
        sql`lower(${users.name} COLLATE "C") LIKE ${pattern}`,
      );
      if (match !== undefined) filters.push(match);
    }
    if (query.role !== undefined) filters.push(eq(users.role, query.role));
    if (query.status !== undefined) filters.push(eq(users.status, query.status));
    if (query.cursor !== undefined) {
      const cursor = decodeAdminUserCursor(query.cursor);
      if (cursor === null) throw validationError(['query', 'cursor'], 'Invalid cursor');
      filters.push(
        sql`(${users.createdAt}, ${users.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await selectUsers(this.db)
      .where(and(...filters))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const now = this.clock.now();
    return {
      items: page.map((row) => toAdminUser(row, now)),
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeAdminUserCursor({ v: 1, createdAt: last.createdAtText, id: last.id })
          : null,
    };
  }

  /**
   * Locks the rows a mutation depends on, in id order and in one statement (so concurrent admin
   * mutations never deadlock): the acting admin, the target, and (when disabling an admin) every
   * active admin, for the last-admin check. Then, in this order: the target must be an account
   * (NOT_FOUND), disabling must leave another active admin (`lastAdminCheck`, LAST_ADMIN: two
   * admins disabling each other at once can't both succeed), and the actor must still be active
   * (ACCOUNT_DISABLED).
   */
  private async lockAccounts(
    tx: Tx,
    rawActorId: string,
    rawTargetId: string,
    options: { lastAdminCheck?: boolean } = {},
  ): Promise<{ actor: LockedUser; target: LockedUser }> {
    // Postgres prints uuids lower-case; z.uuid() also accepts upper case.
    const actorId = rawActorId.toLowerCase();
    const targetId = rawTargetId.toLowerCase();
    const ids = inArray(users.id, [actorId, targetId]);
    const locked = await tx
      .select({ id: users.id, role: users.role, status: users.status, name: users.name })
      .from(users)
      .where(
        options.lastAdminCheck === true
          ? or(ids, and(eq(users.role, 'admin'), eq(users.status, 'active')))
          : ids,
      )
      .orderBy(users.id)
      .for('update');
    const target = locked.find((r) => r.id === targetId);
    if (target === undefined || target.role === 'user') throw notFound('User');
    if (
      options.lastAdminCheck === true &&
      target.role === 'admin' &&
      target.status === 'active' &&
      !locked.some((r) => r.role === 'admin' && r.status === 'active' && r.id !== target.id)
    ) {
      throw new ApiError('LAST_ADMIN', 'The last active admin cannot be disabled');
    }
    const actor = locked.find((r) => r.id === actorId);
    if (actor?.status !== 'active') {
      throw new ApiError('ACCOUNT_DISABLED', 'This account is disabled');
    }
    return { actor, target };
  }

  /**
   * POST /admin/users. Admin: admins pool, `admin:<id>`, admin_credentials with
   * `must_change_password` and no TOTP (enrolled at first sign-in). Photographer: users pool,
   * `password:<id>`, user_password_credentials (`must_change_password`) and a storage_usage row.
   * `created_by_id` is the acting admin. EMAIL_TAKEN for an email another password account has
   * (either pool, ASCII case ignored); PASSWORD_TOO_WEAK below TEMPORARY_PASSWORD_MIN_LENGTH.
   */
  async create(
    actorId: string,
    body: { email: string; name: string; role: AccountRole; password: string },
  ): Promise<AdminUser> {
    this.assertTemporaryPassword(body.role, body.password);
    const passwordHash = await hashPassword(body.password, this.config.password.argon2id);
    const now = this.clock.now();
    try {
      return await this.db.transaction(async (tx) => {
        await this.lockAccounts(tx, actorId, actorId);
        const id = await newId(tx);
        const admin = body.role === 'admin';
        await tx.insert(users).values({
          id,
          role: body.role,
          authPool: admin ? 'admins' : 'users',
          authSubject: admin ? adminAccountSubject(id) : passwordAccountSubject(id),
          email: body.email,
          name: body.name,
          createdAt: now,
          createdById: actorId,
        });
        if (admin) {
          await tx.insert(adminCredentials).values({
            userId: id,
            passwordHash,
            mustChangePassword: true,
            createdAt: now,
            updatedAt: now,
          });
        } else {
          await tx.insert(userPasswordCredentials).values({
            userId: id,
            passwordHash,
            mustChangePassword: true,
            createdAt: now,
            updatedAt: now,
          });
          await tx.insert(storageUsage).values({ photographerId: id }).onConflictDoNothing();
        }
        await writeAdminAudit(tx, {
          actorId,
          action: 'admin.user.created',
          target: 'user',
          targetId: id,
          meta: { role: body.role, email: body.email },
          now,
        });
        const created = await this.find(tx, id);
        if (created === null) throw new Error('Created account vanished');
        return created;
      });
    } catch (error) {
      if (EMAIL_INDEXES.some((index) => isUniqueViolation(error, index))) {
        throw new ApiError('EMAIL_TAKEN', 'Another account already uses this email');
      }
      throw error;
    }
  }

  /**
   * PATCH /admin/users/:id: rename and/or disable/enable. Disabling sets `disabled_at`, revokes
   * every session family of the account and (photographers) takes their shares offline; files
   * are kept. Own account: CANNOT_MODIFY_SELF (renaming is fine); the last active admin:
   * LAST_ADMIN, decided under row locks on every active admin. No-op changes write nothing.
   */
  async update(
    rawActorId: string,
    rawId: string,
    body: { name?: string | undefined; status?: AccountStatus | undefined },
  ): Promise<AdminUser> {
    const actorId = rawActorId.toLowerCase();
    const id = rawId.toLowerCase();
    if (body.status === 'disabled' && id === actorId) {
      throw new ApiError('CANNOT_MODIFY_SELF', 'You cannot disable your own account');
    }
    // The role never changes, so it can be read before the locks.
    const [current] = await this.db
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    if (current === undefined || current.role === 'user') throw notFound('User');
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      const disablingAdmin = body.status === 'disabled' && current.role === 'admin';
      const { target } = await this.lockAccounts(tx, actorId, id, {
        lastAdminCheck: disablingAdmin,
      });
      if (body.status === 'disabled' && target.status === 'active') {
        await tx.update(users).set({ status: 'disabled', disabledAt: now }).where(eq(users.id, id));
        const revokedSessions = await revokeUserSessions(tx, id, now);
        await writeAdminAudit(tx, {
          actorId,
          action: 'admin.user.disabled',
          target: 'user',
          targetId: id,
          meta: { revokedSessions },
          now,
        });
      } else if (body.status === 'active' && target.status === 'disabled') {
        await tx.update(users).set({ status: 'active', disabledAt: null }).where(eq(users.id, id));
        await writeAdminAudit(tx, {
          actorId,
          action: 'admin.user.enabled',
          target: 'user',
          targetId: id,
          meta: {},
          now,
        });
      }
      if (body.name !== undefined && body.name !== target.name) {
        await tx.update(users).set({ name: body.name }).where(eq(users.id, id));
        await writeAdminAudit(tx, {
          actorId,
          action: 'admin.user.updated',
          target: 'user',
          targetId: id,
          meta: { changed: ['name'], oldName: target.name, newName: body.name },
          now,
        });
      }
      const updated = await this.find(tx, id);
      if (updated === null) throw notFound('User');
      return updated;
    });
  }

  /**
   * POST /admin/users/:id/reset-password: a new temporary password (`must_change_password`),
   * failures and lock cleared, every session revoked; an admin's TOTP is kept. Own account:
   * CANNOT_MODIFY_SELF; not an email + password account: CONFLICT.
   */
  async resetPassword(rawActorId: string, rawId: string, password: string): Promise<AdminUser> {
    const actorId = rawActorId.toLowerCase();
    const id = rawId.toLowerCase();
    if (id === actorId) {
      throw new ApiError('CANNOT_MODIFY_SELF', 'Change your own password at sign-in instead');
    }
    const existing = await this.find(this.db, id);
    if (existing === null) throw notFound('User');
    if (!existing.passwordAccount) {
      throw new ApiError('CONFLICT', 'This account signs in with LINE or Google');
    }
    this.assertTemporaryPassword(existing.role, password);
    const passwordHash = await hashPassword(password, this.config.password.argon2id);
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      await this.lockAccounts(tx, actorId, id);
      const values = {
        passwordHash,
        mustChangePassword: true,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
      };
      const updated =
        existing.role === 'admin'
          ? await tx
              .update(adminCredentials)
              .set(values)
              .where(eq(adminCredentials.userId, id))
              .returning({ userId: adminCredentials.userId })
          : await tx
              .update(userPasswordCredentials)
              .set(values)
              .where(eq(userPasswordCredentials.userId, id))
              .returning({ userId: userPasswordCredentials.userId });
      if (updated.length === 0) {
        throw new ApiError('CONFLICT', 'This account has no password credentials');
      }
      await revokeUserSessions(tx, id, now);
      await writeAdminAudit(tx, {
        actorId,
        action: 'admin.user.password_reset',
        target: 'user',
        targetId: id,
        meta: {},
        now,
      });
      const after = await this.find(tx, id);
      if (after === null) throw notFound('User');
      return after;
    });
  }
}
