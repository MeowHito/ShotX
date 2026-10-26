import { z } from 'zod';
import { AUTH_TOKEN_ALGORITHM, AUTH_TOKEN_AUDIENCES, authTokenIssuer } from '../account/tokens';
import type { AuthPool, OidcProvider } from '../domain';
import { type Env, parseEnv } from './env';
import type { RateLimitRule } from './face';
import {
  appStage,
  int,
  SECONDS_PER_DAY,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
  secret,
} from './fields';
import {
  EXAMPLE_BFF_KEY_FINGERPRINTS,
  EXAMPLE_SIGNING_KEY_FINGERPRINTS,
  EXAMPLE_TOTP_KEY_FINGERPRINTS,
  isPublishedExample,
} from './example-secrets';
import { pemDer, publicKeyDerOf } from './node-crypto';
import { assertLocalStage, isLocalStage } from './stage-gate';

// --- Provider (web, admin and api) ---------------------------------------------------------------

/**
 * Who signs people in (ADR 0008 section 4):
 * - `cognito`: the Cognito user pools (ADR 0002). The default, so every AWS stage stays on it
 *   until infra/ is removed;
 * - `shotx`: the API issues its own tokens: LINE and Google (OIDC, run by the API) for the users
 *   pool, email + password + TOTP for the admins pool. Settings: loadShotxAuthConfig;
 * - `local`: `shotx` plus the development identity provider (`POST /auth/dev/login`, any email,
 *   users pool only). Refused anywhere but APP_STAGE=local with a non-production NODE_ENV.
 */
export const AUTH_PROVIDER_NAMES = ['cognito', 'shotx', 'local'] as const;
export type AuthProviderName = (typeof AUTH_PROVIDER_NAMES)[number];

/** True for the providers whose tokens the API issues (`shotx`, `local`). */
export function apiIssuesTokens(provider: AuthProviderName): provider is 'shotx' | 'local' {
  return provider === 'shotx' || provider === 'local';
}

const authProviderEnvSchema = z.object({
  AUTH_PROVIDER: z.enum(AUTH_PROVIDER_NAMES).default('cognito'),
});

export type AuthProviderConfig = { provider: AuthProviderName };

/**
 * Reads AUTH_PROVIDER (default `cognito`). Holds no token settings (web and admin read it too);
 * the API reads those with loadShotxAuthConfig. `local` is refused outside APP_STAGE=local.
 */
export function loadAuthProviderConfig(env: Env): AuthProviderConfig {
  const { AUTH_PROVIDER } = parseEnv(authProviderEnvSchema, env, 'auth provider');
  if (AUTH_PROVIDER === 'local') assertLocalStage(env, 'AUTH_PROVIDER=local', 'auth provider');
  return { provider: AUTH_PROVIDER };
}

const LOCAL_ONLY_STAGE = 'local';

// --- BFF key (web, admin and api) ----------------------------------------------------------------

const bffEnvSchema = z.object({
  AUTH_PROVIDER: z.enum(AUTH_PROVIDER_NAMES).default('cognito'),
  /** Shared by web, admin and api; at least 32 characters. */
  AUTH_BFF_KEY: z.string().min(32, { error: 'must be at least 32 characters' }).optional(),
});

export interface BffAuthConfig {
  /**
   * Sent by web and admin in BFF_KEY_HEADER on every server-side call to the API (BFF proxy, SSR
   * and `bff` routes). Secret: never log it.
   */
  key: string;
}

/**
 * Reads AUTH_BFF_KEY (web, admin and api). Required with AUTH_PROVIDER=shotx or local, where the
 * `bff` sign-in routes need it. Optional with `cognito`: null when unset (AWS stages today), and
 * when set it lets the BFFs pass the client IP (BFF_CLIENT_IP_HEADER) there too. The published
 * .env.example value is refused anywhere but APP_STAGE=local.
 */
