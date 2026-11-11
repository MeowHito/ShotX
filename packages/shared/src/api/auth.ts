import { z } from 'zod';
import { newPasswordSchema } from '../account/password-accounts';
import { opaqueTokenSchema } from '../account/tokens';
import { AUTH_POOLS, OIDC_PROVIDERS } from '../domain';

// Sign-in routes of the API's own token issuer (AUTH_PROVIDER=shotx or local; ADR 0008 section 4).
// With AUTH_PROVIDER=cognito every route here answers NOT_FOUND. All of them are RouteAuth `bff`:
// web and admin call them server-side and keep tokens in their httpOnly session cookies; the
// browser never sees a refresh token.

/**
 * Header with the calling BFF's key: web sends AUTH_BFF_KEY (loadBffAuthConfig), the admin app
 * AUTH_ADMIN_BFF_KEY (loadAdminBffAuthConfig); the API knows both (loadBffKeysConfig). Each sends
 * it on every server-side call to the API: the `/bff/*` proxy, server-side rendering and the
 * `bff` routes. On `bff` and `admin` routes a missing or wrong key, or the other app's key where
 * the route's `bffKey` (BffKeyScope) doesn't accept it, is UNAUTHENTICATED; on other routes a
 * wrong key is ignored (the request is treated as coming from the browser) and only means the
 * client IP header below is not trusted.
 */
export const BFF_KEY_HEADER = 'x-shotx-bff-key';

/**
 * Header with the end user's IP address, set by web and admin on every call that carries
 * BFF_KEY_HEADER (taken from the proxy's X-Forwarded-For). The API trusts it on any route, but
 * only together with a valid BFF key; it replaces web's `cloudfront-viewer-address` forwarding
 * (ADR 0008 section 1). Without a trusted value the API falls back to X-Forwarded-For from a
 * trusted proxy (loadTrustedProxyConfig), then to the socket peer. Per-IP rate limits and
 * `consents.ip_hash` use the result. The reverse proxy strips any copy a client sends.
 */
export const BFF_CLIENT_IP_HEADER = 'x-shotx-client-ip';

export const bffClientIpSchema = z.union([z.ipv4(), z.ipv6()]);

/** The signed-in person as the token response reports it (from the `users` row). */
export const authUserSchema = z.object({
  email: z.string().nullable(),
  name: z.string().nullable(),
});

/**
 * Every sign-in and refresh answers with this. `accessToken` is a JWT (account/tokens:
 * AUTH_TOKEN_ALGORITHM, per-pool `iss`/`aud`, `amr`); `refreshToken` is opaque and single-use
 * (rotated on every refresh). `expiresIn`: seconds the access token lives;
 * `refreshExpiresIn`: seconds until the sign-in's refresh family ends (the cookie's max-age).
 */
export const authTokenResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: opaqueTokenSchema,
  expiresIn: z.number().int().positive(),
  refreshExpiresIn: z.number().int().positive(),
  user: authUserSchema,
});
export type AuthTokenResponse = z.output<typeof authTokenResponseSchema>;

/**
 * What the sign-in page may offer (nothing secret; authProvidersOf builds it from the config).
 * Web reads it to decide what to show: no LINE/Google buttons for providers that are missing, and
 * no `require_login` toggle on the share form when viewerLoginAvailable is false.
 */
export const authProvidersResponseSchema = z.object({
  /**
   * OIDC providers with credentials configured, in OIDC_PROVIDERS order, no duplicates. May be
   * empty: since 2026-11-11 a deployment may run with neither LINE nor Google (photographers and
   * admins sign in with passwords; OIDC is only for viewers of `require_login` shares).
   */
  oidc: z
    .array(z.enum(OIDC_PROVIDERS))
    .max(OIDC_PROVIDERS.length)
    .refine((list) => new Set(list).size === list.length, { error: 'must not repeat a provider' }),
  /** POST /auth/dev/login is available (AUTH_PROVIDER=local). */
  devLogin: z.boolean(),
  /** Admin sign-in (password + TOTP) is available. */
  adminLogin: z.boolean(),
});
export type AuthProvidersResponse = z.output<typeof authProvidersResponseSchema>;

