import { storageUsage, userPasswordCredentials, users } from '@shotx/db';
import { passwordAccountSubject } from '@shotx/shared';
import { type Queryable } from '../db/db';
import { newId } from '../drive/folders';

/** The two unique indexes an account email can collide with (EMAIL_TAKEN). */
export const ACCOUNT_EMAIL_INDEXES = [
  'users_password_account_email_unique',
  'users_admin_email_unique',
] as const;

/**
 * Creates a photographer email + password account (ADR 0010) inside the caller's transaction: the
 * users row (users pool, `password:<id>` subject), its user_password_credentials and a
 * storage_usage row. Used by POST /admin/users (`createdById` the acting admin, a temporary
 * password) and by ADR 0026 self sign-up and paid orders (`createdById` null). `passwordHash` is
 * an argon2id hash made by the caller; never a plaintext password. A taken email throws the
 * unique violation of one of ACCOUNT_EMAIL_INDEXES.
 */
export async function insertPhotographerAccount(
  tx: Queryable,
  input: {
    id?: string;
    email: string;
    name: string | null;
    passwordHash: string;
    mustChangePassword: boolean;
    createdById: string | null;
    now: Date;
  },
): Promise<string> {
  const id = input.id ?? (await newId(tx));
  await tx.insert(users).values({
    id,
    role: 'photographer',
    authPool: 'users',
    authSubject: passwordAccountSubject(id),
    email: input.email,
    name: input.name,
    createdAt: input.now,
    createdById: input.createdById,
  });
  await tx.insert(userPasswordCredentials).values({
    userId: id,
    passwordHash: input.passwordHash,
    mustChangePassword: input.mustChangePassword,
    createdAt: input.now,
    updatedAt: input.now,
  });
  await tx.insert(storageUsage).values({ photographerId: id }).onConflictDoNothing();
  return id;
}