export function loadBffAuthConfig(env: Env): BffAuthConfig | null {
  const e = parseEnv(bffEnvSchema, env, 'BFF auth');
  if (e.AUTH_PROVIDER === 'local') assertLocalStage(env, 'AUTH_PROVIDER=local', 'BFF auth');
  if (e.AUTH_BFF_KEY === undefined) {
    if (e.AUTH_PROVIDER === 'cognito') return null;
    throw new Error('Invalid BFF auth configuration: AUTH_BFF_KEY is required');
  }
  if (
    !isLocalStage(env, 'BFF auth') &&
    isPublishedExample(EXAMPLE_BFF_KEY_FINGERPRINTS, e.AUTH_BFF_KEY)
  ) {
    throw new Error(
      `Invalid BFF auth configuration: AUTH_BFF_KEY is the published .env.example placeholder (allowed only on APP_STAGE=${LOCAL_ONLY_STAGE}); generate your own`,
    );
  }
  return { key: e.AUTH_BFF_KEY };
}

// --- Token issuer (api) --------------------------------------------------------------------------

/** Environment variables of each pool's signing keys. */
export const AUTH_SIGNING_KEY_ENV = {
  users: {
    privateKey: 'AUTH_USERS_SIGNING_KEY',
    keyId: 'AUTH_USERS_SIGNING_KEY_ID',
    previousPublicKey: 'AUTH_USERS_PREVIOUS_PUBLIC_KEY',
    previousKeyId: 'AUTH_USERS_PREVIOUS_KEY_ID',
  },
  admins: {
    privateKey: 'AUTH_ADMINS_SIGNING_KEY',
    keyId: 'AUTH_ADMINS_SIGNING_KEY_ID',
    previousPublicKey: 'AUTH_ADMINS_PREVIOUS_PUBLIC_KEY',
    previousKeyId: 'AUTH_ADMINS_PREVIOUS_KEY_ID',
  },
} as const satisfies Record<
  AuthPool,
  { privateKey: string; keyId: string; previousPublicKey: string; previousKeyId: string }
>;