/**
 * True when a viewer can sign in to the users pool (an OIDC provider is enabled, or the dev login
 * with AUTH_PROVIDER=local), so a share may use `require_login`. False: POST /shares and
 * PATCH /shares/:id with `requireLogin: true` answer LOGIN_PROVIDER_UNAVAILABLE, and web hides
 * the toggle. Only meaningful when the API issues tokens (AUTH_PROVIDER=shotx or local); with
 * `cognito` the hosted UI federates LINE/Google and the guard doesn't apply.
 */
export function viewerLoginAvailable(
  providers: Pick<AuthProvidersResponse, 'oidc' | 'devLogin'>,
): boolean {
  return providers.oidc.length > 0 || providers.devLogin;
}

/**
 * Path of the web app's OIDC callback page. `redirectUri` of POST /auth/oidc/:provider/start must
 * be exactly PUBLIC_BASE_URL + this path, and the same URL is registered with LINE and Google.
 */
export const WEB_AUTH_CALLBACK_PATH = '/auth/callback';

export const oidcProviderParamsSchema = z.object({ provider: z.enum(OIDC_PROVIDERS) });

/**
 * Start a LINE or Google sign-in. `redirectUri` must be exactly PUBLIC_BASE_URL +
 * WEB_AUTH_CALLBACK_PATH (e.g. `https://photos.example.com/auth/callback`; no query, no trailing
 * slash), else VALIDATION_FAILED; it is also the URL registered with the provider. The API keeps
 * `state`, the nonce, the PKCE verifier and the redirect URI in Redis for
 * AUTH_LOGIN_STATE_TTL_SECONDS, usable once.
 */
export const oidcStartBodySchema = z.strictObject({
  redirectUri: z.url({ protocol: /^https?$/ }).max(2048),
});
export type OidcStartBody = z.input<typeof oidcStartBodySchema>;

export const oidcStartResponseSchema = z.object({
  /** Send the browser here. */
  authorizationUrl: z.url(),
  /** Also in the URL; the BFF binds it to the browser (cookie) and checks it on the callback. */
  state: opaqueTokenSchema,
});
export type OidcStartResponse = z.output<typeof oidcStartResponseSchema>;

/**
 * Finish a sign-in with the `state` and `code` the provider sent to the callback. The state
 * names the provider. Unknown, expired or used state: LOGIN_STATE_INVALID. If the provider
 * redirected with `error` instead of a code (the person cancelled), the BFF doesn't call this.
 */
export const oidcCallbackBodySchema = z.strictObject({
  state: opaqueTokenSchema,
  code: z.string().min(1).max(2048),
});
export type OidcCallbackBody = z.input<typeof oidcCallbackBodySchema>;

/**
 * Development sign-in (AUTH_PROVIDER=local, APP_STAGE=local only; NOT_FOUND anywhere else): any
 * email, users pool only, subject localDevSubject(email). Never an admin.
 */
export const devLoginBodySchema = z.strictObject({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(200),
});
export type DevLoginBody = z.input<typeof devLoginBodySchema>;

/**
 * Rotate a refresh token. `pool` is the pool the calling app serves (web: `users`, admin:
 * `admins`); a token of the other pool is REFRESH_TOKEN_INVALID. A token that was already rotated
 * is REFRESH_TOKEN_REUSED and revokes its whole family, except within
 * AUTH_REFRESH_REUSE_GRACE_SECONDS of its rotation: then the answer is the same successor (same
 * refresh token, a fresh access token), so two tabs or a retried request racing the rotation
 * don't sign the person out. Only the direct successor is returned, and only while it is itself
 * unrevoked.
 */
export const refreshBodySchema = z.strictObject({
  refreshToken: opaqueTokenSchema,
  pool: z.enum(AUTH_POOLS),
});
export type RefreshBody = z.input<typeof refreshBodySchema>;

/** Sign out: revokes the token's family. Idempotent (unknown or revoked tokens are fine). */
export const logoutBodySchema = z.strictObject({ refreshToken: opaqueTokenSchema });
export type LogoutBody = z.input<typeof logoutBodySchema>;

/** A password typed at sign-in: anything up to 1024 characters (never trimmed). */
const signInPasswordSchema = z.string().min(1).max(1024);

// --- Admin sign-in (password, then steps, then TOTP) ---------------------------------------------

