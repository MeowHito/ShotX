import {
  adminLoginBodySchema,
  type AdminLoginResponse,
  apiErrorBodySchema,
  type AuthTokenResponse,
  ERROR_HTTP_STATUS,
  ErrorCode,
} from '@shotx/shared';
import type { z } from 'zod';
import { ApiError } from '../api/errors';
import {
  mfaStepBodySchema,
  passwordStepBodySchema,
  SIGN_IN_PATHS,
  type SignInStepView,
} from '../sign-in/protocol';
import type { AdminAuthApi } from './admin-auth-api';
import { expireCookie, parseCookies, serializeCookie } from './cookies';
import {
  cookieNames,
  decodeChallenge,
  decodeSession,
  encodeJsonCookie,
  type Session,
  sessionFromTokens,
} from './session';

/**
 * Route handlers of the admin sign-in (ADR 0010, ADR 0011 decision 4): email + password, then the
 * steps the API asks for. With ADMIN_MFA_MODE=off (default) that is at most a password change;
 * with `totp` also TOTP enrolment and the code. The API alone decides which steps there are and
 * when the sign-in is complete (`signed_in`); nothing here can skip or fake a step it asks for.
 *
 * Nothing secret is logged: request bodies (passwords, codes), challenge ids and tokens are never
 * passed to a logger or put in a URL.
 */

export interface AuthDeps {
  api: AdminAuthApi;
  /** ADMIN_BASE_URL: the only Origin accepted on POSTs, and the base of redirects. */
  adminBaseUrl: string;
  secureCookies: boolean;
  now?: () => number;
}

/** Refresh the access token when it has less than this left. */
const REFRESH_MARGIN_MS = 60_000;

/** Largest sign-in request body read (a 1024-character password fits easily). */
const MAX_SIGN_IN_BODY_BYTES = 8 * 1024;

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function json(status: number, body: unknown, cookies: string[] = []): Response {
  const headers = new Headers(JSON_HEADERS);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** An error answer in the API's `{ code, message, details }` shape. */
export function errorJson(
  code: ErrorCode,
  options: { status?: number; details?: unknown; cookies?: string[] } = {},
): Response {
  const body = apiErrorBodySchema.parse({
    code,
    message: code,
    ...(options.details !== undefined ? { details: options.details } : {}),
  });
  return json(options.status ?? ERROR_HTTP_STATUS[code], body, options.cookies);
}

/** True for a same-origin request (CSRF guard for state-changing requests). */
export function isSameOrigin(request: Request, adminBaseUrl: string): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) return origin === new URL(adminBaseUrl).origin;
  return request.headers.get('sec-fetch-site') === 'same-origin';
}

/** Cookies that store a session and its refresh token, for the sign-in's remaining lifetime. */
export function sessionCookies(session: Session, tokens: AuthTokenResponse, deps: AuthDeps) {
  const names = cookieNames(deps.secureCookies);
  const options = { secure: deps.secureCookies, maxAgeSeconds: tokens.refreshExpiresIn };
  return [
    serializeCookie(names.session, encodeJsonCookie(session), options),
    serializeCookie(names.refresh, tokens.refreshToken, options),
  ];
}

export function clearSessionCookies(deps: Pick<AuthDeps, 'secureCookies'>): string[] {
  const names = cookieNames(deps.secureCookies);
  return [
    expireCookie(names.session, deps.secureCookies),
    expireCookie(names.refresh, deps.secureCookies),
  ];
}

function challengeCookie(challengeId: string, expiresIn: number, deps: AuthDeps): string {
  return serializeCookie(cookieNames(deps.secureCookies).challenge, challengeId, {
    secure: deps.secureCookies,
    maxAgeSeconds: expiresIn,
  });
}

function clearChallengeCookie(deps: AuthDeps): string {
  return expireCookie(cookieNames(deps.secureCookies).challenge, deps.secureCookies);
}

type ChallengeStep = Exclude<AdminLoginResponse, { step: 'signed_in' }>;

/** The browser's view of a challenge step: everything but the challenge id. */
export function stepView(response: ChallengeStep): SignInStepView {
  return response.step === 'enrol_totp'
    ? { step: 'enrol_totp', otpauthUri: response.otpauthUri }
    : { step: response.step };
}

/**
 * The answer for what an API sign-in step returned:
 * - `signed_in` (ADMIN_MFA_MODE=off after the password, or after the code with `totp`): store the
 *   admins-pool tokens in the httpOnly session cookies and drop the challenge cookie. The body
 *   is only `{ step: 'signed_in' }`; no token reaches the browser;
 * - any other step: its one-time challenge in the challenge cookie, the step without it in the
 *   body.
 */
function stepAnswer(
  next: AdminLoginResponse | (AuthTokenResponse & { step: 'signed_in' }),
  deps: AuthDeps,
): Response {
  if (next.step === 'signed_in') {
    const session = sessionFromTokens(next, deps.now?.() ?? Date.now());
    const view: SignInStepView = { step: 'signed_in' };
    return json(200, view, [clearChallengeCookie(deps), ...sessionCookies(session, next, deps)]);
  }
  return json(200, stepView(next), [challengeCookie(next.challengeId, next.expiresIn, deps)]);
}

/** Reads and validates a small JSON body; null when it is too big, not JSON or invalid. */
async function readBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<z.output<S> | null> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_SIGN_IN_BODY_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The answer for a failed API call. An API error passes its code and details on (details are
 * the contract's typed ones, e.g. PASSWORD_TOO_WEAK's reason and minimum length; nothing secret);
 * anything else means the API couldn't be reached or answered off-contract.
 */
