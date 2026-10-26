import { type NextRequest, NextResponse } from 'next/server';
import { cookieNames } from './lib/auth/session';
import { SERVER_CALL_HEADERS } from './lib/bff/client-ip';
import { buildCsp, securityHeaders } from './lib/security/headers';
import {
  processFormActionOrigins,
  processMediaOrigins,
  uploadOrigins,
} from './lib/server/config';

/**
 * Runs before every page and route handler (not static assets or /healthz):
 * - a fresh CSP nonce per request (Next applies it to its scripts) plus the other security headers;
 * - a cheap gate for /studio: no session or refresh cookie means a redirect to /login. The real
 *   check is the API's token verification on every call;
 * - removes any BFF key or client IP header a client sent (SERVER_CALL_HEADERS): only web sets
 *   them, on its own calls to the API. Web never copies them from a request anyway; this keeps
 *   any later code from doing so by accident.
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const env = process.env;
  const publicBaseUrl = env.PUBLIC_BASE_URL || undefined;
  const https = (publicBaseUrl ?? request.nextUrl.origin).startsWith('https://');
  const csp = buildCsp({
    nonce,
    isDev: env.NODE_ENV === 'development',
    https,
    publicBaseUrl,
    uploadOrigins: uploadOrigins(env),
    mediaOrigins: processMediaOrigins(),
    formActionOrigins: processFormActionOrigins(),
    // Only the share page runs the face detector.
    allowWasm: request.nextUrl.pathname.startsWith('/s/'),
  });
  const headers = securityHeaders(csp, https);

  if (request.nextUrl.pathname.startsWith('/studio')) {
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