/**
 * Admin step 1. Wrong email or password, or no such admin: INVALID_CREDENTIALS (one code, same
 * timing). Too many failures per account or IP, or a locked account: RATE_LIMITED. A disabled
 * admin with the right password: ACCOUNT_DISABLED.
 */
export const adminLoginBodySchema = z.strictObject({
  email: z.email().max(254),
  password: signInPasswordSchema,
});
export type AdminLoginBody = z.input<typeof adminLoginBodySchema>;

/**
 * What an admin sign-in asks for next (ADR 0010). Every step answers with a fresh one-time
 * `challengeId` for the next step (the previous one is used up), valid for
 * ADMIN_MFA_CHALLENGE_TTL_SECONDS; a challenge sent to another step's route is
 * LOGIN_STATE_INVALID. The order is fixed, and `totp` is always last:
 *
 *   POST /auth/admin/login ─┬─ must_change_password ──> change_password ── POST /auth/admin/password
 *                           │                                                   │
 *                           ├─ no TOTP secret ───────> enrol_totp <─────────────┤ (no secret)
 *                           │                              │                    │
 *                           └─ TOTP set ─────────────> totp <───────────────────┘ (secret set)
 *                                                        │   (enrol_totp: the same code step)
 *                                                  POST /auth/admin/mfa ──> tokens
 *
 * - `change_password`: the password is temporary (an admin created the account in the admin app
 *   or reset its password; `admin_credentials.must_change_password`). Accounts made by the
 *   operator CLI start with `false`.
 * - `enrol_totp`: the account has no TOTP secret yet (created in the admin app). The API generates
 *   a secret for this sign-in and returns its `otpauthUri` once, to this admin only (never to the
 *   creating admin); the admin app shows it as a QR code. The first valid code at
 *   POST /auth/admin/mfa confirms it.
 * - `totp`: an enrolled (CLI enrolment may still be unconfirmed) secret: enter the code.
 *
 * Nothing is written to admin_credentials before the final step succeeds: the API keeps the new
 * password hash and the new TOTP secret (encrypted with ADMIN_TOTP_ENCRYPTION_KEY) in the
 * challenge, and the successful POST /auth/admin/mfa stores them, clears
 * `must_change_password` and sets `totp_confirmed_at`, in one transaction. An abandoned sign-in
 * leaves the account as it was (the temporary password still works; a new enrolment secret is
 * generated next time).
 */
export const ADMIN_SIGN_IN_STEPS = ['change_password', 'enrol_totp', 'totp'] as const;
export type AdminSignInStep = (typeof ADMIN_SIGN_IN_STEPS)[number];

const adminChallenge = {
  /** One-time, valid for ADMIN_MFA_CHALLENGE_TTL_SECONDS. */
  challengeId: opaqueTokenSchema,
  expiresIn: z.number().int().positive(),
};

export const adminChangePasswordStepSchema = z.object({
  step: z.literal('change_password'),
  ...adminChallenge,
});

export const adminEnrolTotpStepSchema = z.object({
  step: z.literal('enrol_totp'),
  ...adminChallenge,
  /**
   * `otpauth://totp/<issuer>:<email>?secret=<base32>&issuer=...&algorithm=SHA1&digits=<6|8>&period=<s>`
   * (ADMIN_TOTP_DIGITS, ADMIN_TOTP_PERIOD_SECONDS). Secret: shown once, never logged or cached.
   */
  otpauthUri: z.string().startsWith('otpauth://totp/').max(2048),
});

export const adminTotpStepSchema = z.object({ step: z.literal('totp'), ...adminChallenge });

/**
 * POST /auth/admin/login answers with the first step. Changed in ADR 0010: it now always has
 * `step` (before, it was `{ challengeId, expiresIn }`, which is the `totp` step).
 */
export const adminLoginResponseSchema = z.discriminatedUnion('step', [
  adminChangePasswordStepSchema,
  adminEnrolTotpStepSchema,
  adminTotpStepSchema,
]);
export type AdminLoginResponse = z.output<typeof adminLoginResponseSchema>;

/**
 * Admin step `change_password`: the new password (ADMIN_PASSWORD_MIN_LENGTH, policy:
 * PASSWORD_TOO_WEAK, including `same_as_current` for the temporary password). The challenge must
 * come from a `change_password` step, else LOGIN_STATE_INVALID.
 */