// DER prefixes of Ed25519 keys (RFC 8410): PKCS#8 v1 private key and SubjectPublicKeyInfo.
const ED25519_PKCS8_PREFIX = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
const ED25519_SPKI_PREFIX = [
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

function decodeBase64(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * An Ed25519 key as PEM (`-----BEGIN PRIVATE KEY-----` / `PUBLIC KEY`, literal `\n` allowed so it
 * fits on one line) or as the bare base64 of its DER, which needs no quoting in env files:
 * `openssl genpkey -algorithm ed25519 -outform DER | base64` (private) and
 * `openssl pkey -in key.pem -pubout -outform DER | base64` (public). Returned as normalized PEM.
 * Error messages never repeat the value.
 */
const ed25519Key = (kind: 'private' | 'public') => {
  const label = kind === 'private' ? 'PRIVATE KEY' : 'PUBLIC KEY';
  const prefix = kind === 'private' ? ED25519_PKCS8_PREFIX : ED25519_SPKI_PREFIX;
  const length = prefix.length + 32;
  return secret().transform((value, ctx) => {
    const text = value.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').trim();
    let body = text;
    if (text.startsWith('-----')) {
      const pem = new RegExp(
        `^-----BEGIN ${label}-----\\n([A-Za-z0-9+/=\\n]+)\\n-----END ${label}-----$`,
      );
      body = pem.exec(text)?.[1]?.replace(/\n/g, '') ?? '';
    }
    const der = decodeBase64(body);
    if (der === null || der.length !== length || prefix.some((byte, i) => der[i] !== byte)) {
      ctx.addIssue({
        code: 'custom',
        message: `must be an Ed25519 ${kind} key (${kind === 'private' ? 'PKCS#8' : 'SPKI'} PEM or base64 DER)`,
      });
      return z.NEVER;
    }
    return `-----BEGIN ${label}-----\n${encodeBase64(der)}\n-----END ${label}-----\n`;
  });
};

/** 32 bytes, standard base64 (`openssl rand -base64 32`). Returned as bytes. */
const aes256Key = () =>
  secret().transform((value, ctx) => {
    const bytes = decodeBase64(value.trim());
    if (bytes === null || bytes.length !== 32) {
      ctx.addIssue({ code: 'custom', message: 'must be 32 bytes, base64 encoded' });
      return z.NEVER;
    }
    return bytes;
  });

/**
 * After a refresh rotated a token, presenting that same token again within this many seconds
 * returns the same successor instead of REFRESH_TOKEN_REUSED (two tabs or a retried request
 * racing). 0 turns it off. See refreshBodySchema. Read by the api (loadShotxAuthConfig) and by
 * web and admin (loadAuthClientConfig), so both sides agree.
 */
const refreshReuseGraceSeconds = () => int(0, 60).default(10);

const keyId = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, { error: 'must be 1-64 letters, digits, ., _ or -' });
const requests = int(1, 1_000_000);
const windowSeconds = int(1, SECONDS_PER_DAY);

const shotxAuthEnvSchema = z
  .object({
    AUTH_PROVIDER: z.enum(AUTH_PROVIDER_NAMES).default('cognito'),
    APP_STAGE: appStage(),
    AUTH_USERS_SIGNING_KEY: ed25519Key('private').optional(),
    AUTH_USERS_SIGNING_KEY_ID: keyId.default('users-1'),
    AUTH_USERS_PREVIOUS_PUBLIC_KEY: ed25519Key('public').optional(),
    AUTH_USERS_PREVIOUS_KEY_ID: keyId.optional(),
    AUTH_ADMINS_SIGNING_KEY: ed25519Key('private').optional(),
    AUTH_ADMINS_SIGNING_KEY_ID: keyId.default('admins-1'),
    AUTH_ADMINS_PREVIOUS_PUBLIC_KEY: ed25519Key('public').optional(),
    AUTH_ADMINS_PREVIOUS_KEY_ID: keyId.optional(),
    /** Access tokens (JWT) of both pools. */
    AUTH_ACCESS_TOKEN_TTL_SECONDS: int(60, SECONDS_PER_HOUR).default(15 * SECONDS_PER_MINUTE),
    /**
     * Lifetime of a sign-in's refresh token family, counted from the sign-in: rotation never
     * extends it (as with Cognito). Users 30 days, admins 12 hours (ADR 0002).
     */
    AUTH_USERS_REFRESH_TOKEN_TTL_SECONDS: int(SECONDS_PER_HOUR, 90 * SECONDS_PER_DAY).default(
      30 * SECONDS_PER_DAY,
    ),
    AUTH_ADMINS_REFRESH_TOKEN_TTL_SECONDS: int(15 * SECONDS_PER_MINUTE, SECONDS_PER_DAY).default(
      12 * SECONDS_PER_HOUR,
    ),
    /** OIDC state, nonce and PKCE verifier in Redis (one-time). */
    AUTH_LOGIN_STATE_TTL_SECONDS: int(60, 30 * SECONDS_PER_MINUTE).default(10 * SECONDS_PER_MINUTE),
    /** Timeout of each HTTP call to LINE or Google (token endpoint, JWKS, verify endpoint). */
    AUTH_OIDC_HTTP_TIMEOUT_MS: int(1000, 60_000).default(10_000),
    /** See refreshReuseGraceSeconds (shared with loadAuthClientConfig). */
    AUTH_REFRESH_REUSE_GRACE_SECONDS: refreshReuseGraceSeconds(),
    /** OIDC start, OIDC callback and dev login, per client IP. */
    AUTH_LOGIN_RATE_PER_IP: requests.default(30),
    AUTH_LOGIN_RATE_PER_IP_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
    /** LINE Login channel (users pool). */
    LINE_LOGIN_CHANNEL_ID: z
      .string()
      .regex(/^\d{1,20}$/, { error: 'must be a LINE channel id (digits)' })
      .optional(),
    LINE_LOGIN_CHANNEL_SECRET: secret().optional(),
    /** Google OAuth client (users pool). */
    GOOGLE_OAUTH_CLIENT_ID: z
      .string()
      .regex(/^[0-9]+-[0-9A-Za-z_]+\.apps\.googleusercontent\.com$/, {
        error: 'must be a Google OAuth client id (...apps.googleusercontent.com)',
      })
      .optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: secret().optional(),
    /** AES-256-GCM key of admin_credentials.totp_secret_encrypted. */
    ADMIN_TOTP_ENCRYPTION_KEY: aes256Key().optional(),
    ADMIN_TOTP_PERIOD_SECONDS: int(15, 120).default(30),
    ADMIN_TOTP_DIGITS: z.coerce
      .number()
      .int()
      .refine((d) => d === 6 || d === 8, { error: 'must be 6 or 8' })
      .default(6),
    /** Steps accepted before and after the current one. */
    ADMIN_TOTP_WINDOW: int(0, 2).default(1),
    /** Between POST /auth/admin/login and POST /auth/admin/mfa (one-time). */
    /**
     * How long an unconfirmed TOTP enrolment (admin_credentials.totp_confirmed_at null, counted
     * from the enrolment by the operator CLI) can be confirmed by a first sign-in. After it the
     * account needs the CLI's reset-totp. Enforced by the api.
     */
    ADMIN_TOTP_ENROLMENT_TTL_SECONDS: int(SECONDS_PER_HOUR, 30 * SECONDS_PER_DAY).default(
      7 * SECONDS_PER_DAY,
    ),
    ADMIN_MFA_CHALLENGE_TTL_SECONDS: int(60, 15 * SECONDS_PER_MINUTE).default(
      5 * SECONDS_PER_MINUTE,
    ),
    /** Enforced by the operator CLI when it sets a password (infra/cdk.json adminPasswordMinLength). */
    ADMIN_PASSWORD_MIN_LENGTH: int(12, 128).default(14),
    /** Failed admin sign-ins (password or code), per normalized email and per client IP. */
    ADMIN_LOGIN_RATE_PER_ACCOUNT: requests.default(5),
    ADMIN_LOGIN_RATE_PER_ACCOUNT_WINDOW_SECONDS: windowSeconds.default(15 * SECONDS_PER_MINUTE),
    ADMIN_LOGIN_RATE_PER_IP: requests.default(20),
    ADMIN_LOGIN_RATE_PER_IP_WINDOW_SECONDS: windowSeconds.default(15 * SECONDS_PER_MINUTE),
    /** Consecutive failures that lock an admin account (admin_credentials.locked_until), and for how long. */
    ADMIN_LOGIN_LOCKOUT_THRESHOLD: int(3, 100).default(10),
    ADMIN_LOGIN_LOCKOUT_SECONDS: int(60, SECONDS_PER_DAY).default(15 * SECONDS_PER_MINUTE),
  })
  .superRefine((e, ctx) => {
    const together = (a: keyof typeof e, b: keyof typeof e) => {
      if ((e[a] === undefined) !== (e[b] === undefined)) {
        ctx.addIssue({ code: 'custom', message: `${a} and ${b} must be set together` });
      }
    };
    together('AUTH_USERS_PREVIOUS_PUBLIC_KEY', 'AUTH_USERS_PREVIOUS_KEY_ID');
    together('AUTH_ADMINS_PREVIOUS_PUBLIC_KEY', 'AUTH_ADMINS_PREVIOUS_KEY_ID');
    together('LINE_LOGIN_CHANNEL_ID', 'LINE_LOGIN_CHANNEL_SECRET');
    together('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET');
    const kids = [
      e.AUTH_USERS_SIGNING_KEY_ID,
      e.AUTH_USERS_PREVIOUS_KEY_ID,
      e.AUTH_ADMINS_SIGNING_KEY_ID,
      e.AUTH_ADMINS_PREVIOUS_KEY_ID,
    ].filter((k) => k !== undefined);
    if (new Set(kids).size !== kids.length) {
      ctx.addIssue({ code: 'custom', message: 'every signing key id must be different' });
    }
    if (
      e.AUTH_USERS_SIGNING_KEY !== undefined &&
      e.AUTH_USERS_SIGNING_KEY === e.AUTH_ADMINS_SIGNING_KEY
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'AUTH_USERS_SIGNING_KEY and AUTH_ADMINS_SIGNING_KEY must be different keys',
      });
    }
    for (const pool of ['USERS', 'ADMINS'] as const) {
      if (e[`AUTH_${pool}_REFRESH_TOKEN_TTL_SECONDS`] <= e.AUTH_ACCESS_TOKEN_TTL_SECONDS) {
        ctx.addIssue({
          code: 'custom',
          message: `AUTH_${pool}_REFRESH_TOKEN_TTL_SECONDS must be longer than AUTH_ACCESS_TOKEN_TTL_SECONDS`,
        });
      }
    }
  });

