import { AUTH_POOLS, type AuthPool, OIDC_PROVIDERS } from '../domain';

/**
 * Identity subjects (`users.auth_subject`, ADR 0008 section 4). Identity is the pair
 * (`auth_pool`, `auth_subject`). Subjects of ShotX-issued tokens carry their identity provider as
 * a prefix, so two providers never collide inside a pool:
 *
 * - `line:<LINE user id>` and `google:<Google sub>`: users pool, from the provider's verified ID
 *   token;
 * - `local:<lowercased email>`: users pool, the development identity provider
 *   (`POST /auth/dev/login`, APP_STAGE=local only). Local identities are never admins;
 * - `admin:<uuid>`: admins pool, password + TOTP accounts, created by the operator CLI or by an
 *   admin in the admin app (ADR 0010). The uuid is the new `users.id` (adminAccountSubject);
 * - `password:<uuid>`: users pool, photographer accounts an admin created (email + password,
 *   ADR 0010). The uuid is the new `users.id` (passwordAccountSubject). The prefix is distinct
 *   from every OIDC provider, so it can never collide with a LINE or Google subject.
 *
 * Subjects of Cognito tokens keep their raw value (a UUID, no prefix), in either pool.
 */
export const AUTH_SUBJECT_PROVIDERS = [...OIDC_PROVIDERS, 'local', 'admin', 'password'] as const;
export type AuthSubjectProvider = (typeof AUTH_SUBJECT_PROVIDERS)[number];

/** The only pool each prefixed provider may appear in. */
export const AUTH_SUBJECT_PROVIDER_POOL = {
  line: 'users',
  google: 'users',
  local: 'users',
  admin: 'admins',
  password: 'users',
} as const satisfies Record<AuthSubjectProvider, AuthPool>;

/**
 * Providers of email + password accounts (ADR 0010): `admin` (admins pool) and `password`
 * (photographers, users pool). Their emails are unique ignoring ASCII case across both pools
 * (`users_password_account_email_unique`, see normalizeAccountEmail).
 */
export const PASSWORD_ACCOUNT_PROVIDERS = ['admin', 'password'] as const;
export type PasswordAccountProvider = (typeof PASSWORD_ACCOUNT_PROVIDERS)[number];

/** Longest `auth_subject` (prefix included). */
export const AUTH_SUBJECT_MAX_LENGTH = 255;

/** Printable ASCII without spaces: provider ids and emails fit; control characters never do. */
const SUBJECT_ID = /^[!-~]+$/;

/**
 * `<provider>:<id>`. Throws RangeError when `id` is empty, has spaces or non-ASCII characters, or
 * the result is longer than AUTH_SUBJECT_MAX_LENGTH.
 */
export function authSubject(provider: AuthSubjectProvider, id: string): string {
  if (!(AUTH_SUBJECT_PROVIDERS as readonly string[]).includes(provider)) {
    throw new RangeError(`Unknown auth subject provider ${String(provider)}`);
  }
  if (!SUBJECT_ID.test(id)) {
    throw new RangeError('Auth subject id must be non-empty printable ASCII without spaces');
  }
  const subject = `${provider}:${id}`;
  if (subject.length > AUTH_SUBJECT_MAX_LENGTH) {
    throw new RangeError(`Auth subject must be at most ${AUTH_SUBJECT_MAX_LENGTH} characters`);
  }
  return subject;
}

/**
 * The subject of a development login: `local:` plus the trimmed, lowercased email, so the same
 * email always signs in to the same local account.
 */
export function localDevSubject(email: string): string {
  return authSubject('local', email.trim().toLowerCase());
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function accountSubject(provider: PasswordAccountProvider, userId: string): string {
  const id = userId.toLowerCase();
  if (!UUID.test(id)) throw new RangeError('userId must be a uuid');
  return authSubject(provider, id);
}

/**
 * `admin:<users.id>` (lowercase uuid): the subject of an admin account, created by the operator
 * CLI or in the admin app. Generate the id first (or use the inserted row's id) so the subject
 * and the row agree. Throws RangeError for a non-uuid.
 */
export function adminAccountSubject(userId: string): string {
  return accountSubject('admin', userId);
}

/**
 * `password:<users.id>` (lowercase uuid): the users-pool subject of a photographer account an
 * admin created (ADR 0010). Throws RangeError for a non-uuid.
 */
export function passwordAccountSubject(userId: string): string {
  return accountSubject('password', userId);
}

/** True for `admin:` and `password:` subjects (email + password accounts). */
export function isPasswordAccountSubject(subject: string): boolean {
  const parsed = parseAuthSubject(subject);
  return (
    parsed !== null && (PASSWORD_ACCOUNT_PROVIDERS as readonly string[]).includes(parsed.provider)
  );
}

export type ParsedAuthSubject =
  | { provider: AuthSubjectProvider; id: string }
  /** A raw Cognito `sub` (no prefix). */
  | { provider: 'cognito'; id: string };

/**
 * Splits a stored subject. A value without `:` is a legacy Cognito `sub`. Null for an empty or
 * over-long value, an unknown prefix, or an invalid id.
 */
export function parseAuthSubject(subject: string): ParsedAuthSubject | null {
  if (subject.length === 0 || subject.length > AUTH_SUBJECT_MAX_LENGTH) return null;
  const colon = subject.indexOf(':');
  if (colon === -1) return SUBJECT_ID.test(subject) ? { provider: 'cognito', id: subject } : null;
  const provider = subject.slice(0, colon);
  const id = subject.slice(colon + 1);
  if (!(AUTH_SUBJECT_PROVIDERS as readonly string[]).includes(provider)) return null;
  if (!SUBJECT_ID.test(id)) return null;
  return { provider: provider as AuthSubjectProvider, id };
}

/**
 * True when `subject` may exist in `pool`: a prefixed subject only in its provider's pool
 * (AUTH_SUBJECT_PROVIDER_POOL; so `local:` and `line:` never reach the admins pool), a legacy
 * Cognito subject in either pool.
 */
export function isAuthSubjectInPool(subject: string, pool: AuthPool): boolean {
  if (!(AUTH_POOLS as readonly string[]).includes(pool)) return false;
  const parsed = parseAuthSubject(subject);
  if (parsed === null) return false;
  return parsed.provider === 'cognito' || AUTH_SUBJECT_PROVIDER_POOL[parsed.provider] === pool;
}
