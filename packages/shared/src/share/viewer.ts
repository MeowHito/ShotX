import { z } from 'zod';
import { SECONDS_PER_DAY } from '../config/fields';
import { isShareToken, SHARE_TOKEN_LENGTH } from './token';

/**
 * Who is looking at a share. Public share routes (`/api/s/...`, `/api/zip-jobs/...`) are called
 * by the browser directly through CloudFront (so the WAF rules apply), not through the web BFF.
 * The API resolves the viewer from, in order:
 *
 * 1. `Authorization: Bearer <users-pool access token>`: server-side callers (web SSR) and tests;
 * 2. the viewer-session cookie {@link VIEWER_SESSION_COOKIE}, which the API sets when the web BFF
 *    calls `POST /me/viewer-session` for a signed-in user;
 * 3. the anonymous cookie {@link ANON_ID_COOKIE}, which the API sets on any public response that
 *    arrives without one.
 *
 * A bearer token or viewer-session cookie that is present but invalid or expired is
 * UNAUTHENTICATED (the client signs in again or drops the cookie); the anon cookie is never an
 * error: a malformed one is replaced. `viewer_id` (`users.id`) is used when signed in, `anon_id`
 * otherwise; consents, zip jobs, face-search results and activity events are keyed the same way.
 */
export type Viewer = { kind: 'user'; viewerId: string } | { kind: 'anon'; anonId: string };

const uuid = z.uuid();

/**
 * First-party cookie that counts people and keys anonymous sessions: a random UUID v4
 * (`crypto.randomUUID()`), stored in `consents.anon_id`, `zip_jobs.anon_id` and
 * `activity_events.anon_id`. Max-Age ANON_ID_MAX_AGE_DAYS (1 year). Set only by the API.
 */
export const ANON_ID_COOKIE = 'shotx_anon';

/** Opaque token (22 base62) mapping to a `users.id` in Redis; see viewerSessionRedisKey. */
export const VIEWER_SESSION_COOKIE = 'shotx_vs';

/**
 * Share-scoped unlock cookie set by `POST /s/:token/unlock`: an opaque token (22 base62) with
 * `Path=/api/s/{token}`, so each share has its own and no other route receives it. Max-Age
 * SHARE_UNLOCK_TTL_SECONDS. Always the share's token, also when the unlock request used the slug
 * (ADR 0011): web calls public routes with `meta.token` after resolving the page's ref.
 */
export const SHARE_UNLOCK_COOKIE = 'shotx_unlock';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a value the API could have put in the anon cookie (lowercase UUID v4). */
export function isValidAnonId(value: string): boolean {
  return UUID_V4.test(value);
}

/** True for a value the API could have put in the unlock or viewer-session cookie. */
export function isOpaqueCookieToken(value: string): boolean {
  return value.length === SHARE_TOKEN_LENGTH && isShareToken(value);
}

export interface CookieSpec {
  name: string;
  path: string;
  maxAgeSeconds: number;
  httpOnly: true;
  /** False only for http://localhost in development. */
  secure: boolean;
  sameSite: 'Lax';
}

/**
 * Attributes of the anon cookie. Path `/` so the share page's own requests (SSR) carry it too.
 * SameSite=Lax: cross-site POSTs don't carry it, so another site can't act as this session.
 */
export function anonIdCookie(maxAgeDays: number, secure: boolean): CookieSpec {
  return {
    name: ANON_ID_COOKIE,
    path: '/',
    maxAgeSeconds: maxAgeDays * SECONDS_PER_DAY,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
  };
}

/** Attributes of the viewer-session cookie: every public route is under `/api`. */
export function viewerSessionCookie(ttlSeconds: number, secure: boolean): CookieSpec {
  return {
    name: VIEWER_SESSION_COOKIE,
    path: '/api',
    maxAgeSeconds: ttlSeconds,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
  };
}

/** Attributes of a share's unlock cookie: `Path=/api/s/{token}`. */
export function shareUnlockCookie(token: string, ttlSeconds: number, secure: boolean): CookieSpec {
  if (!isShareToken(token)) throw new RangeError('Not a share token');
  return {
    name: SHARE_UNLOCK_COOKIE,
    path: `/api/s/${token}`,
    maxAgeSeconds: ttlSeconds,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
  };
}

/**
 * Stable string for a viewer, used in Redis keys and rate-limit keys: `u:{viewerId}` or
 * `a:{anonId}`.
 */
export function viewerKey(viewer: Viewer): string {
  if (viewer.kind === 'user') return `u:${uuid.parse(viewer.viewerId)}`;
  return `a:${uuid.parse(viewer.anonId)}`;
}

/** The `viewer_id` / `anon_id` column values of a viewer (exactly one is set). */
export function viewerColumns(viewer: Viewer): { viewerId: string | null; anonId: string | null } {
  return viewer.kind === 'user'
    ? { viewerId: viewer.viewerId, anonId: null }
    : { viewerId: null, anonId: viewer.anonId };
}

/**
 * `ip_hash` of a consent row: `v1:` + base64url(HMAC-SHA256(IP_HASH_SECRET, ipHashInput(ip))),
 * computed by the API. The address itself is never stored.
 */
export const IP_HASH_VERSION = 'v1';

/**
 * The normalized client address that is hashed: lowercase, an IPv4-mapped IPv6 address as plain
 * IPv4, no zone index. Use the client address CloudFront reports (`CloudFront-Viewer-Address`
 * without the port), never a header the client controls.
 */
export function ipHashInput(ip: string): string {
  const trimmed = ip.trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(trimmed);
  return mapped?.[1] ?? trimmed;
}