/** One pool's signing keys. Private keys are secret: never log them. */
export interface AuthSigningKeys {
  /** Signs new tokens (`kid` in the JWS header). Normalized PKCS#8 PEM. */
  current: { kid: string; privateKeyPem: string };
  /** Still accepted when verifying, during a rotation. Normalized SPKI PEM. */
  previous: { kid: string; publicKeyPem: string } | null;
}

export interface PoolTokenConfig {
  /** `iss`: authTokenIssuer(stage, pool). */
  issuer: string;
  /** `aud`: AUTH_TOKEN_AUDIENCES[pool]. */
  audience: string;
  refreshTokenTtlSeconds: number;
  signing: AuthSigningKeys;
}

export interface OidcClientConfig {
  clientId: string;
  /** Secret: never log it. */
  clientSecret: string;
}

export interface AdminSignInConfig {
  totp: {
    /** AES-256-GCM key. Secret: never log it. */
    encryptionKey: Uint8Array;
    periodSeconds: number;
    digits: 6 | 8;
    window: number;
  };
  challengeTtlSeconds: number;
  /** ADMIN_TOTP_ENROLMENT_TTL_SECONDS. */
  totpEnrolmentTtlSeconds: number;
  passwordMinLength: number;
  rateLimits: { perAccount: RateLimitRule; perIp: RateLimitRule };
  lockout: { threshold: number; seconds: number };
}

