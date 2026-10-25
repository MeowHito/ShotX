import { z } from 'zod';
import { base64UrlEncode } from './pkce';
import type { AuthTokens } from './provider';

/**
 * The login session lives in two httpOnly cookies, never readable by browser JS:
 * - `session`: the access token, its expiry and display claims (≈1.5 KB);
 * - `refresh`: the refresh token (≈1.8 KB), kept separate so each cookie stays under 4 KB.
 * The server (BFF and server components) sends the access token to the API as a bearer token.
 * The API verifies every token; the web app only decodes the ID token it just received from the
 * Cognito token endpoint over TLS, for the user's name and email.
 */

export interface CookieNames {
  session: string;
  refresh: string;
  pkce: string;
}

/** `__Host-` cookies (Secure, Path=/, no Domain) in production; plain names on http localhost. */
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : '';
  return {
    session: `${prefix}shotx_session`,
    refresh: `${prefix}shotx_refresh`,
    pkce: `${prefix}shotx_pkce`,
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

/** The session for fresh tokens. Keeps the previous user claims when a refresh has no ID token. */
export function sessionFromTokens(tokens: AuthTokens, now: number, previous?: Session): Session {
  const id = jwtClaims(tokens.idToken);
  const access = jwtClaims(tokens.accessToken);
  return {
    accessToken: tokens.accessToken,
    expiresAt: now + tokens.expiresIn * 1000,
    user: {
      sub: str(id.sub) ?? str(access.sub) ?? previous?.user.sub ?? 'unknown',
      email: str(id.email) ?? previous?.user.email ?? null,
      name: str(id.name) ?? previous?.user.name ?? null,
    },
  };
}

/** Pending login: PKCE verifier, state and where to go afterwards (10 minutes). */
const pkceSchema = z.object({
  verifier: z.string().min(43),
  state: z.string().min(16),
  next: z.string(),
});
export type PendingLogin = z.output<typeof pkceSchema>;

export function decodePendingLogin(value: string | undefined): PendingLogin | null {
  const parsed = pkceSchema.safeParse(decodeJsonCookie(value));
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
