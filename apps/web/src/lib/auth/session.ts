import { z } from 'zod';
import { base64UrlEncode } from './pkce';
import type { AuthTokens } from './provider';

/**
 * The login session lives in two httpOnly cookies, never readable by browser JS:
 * - `session`: the access token, its expiry and display claims (≈1.5 KB);
 * - `refresh`: the refresh token (≈1.8 KB), kept separate so each cookie stays under 4 KB.
 * The server (BFF and server components) sends the access token to the API as a bearer token.
 * The API verifies every token. The user's name and email come from the token response
 * (API-issued tokens) or the ID token web just received from Cognito's token endpoint over TLS.
 */

export interface CookieNames {
  session: string;
  refresh: string;
  /** The pending login (state, next path and, with Cognito, the PKCE verifier). */
  login: string;
}

/** `__Host-` cookies (Secure, Path=/, no Domain) in production; plain names on http localhost. */
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : '';
  return {
    session: `${prefix}shotx_session`,
    refresh: `${prefix}shotx_refresh`,
    login: `${prefix}shotx_login`,
  };
}

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  /** Epoch milliseconds when the access token expires. */
  expiresAt: z.number().int(),
  user: z.object({
    sub: z.string().min(1),
    email: z.string().nullable(),
    name: z.string().nullable(),
  }),
});
export type Session = z.output<typeof sessionSchema>;

export function encodeJsonCookie(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJsonCookie(value: string | undefined): unknown {
  if (value === undefined || value === '') return undefined;
  try {
    const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export function decodeSession(value: string | undefined): Session | null {
  const parsed = sessionSchema.safeParse(decodeJsonCookie(value));
  return parsed.success ? parsed.data : null;
}

/** Claims of a JWT without verifying it. Only for tokens received straight from the provider. */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const payload = token?.split('.')[1];
  const claims = decodeJsonCookie(payload);
  return claims !== null && typeof claims === 'object' ? (claims as Record<string, unknown>) : {};
}

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/**
 * The session for fresh tokens. The user comes from the token response when it has one (the API
 * reports the current `users` row on every sign-in and refresh), else from the ID token, else the
 * previous session's (a Cognito refresh has no ID token).
 */
export function sessionFromTokens(tokens: AuthTokens, now: number, previous?: Session): Session {
  const id = jwtClaims(tokens.idToken);
  const access = jwtClaims(tokens.accessToken);
  const user = tokens.user;
  return {
    accessToken: tokens.accessToken,
    expiresAt: now + tokens.expiresIn * 1000,
    user: {
      sub: str(id.sub) ?? str(access.sub) ?? previous?.user.sub ?? 'unknown',
      email:
        user !== undefined ? str(user.email) : (str(id.email) ?? previous?.user.email ?? null),
      name: user !== undefined ? str(user.name) : (str(id.name) ?? previous?.user.name ?? null),
    },
  };
}

/**
 * Pending login (10 minutes): the `state` to compare on the callback, where to go afterwards and,
 * with Cognito, the PKCE verifier (with API-issued tokens the API holds it).
 */
const pendingLoginSchema = z.object({
  state: z.string().min(16),
  next: z.string(),
  verifier: z.string().min(43).optional(),
});
export type PendingLogin = z.output<typeof pendingLoginSchema>;

export function decodePendingLogin(value: string | undefined): PendingLogin | null {
  const parsed = pendingLoginSchema.safeParse(decodeJsonCookie(value));
  return parsed.success ? parsed.data : null;
}

/**
 * A same-origin path to return to after login, or `/studio`. Rejects absolute URLs,
 * protocol-relative `//host` and backslash tricks (no open redirect).
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/studio';
  }
  return value;
}