export interface ShotxAuthConfig {
  provider: 'shotx' | 'local';
  algorithm: typeof AUTH_TOKEN_ALGORITHM;
  accessTokenTtlSeconds: number;
  /** Null when the admins pool is off (allowed only with `local`). */
  pools: { users: PoolTokenConfig; admins: PoolTokenConfig | null };
  loginStateTtlSeconds: number;
  loginRateLimitPerIp: RateLimitRule;
  /** AUTH_OIDC_HTTP_TIMEOUT_MS. */
  oidcHttpTimeoutMs: number;
  /** AUTH_REFRESH_REUSE_GRACE_SECONDS (0: off). */
  refreshReuseGraceSeconds: number;
  /** Null for a provider without credentials (allowed only with `local`). */
  oidc: Record<OidcProvider, OidcClientConfig | null>;
  /** The development identity provider: `local` only, and always the users pool. */
  devLogin: { pool: 'users' } | null;
  /** Null when the admins pool is off. */
  admin: AdminSignInConfig | null;
}

/**
 * The API's token issuer settings (AUTH_PROVIDER=shotx or local; throws with `cognito`).
 *
 * - `shotx`: everything is required: AUTH_USERS_SIGNING_KEY, AUTH_ADMINS_SIGNING_KEY (different
 *   keys), LINE_LOGIN_CHANNEL_ID/SECRET, GOOGLE_OAUTH_CLIENT_ID/SECRET and
 *   ADMIN_TOTP_ENCRYPTION_KEY.
 * - `local` (APP_STAGE=local only): AUTH_USERS_SIGNING_KEY is required; LINE and Google are each
 *   enabled only when configured; the admins pool only when AUTH_ADMINS_SIGNING_KEY and
 *   ADMIN_TOTP_ENCRYPTION_KEY are both set. The dev login is on and issues users-pool tokens only.
 *
 * Each pool has its own Ed25519 key and `kid`, plus an optional previous public key and `kid`
 * accepted while rotating; a previous key may not be the other pool's current key. The published
 * .env.example keys are refused anywhere but APP_STAGE=local. Error messages never contain keys or
 * secrets.
 */
