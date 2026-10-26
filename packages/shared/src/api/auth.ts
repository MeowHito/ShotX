import { z } from 'zod';
import { opaqueTokenSchema } from '../account/tokens';
import { AUTH_POOLS, OIDC_PROVIDERS } from '../domain';

// Sign-in routes of the API's own token issuer (AUTH_PROVIDER=shotx or local; ADR 0008 section 4).
// With AUTH_PROVIDER=cognito every route here answers NOT_FOUND. All of them are RouteAuth `bff`:
// web and admin call them server-side and keep tokens in their httpOnly session cookies; the
// browser never sees a refresh token.

/**
 * Header with the shared BFF key (AUTH_BFF_KEY, loadBffAuthConfig). Web and admin send it on
 * every server-side call to the API: the `/bff/*` proxy, server-side rendering and the `bff`
 * routes. On `bff` routes a missing or wrong key is UNAUTHENTICATED; on other routes a wrong key
 * is ignored (the request is treated as coming from the browser) and only means the client IP
 * header below is not trusted.
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

/** What the sign-in page may offer (nothing secret). */
export const authProvidersResponseSchema = z.object({
  /** OIDC providers with credentials configured. */
  oidc: z.array(z.enum(OIDC_PROVIDERS)),
  /** POST /auth/dev/login is available (AUTH_PROVIDER=local). */
  devLogin: z.boolean(),
  /** Admin sign-in (password + TOTP) is available. */
  adminLogin: z.boolean(),
});
export type AuthProvidersResponse = z.output<typeof authProvidersResponseSchema>;

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

/**
 * Admin step 1. Wrong email or password, or no such admin: INVALID_CREDENTIALS (one code, same
 * timing). Too many failures per account or IP, or a locked account: RATE_LIMITED.
 */
export const adminLoginBodySchema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(1024),
});
export type AdminLoginBody = z.input<typeof adminLoginBodySchema>;

export const adminLoginResponseSchema = z.object({
  /** One-time, valid for ADMIN_MFA_CHALLENGE_TTL_SECONDS. */
  challengeId: opaqueTokenSchema,
  expiresIn: z.number().int().positive(),
});
export type AdminLoginResponse = z.output<typeof adminLoginResponseSchema>;

/**
 * Admin step 2: the TOTP code. The first valid code of an account whose TOTP is not yet confirmed
 * (enrolled by the operator CLI) confirms it. Wrong, stale or replayed code: MFA_INVALID (the
 * challenge stays usable until it expires or the rate limit trips).
 */
export const adminMfaBodySchema = z.strictObject({
  challengeId: opaqueTokenSchema,
  code: z.string().regex(/^(\d{6}|\d{8})$/, { error: 'must be 6 or 8 digits' }),
});
export type AdminMfaBody = z.input<typeof adminMfaBodySchema>;
