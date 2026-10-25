import {
  ALL_ROUTES,
  apiErrorBodySchema,
  ErrorCode,
  ME_ROUTES,
  type RouteContract,
  VIEWER_SESSION_COOKIE,
} from '@shotx/shared';
import { type AuthDeps, isSameOrigin, resolveSession } from '../auth/handlers';
import { BFF_PREFIX } from './constants';

/**
 * Backend-for-frontend: the browser calls `/bff/<route path>` with its httpOnly session cookie;
 * this handler adds `Authorization: Bearer <access token>` and forwards the JSON request to the
 * API at API_INTERNAL_URL. Only routes in the shared route table are forwarded (no open proxy),
 * and file bytes never come through here: uploads go from the browser to S3 with presigned URLs.
 * Public routes (`auth: 'public'`, the share page's) are not forwarded either: the browser calls
 * them at `/api/...` directly so the WAF sees the viewer's IP and the API's cookies reach it.
 */

/** Largest JSON body forwarded (the biggest is a complete with 10,000 parts, ~1 MB). */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

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

const COMPILED = ALL_ROUTES.map(compile);

/** Characters a path segment may contain: every route segment, uuid, `root` and share token. */
const SAFE_SEGMENT = /^[A-Za-z0-9_~-]+$/;

/**
 * Why a path (relative to the BFF prefix, before any decoding) must not be forwarded, or null.
 * Rejects dot segments (`.`, `..`), percent-encoded dots, slashes, backslashes and percent signs
 * (`%2e`, `%2f`, `%5c`, `%25`: a server behind us could decode them into a traversal), empty
 * segments and any other character no route uses. Runs before route matching, on the raw path.
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

/**
 * The path part of a request URL exactly as received, without URL normalization (which would
 * already have resolved `..`). Falls back to the parsed pathname.
 */
function rawPathname(requestUrl: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(requestUrl);
  return match?.[1] || new URL(requestUrl).pathname;
}

/** The contract route for a method and API path (relative to /api), or null. */
export function matchRoute(method: string, path: string): RouteContract | null {
  return COMPILED.find((c) => c.route.method === method && c.pattern.test(path))?.route ?? null;
}

/**
 * The upstream Set-Cookie headers the BFF passes to the browser: only the API's viewer-session
 * cookie, only from POST /me/viewer-session (or its deletion), and only scoped to `/api`.
 */
export function forwardableSetCookies(route: RouteContract, upstream: Headers): string[] {
  if (route !== ME_ROUTES.createViewerSession) return [];
  return upstream.getSetCookie().filter((cookie) => {
    const [pair = '', ...attributes] = cookie.split(';').map((part) => part.trim());
    const name = pair.slice(0, pair.indexOf('='));
    const path = attributes.find((a) => /^path=/i.test(a))?.slice(5);
    const domain = attributes.some((a) => /^domain=/i.test(a));
    return name === VIEWER_SESSION_COOKIE && path === '/api' && !domain;
  });
}

export interface BffDeps {
  auth: AuthDeps;
  /** API origin, e.g. the internal ALB (API_INTERNAL_URL). Routes are under `/api` on it. */
  apiInternalUrl: string;
  fetch?: typeof fetch;
}

function errorResponse(status: number, code: ErrorCode, message: string, cookies: string[] = []) {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(apiErrorBodySchema.parse({ code, message })), {
    status,
    headers,
  });
}

export async function handleBffRequest(request: Request, deps: BffDeps): Promise<Response> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${BFF_PREFIX}/`)) {
    return errorResponse(404, ErrorCode.NOT_FOUND, 'Unknown route');
  }
  // Check the raw path and the parsed one: runtimes differ in how much they normalize.
  const raw = rawPathname(request.url);
  if (
    !raw.startsWith(`${BFF_PREFIX}/`) ||
    unsafePathReason(raw.slice(BFF_PREFIX.length)) !== null ||
    unsafePathReason(url.pathname.slice(BFF_PREFIX.length)) !== null
  ) {
    return errorResponse(404, ErrorCode.NOT_FOUND, 'Unknown route');
  }
  const path = url.pathname.slice(BFF_PREFIX.length);
  const route = matchRoute(request.method, path);
  if (route === null || route.auth === 'public') {
    return errorResponse(404, ErrorCode.NOT_FOUND, 'Unknown route');
  }

  if (request.method !== 'GET' && !isSameOrigin(request, deps.auth.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN, 'Cross-origin request');
  }

  const { session, setCookies } = await resolveSession(request.headers.get('cookie'), deps.auth);
  if (session === null) {
    return errorResponse(401, ErrorCode.UNAUTHENTICATED, 'Not signed in', setCookies);
  }

  let body: string | undefined;
  if (route.body !== undefined) {
    body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
      return errorResponse(413, ErrorCode.PAYLOAD_TOO_LARGE, 'Body too large', setCookies);
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
      },
      body,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return errorResponse(502, ErrorCode.INTERNAL_ERROR, 'API unreachable', setCookies);
  }

  const headers = new Headers({ 'cache-control': 'no-store' });
  const contentType = upstream.headers.get('content-type');
  if (contentType !== null) headers.set('content-type', contentType);
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  for (const cookie of forwardableSetCookies(route, upstream.headers)) {
    headers.append('set-cookie', cookie);
  }
  const responseBody = upstream.status === 204 ? null : await upstream.arrayBuffer();
  return new Response(responseBody, { status: upstream.status, headers });
}