export function loadShotxAuthConfig(env: Env): ShotxAuthConfig {
  const e = parseEnv(shotxAuthEnvSchema, env, 'ShotX auth');
  const fail = (message: string): never => {
    throw new Error(`Invalid ShotX auth configuration: ${message}`);
  };
  if (e.AUTH_PROVIDER === 'cognito') {
    return fail('AUTH_PROVIDER must be shotx or local to issue tokens');
  }
  const local = e.AUTH_PROVIDER === 'local';
  if (local) assertLocalStage(env, 'AUTH_PROVIDER=local', 'ShotX auth');

  const usersKey = e.AUTH_USERS_SIGNING_KEY ?? fail('AUTH_USERS_SIGNING_KEY is required');
  const adminsOn =
    e.AUTH_ADMINS_SIGNING_KEY !== undefined || e.ADMIN_TOTP_ENCRYPTION_KEY !== undefined;
  if (!local || adminsOn) {
    if (e.AUTH_ADMINS_SIGNING_KEY === undefined) fail('AUTH_ADMINS_SIGNING_KEY is required');
    if (e.ADMIN_TOTP_ENCRYPTION_KEY === undefined) fail('ADMIN_TOTP_ENCRYPTION_KEY is required');
  }
  if (!local) {
    if (e.LINE_LOGIN_CHANNEL_ID === undefined) fail('LINE_LOGIN_CHANNEL_ID is required');
    if (e.GOOGLE_OAUTH_CLIENT_ID === undefined) fail('GOOGLE_OAUTH_CLIENT_ID is required');
  }

  // The .env.example placeholders are public: refused anywhere but APP_STAGE=local.
  if (!isLocalStage(env, 'ShotX auth')) {
    const published = (name: string) =>
      fail(
        `${name} is the published .env.example placeholder (allowed only on APP_STAGE=${LOCAL_ONLY_STAGE}); generate your own`,
      );
    const keys = [
      ['AUTH_USERS_SIGNING_KEY', e.AUTH_USERS_SIGNING_KEY],
      ['AUTH_ADMINS_SIGNING_KEY', e.AUTH_ADMINS_SIGNING_KEY],
      ['AUTH_USERS_PREVIOUS_PUBLIC_KEY', e.AUTH_USERS_PREVIOUS_PUBLIC_KEY],
      ['AUTH_ADMINS_PREVIOUS_PUBLIC_KEY', e.AUTH_ADMINS_PREVIOUS_PUBLIC_KEY],
    ] as const;
    for (const [name, pem] of keys) {
      if (pem !== undefined && isPublishedExample(EXAMPLE_SIGNING_KEY_FINGERPRINTS, pemDer(pem))) {
        published(name);
      }
    }
    if (
      e.ADMIN_TOTP_ENCRYPTION_KEY !== undefined &&
      isPublishedExample(EXAMPLE_TOTP_KEY_FINGERPRINTS, e.ADMIN_TOTP_ENCRYPTION_KEY)
    ) {
      published('ADMIN_TOTP_ENCRYPTION_KEY');
    }
  }

  // A pool's previous key must never be the other pool's current key: tokens signed for one pool
  // would verify in the other.
  const sameBytes = (a: Uint8Array, b: Uint8Array) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);
  const crossPool = [
    ['AUTH_USERS_PREVIOUS_PUBLIC_KEY', e.AUTH_USERS_PREVIOUS_PUBLIC_KEY, e.AUTH_ADMINS_SIGNING_KEY],
    ['AUTH_ADMINS_PREVIOUS_PUBLIC_KEY', e.AUTH_ADMINS_PREVIOUS_PUBLIC_KEY, usersKey],
  ] as const;
  for (const [name, previous, otherCurrent] of crossPool) {
    if (
      previous !== undefined &&
      otherCurrent !== undefined &&
      sameBytes(pemDer(previous), publicKeyDerOf(otherCurrent))
    ) {
      fail(`${name} must not be the other pool's current signing key`);
    }
  }

  const pool = (
    name: AuthPool,
    privateKeyPem: string,
    kid: string,
    previousPem: string | undefined,
    previousKid: string | undefined,
    refreshTokenTtlSeconds: number,
  ): PoolTokenConfig => ({
    issuer: authTokenIssuer(e.APP_STAGE, name),
    audience: AUTH_TOKEN_AUDIENCES[name],
    refreshTokenTtlSeconds,
    signing: {
      current: { kid, privateKeyPem },
      previous:
        previousPem !== undefined && previousKid !== undefined
          ? { kid: previousKid, publicKeyPem: previousPem }
          : null,
    },
  });

  const adminsKey = e.AUTH_ADMINS_SIGNING_KEY;
  const totpKey = e.ADMIN_TOTP_ENCRYPTION_KEY;
  return {
    provider: e.AUTH_PROVIDER,
    algorithm: AUTH_TOKEN_ALGORITHM,
    accessTokenTtlSeconds: e.AUTH_ACCESS_TOKEN_TTL_SECONDS,
    pools: {
      users: pool(
        'users',
        usersKey,
        e.AUTH_USERS_SIGNING_KEY_ID,
        e.AUTH_USERS_PREVIOUS_PUBLIC_KEY,
        e.AUTH_USERS_PREVIOUS_KEY_ID,
        e.AUTH_USERS_REFRESH_TOKEN_TTL_SECONDS,
      ),
      admins:
        adminsKey === undefined
          ? null
          : pool(
              'admins',
              adminsKey,
              e.AUTH_ADMINS_SIGNING_KEY_ID,
              e.AUTH_ADMINS_PREVIOUS_PUBLIC_KEY,
              e.AUTH_ADMINS_PREVIOUS_KEY_ID,
              e.AUTH_ADMINS_REFRESH_TOKEN_TTL_SECONDS,
            ),
    },
    loginStateTtlSeconds: e.AUTH_LOGIN_STATE_TTL_SECONDS,
    oidcHttpTimeoutMs: e.AUTH_OIDC_HTTP_TIMEOUT_MS,
    refreshReuseGraceSeconds: e.AUTH_REFRESH_REUSE_GRACE_SECONDS,
    loginRateLimitPerIp: {
      limit: e.AUTH_LOGIN_RATE_PER_IP,
      windowSeconds: e.AUTH_LOGIN_RATE_PER_IP_WINDOW_SECONDS,
    },
    oidc: {
      line:
        e.LINE_LOGIN_CHANNEL_ID !== undefined && e.LINE_LOGIN_CHANNEL_SECRET !== undefined
          ? { clientId: e.LINE_LOGIN_CHANNEL_ID, clientSecret: e.LINE_LOGIN_CHANNEL_SECRET }
          : null,
      google:
        e.GOOGLE_OAUTH_CLIENT_ID !== undefined && e.GOOGLE_OAUTH_CLIENT_SECRET !== undefined
          ? { clientId: e.GOOGLE_OAUTH_CLIENT_ID, clientSecret: e.GOOGLE_OAUTH_CLIENT_SECRET }
          : null,
    },
    devLogin: local ? { pool: 'users' } : null,
    admin:
      totpKey === undefined
        ? null
        : {
            totp: {
              encryptionKey: totpKey,
              periodSeconds: e.ADMIN_TOTP_PERIOD_SECONDS,
              digits: e.ADMIN_TOTP_DIGITS,
              window: e.ADMIN_TOTP_WINDOW,
            },
            challengeTtlSeconds: e.ADMIN_MFA_CHALLENGE_TTL_SECONDS,
            totpEnrolmentTtlSeconds: e.ADMIN_TOTP_ENROLMENT_TTL_SECONDS,
            passwordMinLength: e.ADMIN_PASSWORD_MIN_LENGTH,
            rateLimits: {
              perAccount: {
                limit: e.ADMIN_LOGIN_RATE_PER_ACCOUNT,
                windowSeconds: e.ADMIN_LOGIN_RATE_PER_ACCOUNT_WINDOW_SECONDS,
              },
              perIp: {
                limit: e.ADMIN_LOGIN_RATE_PER_IP,
                windowSeconds: e.ADMIN_LOGIN_RATE_PER_IP_WINDOW_SECONDS,
              },
            },
            lockout: {
              threshold: e.ADMIN_LOGIN_LOCKOUT_THRESHOLD,
              seconds: e.ADMIN_LOGIN_LOCKOUT_SECONDS,
            },
          },
  };
}

