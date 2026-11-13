import { isReservedShareSlug, parseShareRef } from '@shotx/shared';
import { type NextRequest, NextResponse } from 'next/server';
import { cookieNames } from './lib/auth/session';
import { SERVER_CALL_HEADERS } from './lib/bff/client-ip';
import { buildCsp, securityHeaders } from './lib/security/headers';
import {
  processCaptchaCsp,
  processFormActionOrigins,
  processMediaBrowserOrigins,
} from './lib/server/config';

/**
 * Runs before every page and route handler (not static assets or /healthz):
 * - a fresh CSP nonce per request (Next applies it to its scripts) plus the other security headers;
 * - a cheap gate for /studio: no session or refresh cookie means a redirect to /login. The real
 *   check is the API's token verification on every call;
 * - removes any BFF key or client IP header a client sent (SERVER_CALL_HEADERS): only web sets
 *   them, on its own calls to the API. Web never copies them from a request anyway; this keeps
 *   any later code from doing so by accident;
 * - redirects old share links, `/s/{ref}[/delete-my-face]`, to `/{ref}[/...]` (ADR 0015), except
 *   for a slug the web app's own pages use (those shares stay at `/s/`).
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const env = process.env;
  const publicBaseUrl = env.PUBLIC_BASE_URL || undefined;
  const https = (publicBaseUrl ?? request.nextUrl.origin).startsWith('https://');
  const storage = processMediaBrowserOrigins();
  const pathname = request.nextUrl.pathname;
  const segments = pathname.split('/');
  // Only share pages run the face detector and may show the Turnstile widget. They live at the
  // site root (ADR 0015); every other first segment is one of the app's own (reserved).
  const first = segments[1] ?? '';
  const sharePage = first === 's' || rootShareRef(first) !== null;
  const csp = buildCsp({
    nonce,
    isDev: env.NODE_ENV === 'development',
    https,
    publicBaseUrl,
    uploadOrigins: storage.upload,
    mediaOrigins: storage.media,
    formActionOrigins: processFormActionOrigins(),
    allowWasm: sharePage,
    ...(sharePage ? { captcha: processCaptchaCsp() } : {}),
  });
  const headers = securityHeaders(csp, https);

  if (first === 's' && rootShareRef(segments[2] ?? '') !== null) {
    const target = request.nextUrl.clone();
    target.pathname = `/${segments.slice(2).join('/')}`;
    const response = NextResponse.redirect(target, 308);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }

  if (pathname.startsWith('/studio')) {
    const names = cookieNames(https);
    const signedIn =
      Boolean(request.cookies.get(names.session)?.value) ||
      Boolean(request.cookies.get(names.refresh)?.value);
    if (!signedIn) {
      const login = new URL('/login', request.nextUrl.origin);
      login.searchParams.set('next', request.nextUrl.pathname);
      const response = NextResponse.redirect(login, 303);
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
    }
  }

  const requestHeaders = new Headers(request.headers);
  for (const name of SERVER_CALL_HEADERS) requestHeaders.delete(name);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

/** The share ref a first path segment names, or null (not a ref, or one of the app's own). */
function rootShareRef(segment: string): string | null {
  if (segment === '') return null;
  const parsed = parseShareRef(segment);
  if (parsed === null) return null;
  const ref = parsed.kind === 'token' ? parsed.token : parsed.slug;
  return isReservedShareSlug(ref) ? null : ref;
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|healthz).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