function failure(error: unknown, cookies: string[] = []): Response {
  if (error instanceof ApiError) {
    return errorJson(error.code, { status: error.status, details: error.details, cookies });
  }
  return errorJson(ErrorCode.INTERNAL_ERROR, { status: 502, cookies });
}

/** Common checks of every sign-in step: POST from this origin. */
function guard(request: Request, deps: AuthDeps): Response | null {
  if (request.method !== 'POST') return errorJson(ErrorCode.NOT_FOUND, { status: 405 });
  if (!isSameOrigin(request, deps.adminBaseUrl)) return errorJson(ErrorCode.FORBIDDEN);
  return null;
}

/** POST /auth/login `{ email, password }` → signed in, or the first step the API asks for. */
export async function handleLoginStep(request: Request, deps: AuthDeps): Promise<Response> {
  const refused = guard(request, deps);
  if (refused !== null) return refused;
  const body = await readBody(request, adminLoginBodySchema);
  if (body === null) return errorJson(ErrorCode.VALIDATION_FAILED);
  try {
    return stepAnswer(await deps.api.login(body), deps);
  } catch (error) {
    return failure(error, [clearChallengeCookie(deps)]);
  }
}

/** The pending challenge, or an answer that sends the person back to the start. */
function pendingChallenge(request: Request, deps: AuthDeps): string | Response {
  const names = cookieNames(deps.secureCookies);
  const challengeId = decodeChallenge(
    parseCookies(request.headers.get('cookie')).get(names.challenge),
  );
  if (challengeId === null) {
    return errorJson(ErrorCode.LOGIN_STATE_INVALID, { cookies: [clearChallengeCookie(deps)] });
  }
  return challengeId;
}

/** A used-up or expired challenge can't be retried: drop the cookie with the error. */
function stepFailure(error: unknown, deps: AuthDeps): Response {
  const restart =
    error instanceof ApiError &&
    (error.code === ErrorCode.LOGIN_STATE_INVALID || error.code === ErrorCode.ACCOUNT_DISABLED);
  return failure(error, restart ? [clearChallengeCookie(deps)] : []);
}

/**
 * POST /auth/password `{ newPassword }`: the `change_password` step → signed in
 * (ADMIN_MFA_MODE=off), or enrol TOTP / the code (`totp`).
 */
export async function handlePasswordStep(request: Request, deps: AuthDeps): Promise<Response> {
  const refused = guard(request, deps);
  if (refused !== null) return refused;
  const challengeId = pendingChallenge(request, deps);
  if (challengeId instanceof Response) return challengeId;
  const body = await readBody(request, passwordStepBodySchema);
  if (body === null) return errorJson(ErrorCode.VALIDATION_FAILED);
  try {
    return stepAnswer(
      await deps.api.changePassword({ challengeId, newPassword: body.newPassword }),
      deps,
    );
  } catch (error) {
    return stepFailure(error, deps);
  }
}

/** POST /auth/mfa `{ code }`: the `totp` or `enrol_totp` step → the session. */
export async function handleMfaStep(request: Request, deps: AuthDeps): Promise<Response> {
  const refused = guard(request, deps);
  if (refused !== null) return refused;
  const challengeId = pendingChallenge(request, deps);
  if (challengeId instanceof Response) return challengeId;
  const body = await readBody(request, mfaStepBodySchema);
  if (body === null) return errorJson(ErrorCode.VALIDATION_FAILED);
  try {
    const tokens = await deps.api.mfa({ challengeId, code: body.code });
    return stepAnswer({ ...tokens, step: 'signed_in' }, deps);
  } catch (error) {
    return stepFailure(error, deps);
  }
}

/** POST /auth/logout (form): revoke the refresh token, clear every admin cookie, go to /login. */
export async function handleLogout(request: Request, deps: AuthDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.adminBaseUrl)) return new Response(null, { status: 403 });
  const names = cookieNames(deps.secureCookies);
  const refreshToken = parseCookies(request.headers.get('cookie')).get(names.refresh);
  if (refreshToken) {
    try {
      await deps.api.logout(refreshToken);
    } catch {
      // Best effort: the cookies are cleared either way, and the family expires on its own.
    }
  }
  const headers = new Headers({
    location: `${deps.adminBaseUrl}${SIGN_IN_PATHS.loginPage}`,
    'cache-control': 'no-store',
  });
  for (const cookie of [...clearSessionCookies(deps), clearChallengeCookie(deps)]) {
    headers.append('set-cookie', cookie);
  }
  return new Response(null, { status: 303, headers });
}

export interface ResolvedSession {
  session: Session | null;
  /** Set-Cookie values to send with the response (a refreshed or cleared session). */
  setCookies: string[];
  /** The API couldn't refresh right now: cookies are kept, the caller answers "try again". */
  unavailable?: true;
}

/**
 * The session from a Cookie header, refreshed with the refresh token when the access token is
 * (nearly) expired. A refused refresh (invalid, reused, expired, disabled account) clears the
 * cookies.
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
    const tokens = await deps.api.refresh(refreshToken);
    const refreshed = sessionFromTokens(tokens, now);
    return { session: refreshed, setCookies: sessionCookies(refreshed, tokens, deps) };
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      return { session: null, setCookies: clearSessionCookies(deps) };
    }
    return { session: null, setCookies: [], unavailable: true };
  }
}
