import {
  type AuthTokenResponse,
  idSchema,
  opaqueTokenSchema,
  parseAuthSubject,
} from '@shotx/shared';
import { z } from 'zod';

/**
 * The admin session lives in httpOnly, SameSite=Strict cookies on the admin origin, never
 * readable by browser JS:
 * - `session`: the access token, its expiry and display claims;
 * - `refresh`: the opaque refresh token (admins pool);
 * - `challenge`: the one-time `challengeId` between sign-in steps (ADMIN_SIGN_IN_STEPS), so the
 *   browser never holds it either.
 * Names differ from the web app's (`shotx_session`, ...): on localhost both apps share cookies
 * across ports.
 */

export interface CookieNames {
  session: string;
  refresh: string;
  challenge: string;
}

/** `__Host-` cookies (Secure, Path=/, no Domain) on https; plain names on http localhost. */
export function cookieNames(secure: boolean): CookieNames {
  const prefix = secure ? '__Host-' : '';
  return {
    session: `${prefix}shotx_admin_session`,
    refresh: `${prefix}shotx_admin_refresh`,
    challenge: `${prefix}shotx_admin_challenge`,
  };
}

const sessionSchema = z.object({
  accessToken: z.string().min(1),
  /** Epoch milliseconds when the access token expires. */
  expiresAt: z.number().int(),
  user: z.object({
    /** `users.id` of the signed-in admin (from the `admin:<id>` subject), or null if unknown. */
    id: z.uuid().nullable(),
    email: z.string().nullable(),
    name: z.string().nullable(),
  }),
});
export type Session = z.output<typeof sessionSchema>;
export type SessionUser = Session['user'];

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

/**
 * Claims of a JWT without verifying it. Only for tokens just received from the API over the
 * internal network, and only for display (which row is "you"); the API verifies every token.
 */
export function jwtClaims(token: string | undefined): Record<string, unknown> {
  const claims = decodeJsonCookie(token?.split('.')[1]);
  return claims !== null && typeof claims === 'object' ? (claims as Record<string, unknown>) : {};
}

/** `users.id` of an admins-pool access token (`sub` = `admin:<id>`), or null. */
export function adminIdOfToken(accessToken: string): string | null {
  const sub = jwtClaims(accessToken).sub;
  if (typeof sub !== 'string') return null;
  const parsed = parseAuthSubject(sub);
  if (parsed === null || parsed.provider !== 'admin') return null;
  return idSchema.safeParse(parsed.id).success ? parsed.id.toLowerCase() : null;
}

/** The session for a token response (sign-in or refresh). */
export function sessionFromTokens(tokens: AuthTokenResponse, now: number): Session {
  return {
    accessToken: tokens.accessToken,
    expiresAt: now + tokens.expiresIn * 1000,
    user: {
      id: adminIdOfToken(tokens.accessToken),
      email: tokens.user.email,
      name: tokens.user.name,
    },
  };
}

/** The pending sign-in step's challenge, as the challenge cookie stores it. */
export function decodeChallenge(value: string | undefined): string | null {
  return value !== undefined && opaqueTokenSchema.safeParse(value).success ? value : null;
}

/**
 * A same-origin path to return to after sign-in, or `/users`. Rejects absolute URLs,
 * protocol-relative `//host` and backslash tricks (no open redirect).
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return '/users';
  }
  return value;
}