// --- Auth client settings (web and admin) -----------------------------------------------------

const authClientEnvSchema = z.object({
  AUTH_REFRESH_REUSE_GRACE_SECONDS: refreshReuseGraceSeconds(),
  /** Timeout of each call web or admin makes to the API's `/auth/*` routes. */
  AUTH_CLIENT_TIMEOUT_MS: int(1000, 120_000).default(15_000),
});

export interface AuthClientConfig {
  /** AUTH_REFRESH_REUSE_GRACE_SECONDS, the same value the API uses (0: off). */
  refreshReuseGraceSeconds: number;
  /** AUTH_CLIENT_TIMEOUT_MS. */
  callTimeoutMs: number;
}

/**
 * Sign-in settings web and admin need without any signing key: AUTH_REFRESH_REUSE_GRACE_SECONDS
 * (default 10, same key and rules as the API) and AUTH_CLIENT_TIMEOUT_MS (default 15000).
 */
export function loadAuthClientConfig(env: Env): AuthClientConfig {
  const e = parseEnv(authClientEnvSchema, env, 'auth client');
  return {
    refreshReuseGraceSeconds: e.AUTH_REFRESH_REUSE_GRACE_SECONDS,
    callTimeoutMs: e.AUTH_CLIENT_TIMEOUT_MS,
  };
}
