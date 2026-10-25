import { VIEWER_SESSION_COOKIE } from '@shotx/shared';
import { expireCookie, parseCookies, serializeCookie } from './cookies';
import { createPkcePair, randomToken } from './pkce';
import { type AuthProvider, IDENTITY_PROVIDERS, type IdentityProviderName } from './provider';
import {
  cookieNames,
  decodePendingLogin,
  decodeSession,
  encodeJsonCookie,
  safeNextPath,
  type Session,
  sessionFromTokens,
} from './session';

/** Route paths of the auth flow. `/auth/callback` must match infra `auth.callbackPath`. */
export const AUTH_PATHS = {
  login: '/auth/login',
  callback: '/auth/callback',
  logout: '/auth/logout',
  loginPage: '/login',
  /** infra `auth.logoutPath`. */
  afterLogout: '/',
} as const;

const PENDING_LOGIN_SECONDS = 10 * 60;
/** Refresh the access token when it has less than this left. */
const REFRESH_MARGIN_MS = 60_000;

export interface AuthDeps {
  provider: AuthProvider;
  /** Origin of the site, e.g. `https://photos.example.com` (PUBLIC_BASE_URL). */
  publicBaseUrl: string;
  secureCookies: boolean;
  /** Refresh token lifetime (infra `auth.refreshTokenDays`, default 30). */
  refreshTokenMaxAgeSeconds?: number;
  now?: () => number;
}

const DEFAULT_REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

function redirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status, headers });
}

function callbackUrl(deps: AuthDeps): string {
  return `${deps.publicBaseUrl}${AUTH_PATHS.callback}`;
}

function loginErrorUrl(deps: AuthDeps, reason: 'cancelled' | 'failed' | 'expired'): string {
  return `${deps.publicBaseUrl}${AUTH_PATHS.loginPage}?error=${reason}`;
}

/** Cookies that store a session (and its refresh token when there is one). */
export function sessionCookies(
  session: Session,
  refreshToken: string | undefined,
  deps: AuthDeps,
): string[] {
  const names = cookieNames(deps.secureCookies);
  const refreshMaxAge = deps.refreshTokenMaxAgeSeconds ?? DEFAULT_REFRESH_MAX_AGE;
  const cookies = [
    // The session cookie outlives the access token so a refresh can keep the user claims.
    serializeCookie(names.session, encodeJsonCookie(session), {
      secure: deps.secureCookies,
      maxAgeSeconds: refreshMaxAge,
    }),
  ];
  if (refreshToken !== undefined) {
    cookies.push(
      serializeCookie(names.refresh, refreshToken, {
        secure: deps.secureCookies,
        maxAgeSeconds: refreshMaxAge,
      }),
    );
  }
  return cookies;
}

export function clearSessionCookies(deps: Pick<AuthDeps, 'secureCookies'>): string[] {
  const names = cookieNames(deps.secureCookies);
  return [
    expireCookie(names.session, deps.secureCookies),
    expireCookie(names.refresh, deps.secureCookies),
  ];
}

const PROVIDER_PARAMS: Record<string, IdentityProviderName | undefined> = {
  google: IDENTITY_PROVIDERS.google,
  line: IDENTITY_PROVIDERS.line,
  email: undefined,
};

/**
 * GET /auth/login?provider=google|line|email&next=/studio/...
 * Starts the authorization code flow with PKCE and sends the browser to the Hosted UI.
 */
export async function handleLogin(request: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(request.url);
  const providerParam = url.searchParams.get('provider') ?? 'email';
  if (!(providerParam in PROVIDER_PARAMS)) {
    return redirect(loginErrorUrl(deps, 'failed'));
  }
  const pkce = await createPkcePair();
  const state = randomToken(24);
  const next = safeNextPath(url.searchParams.get('next'));
  const names = cookieNames(deps.secureCookies);
  const pending = serializeCookie(
    names.pkce,
    encodeJsonCookie({ verifier: pkce.verifier, state, next }),
    { secure: deps.secureCookies, maxAgeSeconds: PENDING_LOGIN_SECONDS },
  );
  const location = deps.provider.authorizationUrl({
    state,
    codeChallenge: pkce.challenge,
    redirectUri: callbackUrl(deps),
    identityProvider: PROVIDER_PARAMS[providerParam],
  });
  return redirect(location, [pending]);
}

