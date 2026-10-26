import { devLoginBodySchema, ErrorCode, OIDC_PROVIDERS, VIEWER_SESSION_COOKIE } from '@shotx/shared';
import { expireCookie, parseCookies, serializeCookie } from './cookies';
import { type AuthProvider, AuthProviderError, type AuthTokens, type LoginStart } from './provider';
import {
  cookieNames,
  decodePendingLogin,
  decodeSession,
  encodeJsonCookie,
  safeNextPath,
  type Session,
  sessionFromTokens,
} from './session';

/** Route paths of the auth flow. `/auth/callback` is the redirect URI registered everywhere. */
export const AUTH_PATHS = {
  login: '/auth/login',
  callback: '/auth/callback',
  logout: '/auth/logout',
  /** The development sign-in form's target (AUTH_PROVIDER=local only). */
  devLogin: '/auth/dev-login',
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
  /**
   * Session cookie lifetime when the provider doesn't say (Cognito: infra
   * `auth.refreshTokenDays`, default 30). API-issued tokens carry `refreshExpiresIn`.
   */
  refreshTokenMaxAgeSeconds?: number;
  now?: () => number;
}

const DEFAULT_REFRESH_MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Why a login failed, as `/login?error=…` shows it. Outcomes decided in web have their own copy
 * (`login.errors`); API error codes are passed as the code and rendered through the one error map
 * (src/lib/errors/messages).
 */
export const LOGIN_ERROR_REASONS = ['cancelled', 'failed', 'expired', 'invalid'] as const;
export type LoginErrorReason = (typeof LOGIN_ERROR_REASONS)[number];

/** API codes worth telling the person about on the login page; anything else is `failed`. */
export const LOGIN_ERROR_CODES = [
  ErrorCode.AUTH_PROVIDER_UNAVAILABLE,
  ErrorCode.LOGIN_STATE_INVALID,
  ErrorCode.IDENTITY_PROVIDER_ERROR,
  ErrorCode.RATE_LIMITED,
] as const;
export type LoginErrorCode = (typeof LOGIN_ERROR_CODES)[number];

export type LoginError = LoginErrorReason | LoginErrorCode;

/** The `error` query value of the login page for a failure. */
export function loginErrorFor(error: unknown): LoginError {
  if (error instanceof AuthProviderError && error.code !== undefined) {
    const code = LOGIN_ERROR_CODES.find((c) => c === error.code);
    if (code !== undefined) return code;
  }
  return 'failed';
}

function redirect(location: string, cookies: string[] = [], status = 303): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(null, { status, headers });
}

function callbackUrl(deps: AuthDeps): string {
  return `${deps.publicBaseUrl}${AUTH_PATHS.callback}`;
}

/** The login page with an error, keeping where the person was going. */
function loginErrorUrl(deps: AuthDeps, error: LoginError, next?: string): string {
  const query = new URLSearchParams({ error });
  if (next !== undefined && next !== safeNextPath(null)) query.set('next', safeNextPath(next));
  return `${deps.publicBaseUrl}${AUTH_PATHS.loginPage}?${query.toString()}`;
}