export const adminChangePasswordBodySchema = z.strictObject({
  challengeId: opaqueTokenSchema,
  newPassword: newPasswordSchema,
});
export type AdminChangePasswordBody = z.input<typeof adminChangePasswordBodySchema>;

/** After the password step: enrol TOTP (no secret yet) or enter the code (secret set). */
export const adminChangePasswordResponseSchema = z.discriminatedUnion('step', [
  adminEnrolTotpStepSchema,
  adminTotpStepSchema,
]);
export type AdminChangePasswordResponse = z.output<typeof adminChangePasswordResponseSchema>;

/**
 * Admin final step: the TOTP code, for a `totp` or an `enrol_totp` challenge. The first valid code
 * of an account whose TOTP is not yet confirmed (enrolled by the operator CLI, or the secret of
 * this sign-in's `enrol_totp` step) confirms it. Wrong, stale or replayed code: MFA_INVALID (the
 * challenge stays usable until it expires or the rate limit trips).
 */
export const adminMfaBodySchema = z.strictObject({
  challengeId: opaqueTokenSchema,
  code: z.string().regex(/^(\d{6}|\d{8})$/, { error: 'must be 6 or 8 digits' }),
});
export type AdminMfaBody = z.input<typeof adminMfaBodySchema>;

// --- Photographer sign-in (email + password, ADR 0010) -------------------------------------------

/**
 * Photographers sign in at the studio with the email and password an admin gave them. Wrong email
 * or password, no such photographer, or an account without password credentials:
 * INVALID_CREDENTIALS (one code, same timing; an unknown email verifies a dummy hash). Too many
 * failures per account or IP, or a locked account (PHOTOGRAPHER_LOGIN_LOCKOUT_*): RATE_LIMITED
 * with `Retry-After`. A disabled account with the right password: ACCOUNT_DISABLED. Viewers keep
 * LINE/Google; this route never creates a `users` row.
 */
export const photographerSignInBodySchema = z.strictObject({
  email: z.email().max(254),
  password: signInPasswordSchema,
});
export type PhotographerSignInBody = z.input<typeof photographerSignInBodySchema>;

/**
 * - `signed_in`: a normal session (access token `amr` ["pwd"], `idp` `password`).
 * - `change_password`: the password is temporary (`must_change_password`). The tokens are a
 *   restricted session: the access token carries PASSWORD_CHANGE_CLAIM, the refresh family ends
 *   after PHOTOGRAPHER_PASSWORD_CHANGE_SESSION_TTL_SECONDS (`refreshExpiresIn`), and only
 *   PASSWORD_CHANGE_ALLOWED_ROUTES work; everything else is PASSWORD_CHANGE_REQUIRED. The web app
 *   shows the change form and calls POST /auth/photographer/password with the password just typed
 *   as `currentPassword`.
 * The BFF stores the tokens in its session cookie in both cases.
 */
export const photographerSignInResponseSchema = z.discriminatedUnion('step', [
  authTokenResponseSchema.extend({ step: z.literal('signed_in') }),
  authTokenResponseSchema.extend({ step: z.literal('change_password') }),
]);
export type PhotographerSignInResponse = z.output<typeof photographerSignInResponseSchema>;

/**
 * Change the signed-in photographer's own password: the forced first change (restricted session)
 * and any later change. Wrong `currentPassword`: PASSWORD_INCORRECT (counts towards the lockout;
 * when locked: RATE_LIMITED). Policy (PHOTOGRAPHER_PASSWORD_MIN_LENGTH, `same_as_current`, ...):
 * PASSWORD_TOO_WEAK. On success the API stores the new hash, clears `must_change_password`, sets
 * `password_changed_at`, revokes every session of the account (the current one too) and answers
 * with a new normal session, which the BFF stores in place of the old one.
 */
export const photographerChangePasswordBodySchema = z.strictObject({
  currentPassword: signInPasswordSchema,
  newPassword: newPasswordSchema,
});
export type PhotographerChangePasswordBody = z.input<typeof photographerChangePasswordBodySchema>;

/** The new session after a password change. */
export const photographerChangePasswordResponseSchema = authTokenResponseSchema;
export type PhotographerChangePasswordResponse = z.output<
  typeof photographerChangePasswordResponseSchema
>;
