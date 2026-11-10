import {
  apiErrorBodySchema,
  ErrorCode,
  photographerChangePasswordBodySchema,
  photographerSignInBodySchema,
} from '@shotx/shared';
import { z } from 'zod';
import { parseCookies } from './cookies';
import {
  type AuthDeps,
  clearSessionCookies,
  isSameOrigin,
  resolveSession,
  sessionCookies,
} from './handlers';
import { changePasswordPageHref, type PasswordSignInResult } from './password-client';
import { AuthProviderError } from './provider';
import { cookieNames, safeNextPath, sessionFromTokens } from './session';

/**
 * Photographer email + password (ADR 0010), served by web's own route handlers so the API's
 * tokens go straight from the API into the httpOnly session cookies, exactly like the LINE/Google
 * callback; the browser never sees a token:
 * - POST /auth/sign-in `{ email, password, next? }`: AUTH_ROUTES.photographerSignIn (`bff`, with
 *   web's key). Answers `{ step, redirectTo }`; `change_password` (a temporary password) sends
 *   the browser to the change-password page with a restricted session in the cookies.
 * - POST /auth/password `{ currentPassword, newPassword }`: PHOTOGRAPHER_ACCOUNT_ROUTES
 *   .changePassword (`serverOnly`, so the generic /bff proxy refuses it) with the session's access
 *   token. The API revokes every session of the account and answers with a new one, which
 *   replaces the cookies. Answers 204.
 * Errors are the API's `{ code, message, details }` (same status), so the browser maps them with
 * the one error map. Both are same-origin JSON POSTs (CSRF), and the bodies are never logged.
 */

/** Largest JSON body accepted (two passwords of at most 1024 characters, plus an email). */
const MAX_BODY_BYTES = 16 * 1024;

const signInRequestSchema = z.strictObject({
  email: photographerSignInBodySchema.shape.email,
  password: photographerSignInBodySchema.shape.password,
  /** Where to go after signing in (safeNextPath'ed). */
  next: z.string().max(2048).optional(),
});

const changePasswordRequestSchema = photographerChangePasswordBodySchema;

function json(status: number, body: unknown, cookies: readonly string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(
  status: number,
  code: ErrorCode,
  details?: unknown,
  cookies: readonly string[] = [],
): Response {
  const body = apiErrorBodySchema.parse({
    code,
    message: code,
    ...(details !== undefined ? { details } : {}),
  });
  return json(status, body, cookies);
}

/** The API's answer as the browser gets it; transport failures are a 502. */
function providerErrorResponse(error: unknown, cookies: readonly string[] = []): Response {
  if (
    error instanceof AuthProviderError &&
    error.code !== undefined &&
    error.status !== undefined
  ) {
    return errorResponse(error.status, error.code, error.details, cookies);
  }
  return errorResponse(502, ErrorCode.INTERNAL_ERROR, undefined, cookies);
}

/** The JSON body, or undefined when it is too large or not JSON. */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** POST /auth/sign-in: photographer email + password. */
export async function handlePasswordSignIn(request: Request, deps: AuthDeps): Promise<Response> {
  const signIn = deps.provider.passwordSignIn;
  if (signIn === undefined) return errorResponse(404, ErrorCode.NOT_FOUND);
  if (!isSameOrigin(request, deps.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const parsed = signInRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);
  const { email, password } = parsed.data;
  const next = safeNextPath(parsed.data.next);

  let result: Awaited<ReturnType<typeof signIn>>;
  try {
    result = await signIn({ email, password });
  } catch (error) {
    return providerErrorResponse(error);
  }
  // A previous session in this browser (another account, or LINE/Google) ends here.
  const previous = parseCookies(request.headers.get('cookie')).get(
    cookieNames(deps.secureCookies).refresh,
  );
  if (previous) await deps.provider.revoke(previous);

  const session = sessionFromTokens(result.tokens, deps.now?.() ?? Date.now());
  const body: PasswordSignInResult = {
    step: result.step,
    redirectTo: result.step === 'change_password' ? changePasswordPageHref(next) : next,
  };
  return json(200, body, sessionCookies(session, result.tokens, deps));
}

/** Codes after which the session in the cookies is of no further use. */
const SESSION_ENDED: readonly ErrorCode[] = [ErrorCode.UNAUTHENTICATED, ErrorCode.ACCOUNT_DISABLED];

/** POST /auth/password: the signed-in photographer's password change. */
export async function handleChangePassword(request: Request, deps: AuthDeps): Promise<Response> {
  const change = deps.provider.changePassword;
  if (change === undefined) return errorResponse(404, ErrorCode.NOT_FOUND);
  if (!isSameOrigin(request, deps.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const parsed = changePasswordRequestSchema.safeParse(await readBody(request));
  if (!parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);

  const { session, setCookies, unavailable } = await resolveSession(
    request.headers.get('cookie'),
    deps,
  );
  if (unavailable === true) return errorResponse(502, ErrorCode.INTERNAL_ERROR);
  if (session === null) {
    return errorResponse(401, ErrorCode.UNAUTHENTICATED, undefined, setCookies);
  }

  try {
    const tokens = await change({
      accessToken: session.accessToken,
      currentPassword: parsed.data.currentPassword,
      newPassword: parsed.data.newPassword,
    });
    // The old session (and every other one of the account) is revoked: store the new one.
    const renewed = sessionFromTokens(tokens, deps.now?.() ?? Date.now(), session);
    const headers = new Headers({ 'cache-control': 'no-store' });
    for (const cookie of sessionCookies(renewed, tokens, deps))
      headers.append('set-cookie', cookie);
    return new Response(null, { status: 204, headers });
  } catch (error) {
    // Keep a refresh that happened on the way (its old token is spent), or clear a dead session.
    const ended =
      error instanceof AuthProviderError &&
      error.code !== undefined &&
      SESSION_ENDED.includes(error.code);
    return providerErrorResponse(error, ended ? clearSessionCookies(deps) : setCookies);
  }
}
