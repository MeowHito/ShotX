import { z } from 'zod';
import { AUTH_POOLS, type AuthPool } from '../domain';
import { AUTH_SUBJECT_PROVIDERS, isAuthSubjectInPool } from './auth-subject';

// Tokens the API issues itself (AUTH_PROVIDER=shotx or local; ADR 0008 section 4). Pure shapes
// and constants: signing and verification live in the api (jose).

/**
 * JWS algorithm of access tokens: EdDSA with Ed25519 keys. Asymmetric, so the verifying side
 * never holds a key that can mint tokens; Ed25519 signatures are deterministic (no per-signature
 * nonce to get wrong, unlike ES256), keys are 32 bytes and verification is fast. Each pool has
 * its own key (loadShotxAuthConfig), so a bug in the users flow can't mint an admins token.
 */
export const AUTH_TOKEN_ALGORITHM = 'EdDSA';

/** `aud` per pool: users-pool tokens are for the web app, admins-pool tokens for the admin app. */
export const AUTH_TOKEN_AUDIENCES = {
  users: 'shotx-web',
  admins: 'shotx-admin',
} as const satisfies Record<AuthPool, string>;

/**
 * `iss` of the tokens of one pool on one stage, e.g. `urn:shotx:prod:auth:admins`. The stage is
 * part of it, so a token of another stage never verifies even if keys were shared by mistake.
 */
export function authTokenIssuer(stage: string, pool: AuthPool): string {
  if (!/^[a-z][a-z0-9-]{1,15}$/.test(stage)) throw new RangeError('Invalid stage name');
  if (!(AUTH_POOLS as readonly string[]).includes(pool)) throw new RangeError('Invalid pool');
  return `urn:shotx:${stage}:auth:${pool}`;
}

/**
 * Authentication methods (`amr` claim). `pwd`, `otp` and `mfa` are RFC 8176 values; `fed`
 * (signed in at LINE or Google) and `dev` (development login, APP_STAGE=local) are ShotX's.
 * - users pool: `["fed"]`, `["dev"]`, or `["pwd"]` (photographer email + password, ADR 0010);
 * - admins pool: `["pwd", "otp", "mfa"]` after password + TOTP.
 */
export const AUTH_METHODS = ['fed', 'dev', 'pwd', 'otp', 'mfa'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

/** Methods every admins-pool token must carry; without them admin routes answer MFA_REQUIRED. */
export const ADMIN_REQUIRED_AMR = ['pwd', 'otp'] as const satisfies readonly AuthMethod[];

/** True when `amr` satisfies the pool's requirement (admins: ADMIN_REQUIRED_AMR). */
export function hasRequiredAmr(pool: AuthPool, amr: readonly string[]): boolean {
  if (pool === 'users') return true;
  return ADMIN_REQUIRED_AMR.every((method) => amr.includes(method));
}

/** `token_use` of access tokens (refresh tokens are opaque, never JWTs). */
export const ACCESS_TOKEN_USE = 'access';

/**
 * Claim set to `true` on the access tokens of a photographer sign-in whose password is temporary
 * (`user_password_credentials.must_change_password`, ADR 0010). Such a session may only call the
 * routes in PASSWORD_CHANGE_ALLOWED_ROUTES (see api/routes); every other photographer or user
 * route answers PASSWORD_CHANGE_REQUIRED. Users pool and `password:` subjects only; never on
 * admins-pool tokens (admins change a temporary password inside the sign-in steps instead).
 * Refresh re-reads `must_change_password`, so the claim can't outlive the change.
 */
export const PASSWORD_CHANGE_CLAIM = 'pwd_change';

/**
 * Claims of a ShotX access token, without the per-pool checks (see accessTokenClaimsSchemaFor).
 * - `sub`: `users.auth_subject` (prefixed, see account/auth-subject);
 * - `sid`: `auth_sessions.family_id` of the session that issued it (logout, revocation);
 * - `idp`: the identity provider (the subject's prefix);
 * - `amr`: how the person signed in (AUTH_METHODS);
 * - `pwd_change`: see PASSWORD_CHANGE_CLAIM.
 * Email and name are not in access tokens: the token response and GET /me carry them.
 */
export const accessTokenClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1).max(255),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().positive(),
  jti: z.string().min(1).max(64).optional(),
  sid: z.uuid(),
  idp: z.enum(AUTH_SUBJECT_PROVIDERS),
  amr: z.array(z.enum(AUTH_METHODS)).min(1),
  token_use: z.literal(ACCESS_TOKEN_USE),
  /** PASSWORD_CHANGE_CLAIM: present (true) only on restricted photographer sessions. */
  [PASSWORD_CHANGE_CLAIM]: z.literal(true).optional(),
});
export type AccessTokenClaims = z.output<typeof accessTokenClaimsSchema>;

/**
 * accessTokenClaimsSchema plus the rules of one pool on one stage: `iss` and `aud` of the pool,
 * a subject valid in the pool whose prefix matches `idp`, `exp` after `iat`, and the pool's
 * required `amr` (admins: `pwd` and `otp`). The API verifies the signature with the pool's key
 * first, then parses the payload with this.
 */
export function accessTokenClaimsSchemaFor(stage: string, pool: AuthPool) {
  const issuer = authTokenIssuer(stage, pool);
  return accessTokenClaimsSchema
    .refine((c) => c.iss === issuer, { error: 'wrong issuer', path: ['iss'] })
    .refine((c) => c.aud === AUTH_TOKEN_AUDIENCES[pool], { error: 'wrong audience', path: ['aud'] })
    .refine((c) => c.exp > c.iat, { error: 'must expire after it was issued', path: ['exp'] })
    .refine((c) => isAuthSubjectInPool(c.sub, pool) && c.sub.startsWith(`${c.idp}:`), {
      error: 'subject does not belong to this pool or identity provider',
      path: ['sub'],
    })
    .refine((c) => hasRequiredAmr(pool, c.amr), {
      error: 'missing required authentication methods',
      path: ['amr'],
    })
    .refine(
      (c) => c[PASSWORD_CHANGE_CLAIM] !== true || (pool === 'users' && c.idp === 'password'),
      {
        error: 'only photographer password sessions can require a password change',
        path: [PASSWORD_CHANGE_CLAIM],
      },
    );
}

/**
 * Opaque random values the API hands out: refresh tokens, OIDC `state`, admin `challengeId`.
 * 32 bytes from a CSPRNG, base64url without padding (43 characters).
 */
export const OPAQUE_TOKEN_BYTES = 32;
export const opaqueTokenSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, { error: 'must be a 43-character base64url token' });

/**
 * `auth_sessions.refresh_token_hash`: lowercase hex SHA-256 of the refresh token string. The
 * tokens have 256 bits of entropy, so a fast hash is enough (no argon2).
 */
export const REFRESH_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;