/** Cookies that store a session (and its refresh token when there is one). */
export function sessionCookies(
  session: Session,
  tokens: Pick<AuthTokens, 'refreshToken' | 'refreshExpiresIn'>,
  deps: AuthDeps,
): string[] {
  const names = cookieNames(deps.secureCookies);
  // The sign-in's end: the refresh family's remaining lifetime when the API says it.
  const maxAge =
    tokens.refreshExpiresIn ?? deps.refreshTokenMaxAgeSeconds ?? DEFAULT_REFRESH_MAX_AGE;
  const cookies = [
    // The session cookie outlives the access token so a refresh can keep the user claims.
    serializeCookie(names.session, encodeJsonCookie(session), {
      secure: deps.secureCookies,
      maxAgeSeconds: maxAge,
    }),
  ];
  if (tokens.refreshToken !== undefined) {
    cookies.push(
      serializeCookie(names.refresh, tokens.refreshToken, {
        secure: deps.secureCookies,
        maxAgeSeconds: maxAge,
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

/**
 * GET /auth/login?provider=line|google&next=/studio/...
 * Starts the sign-in with the provider and sends the browser there. The `state` it returns is
 * bound to this browser in a short-lived httpOnly cookie (plus the PKCE verifier with Cognito).
 */
export async function handleLogin(request: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(request.url);
  const next = safeNextPath(url.searchParams.get('next'));
  const identityProvider = OIDC_PROVIDERS.find((p) => p === url.searchParams.get('provider'));
  if (identityProvider === undefined) {
    return redirect(loginErrorUrl(deps, 'failed', next));
  }
  let start: LoginStart;
  try {
    start = await deps.provider.startLogin({ identityProvider, redirectUri: callbackUrl(deps) });
  } catch (error) {
    return redirect(loginErrorUrl(deps, loginErrorFor(error), next));
  }
  const names = cookieNames(deps.secureCookies);
  const pending = serializeCookie(
    names.login,
    encodeJsonCookie({
      state: start.state,
      next,
      ...(start.codeVerifier !== undefined ? { verifier: start.codeVerifier } : {}),
    }),
    { secure: deps.secureCookies, maxAgeSeconds: PENDING_LOGIN_SECONDS },
  );
  return redirect(start.authorizationUrl, [pending]);
}

/** GET /auth/callback?code&state (or ?error). Finishes the sign-in and sets the session. */
export async function handleCallback(request: Request, deps: AuthDeps): Promise<Response> {
  const url = new URL(request.url);
  const names = cookieNames(deps.secureCookies);
  const cookies = parseCookies(request.headers.get('cookie'));
  const pending = decodePendingLogin(cookies.get(names.login));
  const clearPending = expireCookie(names.login, deps.secureCookies);
  const next = pending?.next;

  if (url.searchParams.has('error')) {
    const reason = url.searchParams.get('error') === 'access_denied' ? 'cancelled' : 'failed';
    return redirect(loginErrorUrl(deps, reason, next), [clearPending]);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (pending === null) {
    return redirect(loginErrorUrl(deps, 'expired'), [clearPending]);
  }
  // Login CSRF: the state must be the one this browser started with.
  if (code === null || state === null || state !== pending.state) {
    return redirect(loginErrorUrl(deps, 'failed', next), [clearPending]);
  }
  try {
    const tokens = await deps.provider.completeLogin({
      code,
      state,
      codeVerifier: pending.verifier,
      redirectUri: callbackUrl(deps),
    });
    const session = sessionFromTokens(tokens, deps.now?.() ?? Date.now());
    return redirect(`${deps.publicBaseUrl}${safeNextPath(pending.next)}`, [
      clearPending,
      ...sessionCookies(session, tokens, deps),
    ]);
  } catch (error) {
    return redirect(loginErrorUrl(deps, loginErrorFor(error), next), [clearPending]);
  }
}

/** True for a same-origin request (CSRF guard for state-changing requests). */
export function isSameOrigin(request: Request, publicBaseUrl: string): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === new URL(publicBaseUrl).origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/**
 * POST /auth/dev-login (form: email, name, next): the development sign-in, AUTH_PROVIDER=local
 * only (404 otherwise; the API refuses it outside APP_STAGE=local as well). A form POST keeps the
 * email out of URLs and logs; same-origin only, so another site can't sign a browser in.
 */
export async function handleDevLogin(request: Request, deps: AuthDeps): Promise<Response> {
  const devLogin = deps.provider.devLogin;
  if (devLogin === undefined) return new Response(null, { status: 404 });
  if (!isSameOrigin(request, deps.publicBaseUrl)) return new Response(null, { status: 403 });
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(loginErrorUrl(deps, 'invalid'));
  }
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === 'string' ? value : '';
  };
  const next = safeNextPath(field('next'));
  const identity = devLoginBodySchema.safeParse({ email: field('email'), name: field('name') });
  if (!identity.success) return redirect(loginErrorUrl(deps, 'invalid', next));
  try {
    const tokens = await devLogin(identity.data);
    const session = sessionFromTokens(tokens, deps.now?.() ?? Date.now());
    return redirect(`${deps.publicBaseUrl}${next}`, sessionCookies(session, tokens, deps));
  } catch (error) {
    return redirect(loginErrorUrl(deps, loginErrorFor(error), next));
  }
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

/** POST /auth/logout: revoke the refresh token, clear cookies, end the provider's session. */
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
  /**
   * The refresh couldn't be done right now (provider unreachable or failing): the cookies are
   * kept so a later request can retry, and the caller answers "try again", not "sign in".
   */
  unavailable?: true;
}

/**
 * The session from a Cookie header, refreshed with the refresh token when the access token is
 * (nearly) expired. A refused refresh (invalid, reused or expired token) clears the cookies.
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
    return { session: refreshed, setCookies: sessionCookies(refreshed, tokens, deps) };
  } catch (error) {
    if (error instanceof AuthProviderError && error.transient) {
      return { session: null, setCookies: [], unavailable: true };
    }
    return { session: null, setCookies: clearSessionCookies(deps) };
  }
}
