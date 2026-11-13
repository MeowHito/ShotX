import { type NextRequest, NextResponse } from 'next/server';
import { cookieNames } from './lib/auth/session';
import { SERVER_CALL_HEADERS } from './lib/bff/client-ip';
import { buildCsp, securityHeaders } from './lib/security/headers';
import { SIGN_IN_PATHS } from './lib/sign-in/protocol';

/**
 * Paths reachable without a session cookie: the sign-in page, its route handlers, robots.txt
 * and the tab icon (app/icon.svg, shown on the sign-in page too).
 */
function isPublicPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATHS.loginPage ||
    pathname.startsWith('/auth/') ||
    pathname === '/robots.txt' ||
    pathname === '/icon.svg'
  );
}

/**
 * Runs before every page and route handler (not static assets or /healthz):
 * - a fresh CSP nonce per request (Next applies it to its scripts) plus the other security
 *   headers, including X-Robots-Tag noindex;
 * - a cheap gate: without a session or refresh cookie every page except /login redirects there.
 *   The real check is the API's token verification (admins pool, password + TOTP) on every call;
 * - removes any BFF key or client IP header a client sent (SERVER_CALL_HEADERS).
 */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const env = process.env;
  const https = (env.ADMIN_BASE_URL || request.nextUrl.origin).startsWith('https://');
  const csp = buildCsp({ nonce, isDev: env.NODE_ENV === 'development', https });
  const headers = securityHeaders(csp, https);
  const { pathname } = request.nextUrl;

  if (!isPublicPath(pathname) && !pathname.startsWith('/bff/')) {
    const names = cookieNames(https);
    const signedIn =
      Boolean(request.cookies.get(names.session)?.value) ||
      Boolean(request.cookies.get(names.refresh)?.value);
    if (!signedIn) {
      const login = new URL(SIGN_IN_PATHS.loginPage, request.nextUrl.origin);
      if (pathname !== '/') login.searchParams.set('next', pathname);
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