/** GET /auth/callback?code&state (or ?error). Exchanges the code and sets the session. */
export async function handleCallback(request: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(request.url);
  const names = cookieNames(deps.secureCookies);
  const cookies = parseCookies(request.headers.get('cookie'));
  const pending = decodePendingLogin(cookies.get(names.pkce));
  const clearPending = expireCookie(names.pkce, deps.secureCookies);

  if (url.searchParams.has('error')) {
    const reason = url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed';
    return redirect(loginErrorUrl(deps, reason), [clearPending]);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (pending === null) {
    return redirect(loginErrorUrl(deps, 'expired'), [clearPending]);
  }
  if (code === null || state === null || state !== pending.state) {
    return redirect(loginErrorUrl(deps, 'failed'), [clearPending]);
  }
  try {
    const tokens = await deps.provider.exchangeCode({
      code,
      codeVerifier: pending.verifier,
      redirectUri: callbackUrl(deps),
    });
    const session = sessionFromTokens(tokens, deps.now?.() ?? Date.now());
    return redirect(`${deps.publicBaseUrl}${safeNextPath(pending.next)}`, [
      clearPending,
      ...sessionCookies(session, tokens.refreshToken, deps),
    ]);
  } catch {
    return redirect(loginErrorUrl(deps, 'failed'), [clearPending]);
  }
}

/** True for a same-origin request (CSRF guard for state-changing requests). */
export function isSameOrigin(request: Request, publicBaseUrl: string): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === new URL(publicBaseUrl).origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * Expires the API's viewer-session cookie (`shotx_vs`, Path=/api). The browser never sends it to
 * /auth/logout, so the logout button first calls `DELETE /api/me/viewer-session` (which also ends
 * the session in Redis); this is the fallback that at least removes the cookie.
 */
export function expireViewerSessionCookie(deps: Pick<AuthDeps, 'secureCookies'>): string {
  return serializeCookie(VIEWER_SESSION_COOKIE, '', {
    maxAgeSeconds: 0,
    secure: deps.secureCookies,
    path: '/api',
  });
}

/** POST /auth/logout: revoke the refresh token, clear cookies, end the Hosted UI session. */
export async function handleLogout(request: Request, deps: AuthDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.publicBaseUrl)) {
    return new Response(null, { status: 403 });
  }
  const names = cookieNames(deps.secureCookies);
  const refreshToken = parseCookies(request.headers.get('cookie')).get(names.refresh);
  if (refreshToken) await deps.provider.revoke(refreshToken);
  return redirect(deps.provider.logoutUrl(`${deps.publicBaseUrl}${AUTH_PATHS.afterLogout}`), [
    ...clearSessionCookies(deps),
    expireViewerSessionCookie(deps),
  ]);
}

export interface ResolvedSession {
  session: Session | null;
  /** Set-Cookie values to send with the response (a refreshed or cleared session). */
  setCookies: string[];
}

/**
 * The session from a Cookie header, refreshed with the refresh token when the access token is
 * (nearly) expired. A failed refresh clears the cookies.
 */
export async function resolveSession(
  cookieHeader: string | null,
  deps: AuthDeps,
): Promise<ResolvedSession> {
  const names = cookieNames(deps.secureCookies);
  const cookies = parseCookies(cookieHeader);
  const session = decodeSession(cookies.get(names.session));
  const refreshToken = cookies.get(names.refresh);
  const now = deps.now?.() ?? Date.now();

  if (session !== null && session.expiresAt - REFRESH_MARGIN_MS > now) {
    return { session, setCookies: [] };
  }
  if (!refreshToken) {
    return { session: null, setCookies: session === null ? [] : clearSessionCookies(deps) };
  }
  try {
    const tokens = await deps.provider.refresh(refreshToken);
    const refreshed = sessionFromTokens(tokens, now, session ?? undefined);
    return { session: refreshed, setCookies: sessionCookies(refreshed, tokens.refreshToken, deps) };
  } catch {
    return { session: null, setCookies: clearSessionCookies(deps) };
  }
}
