import {
  ADMIN_ROUTES,
  ErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  idempotencyKeySchema,
  type RouteContract,
} from '@shotx/shared';
import { ApiError, errorFromResponse } from '../api/errors';
import {
  type AuthDeps,
  clearSessionCookies,
  errorJson,
  isSameOrigin,
  resolveSession,
} from '../auth/handlers';
import { type ServerCallContext, serverCallHeaders } from './client-ip';
import { BFF_PREFIX } from './constants';

/**
 * Backend-for-frontend of the admin app: the browser calls `/bff/<route path>` with its httpOnly
 * session cookie; this handler adds `Authorization: Bearer <access token>`, the BFF key and the
 * end user's address, and forwards the JSON request to the API at API_INTERNAL_URL.
 *
 * Only ADMIN_ROUTES are forwarded (RouteAuth `admin`; admins-pool tokens work nowhere else), and
 * never a `serverOnly` route. Sign-in routes (`bff`) are called by src/lib/auth itself. Request
 * and response bodies are passed through untouched and never logged.
 */

/** Largest JSON body forwarded (admin bodies are a few hundred bytes). */
const MAX_BODY_BYTES = 64 * 1024;

interface CompiledRoute {
  route: RouteContract;
  pattern: RegExp;
}

function compile(route: RouteContract): CompiledRoute {
  const source = route.path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return { route, pattern: new RegExp(`^${source}$`) };
}

/** The routes the BFF forwards. */
export const FORWARDED_ROUTES: readonly RouteContract[] = Object.values(
  ADMIN_ROUTES as Record<string, RouteContract>,
).filter((route) => route.auth === 'admin' && route.serverOnly !== true);

const COMPILED = FORWARDED_ROUTES.map(compile);

/** Characters a path segment may contain: every route segment and uuids. */
const SAFE_SEGMENT = /^[A-Za-z0-9_~-]+$/;

/**
 * Why a path (relative to the BFF prefix, before any decoding) must not be forwarded, or null.
 * Rejects dot segments, percent-encoded dots, slashes, backslashes and percent signs, empty
 * segments and any other character no route uses.
 */
export function unsafePathReason(path: string): string | null {
  if (!path.startsWith('/')) return 'relative';
  for (const segment of path.slice(1).split('/')) {
    if (segment === '') return 'empty segment';
    if (segment === '.' || segment === '..') return 'dot segment';
    if (/%(2e|2f|5c|25)/i.test(segment)) return 'encoded dot, slash or percent';
    if (!SAFE_SEGMENT.test(segment)) return 'disallowed character';
  }
  return null;
}

/** The path part of a request URL exactly as received (before URL normalization). */
function rawPathname(requestUrl: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(requestUrl);
  return match?.[1] || new URL(requestUrl).pathname;
}

/** The forwarded route for a method and API path (relative to /api), or null. */
export function matchRoute(method: string, path: string): RouteContract | null {
  return COMPILED.find((c) => c.route.method === method && c.pattern.test(path))?.route ?? null;
}

/**
 * The request headers passed on: only `Idempotency-Key`, only for routes whose contract declares
 * headers (POST /admin/cash-payments), and only when well-formed.
 */
export function forwardableRequestHeaders(
  route: RouteContract,
  headers: Headers,
): Record<string, string> {
  if (route.headers === undefined) return {};
  const key = headers.get(IDEMPOTENCY_KEY_HEADER);
  if (key === null || !idempotencyKeySchema.safeParse(key).success) return {};
  return { [IDEMPOTENCY_KEY_HEADER]: key };
}

/**
 * Upstream codes after which the session is useless: clear the cookies so the next page load goes
 * to the sign-in page (a disabled admin, a revoked session, a token without MFA).
 */
const SESSION_ENDING_CODES: readonly ErrorCode[] = [
  ErrorCode.UNAUTHENTICATED,
  ErrorCode.MFA_REQUIRED,
  ErrorCode.ACCOUNT_DISABLED,
];

export interface BffDeps {
  auth: AuthDeps;
  apiInternalUrl: string;
  context: ServerCallContext;
  fetch?: typeof fetch;
}

export async function handleBffRequest(request: Request, deps: BffDeps): Promise<Response> {
  const url = new URL(request.url);
  const raw = rawPathname(request.url);
  if (
    !url.pathname.startsWith(`${BFF_PREFIX}/`) ||
    !raw.startsWith(`${BFF_PREFIX}/`) ||
    unsafePathReason(raw.slice(BFF_PREFIX.length)) !== null ||
    unsafePathReason(url.pathname.slice(BFF_PREFIX.length)) !== null
  ) {
    return errorJson(ErrorCode.NOT_FOUND);
  }
  const path = url.pathname.slice(BFF_PREFIX.length);
  const route = matchRoute(request.method, path);
  if (route === null) return errorJson(ErrorCode.NOT_FOUND);

  if (request.method !== 'GET' && !isSameOrigin(request, deps.auth.adminBaseUrl)) {
    return errorJson(ErrorCode.FORBIDDEN);
  }

  const { session, setCookies, unavailable } = await resolveSession(
    request.headers.get('cookie'),
    deps.auth,
  );
  if (unavailable === true) {
    return errorJson(ErrorCode.INTERNAL_ERROR, { status: 502 });
  }
  if (session === null) {
    return errorJson(ErrorCode.UNAUTHENTICATED, { cookies: setCookies });
  }

  let body: string | undefined;
  if (route.body !== undefined) {
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return errorJson(ErrorCode.PAYLOAD_TOO_LARGE, { cookies: setCookies });
    }
  }

  const target = `${deps.apiInternalUrl.replace(/\/+$/, '')}/api${path}${url.search}`;
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  let upstream: Response;
  try {
    upstream = await fetchImpl(target, {
      method: request.method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${session.accessToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...forwardableRequestHeaders(route, request.headers),
        ...serverCallHeaders(deps.context),
      },
      body,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return errorJson(ErrorCode.INTERNAL_ERROR, { status: 502, cookies: setCookies });
  }

  const responseBody = upstream.status === 204 ? null : await upstream.arrayBuffer();
  const headers = new Headers({ 'cache-control': 'no-store' });
  const contentType = upstream.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);
  let cookies = setCookies;
  if (!upstream.ok && responseBody !== null) {
    const error = errorFromResponse(upstream.status, parseJson(responseBody));
    if (error instanceof ApiError && SESSION_ENDING_CODES.includes(error.code)) {
      cookies = clearSessionCookies(deps.auth);
    }
  }
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(responseBody, { status: upstream.status, headers });
}

function parseJson(buffer: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
  } catch {
    return undefined;
  }
}
