import { ErrorCode, signupFreeBodySchema, signupFreeConfirmBodySchema } from '@shotx/shared';
import { parseCookies } from './cookies';
import { type AuthDeps, isSameOrigin, sessionCookies } from './handlers';
import { errorResponse, providerErrorResponse, readBody } from './password';
import { cookieNames, sessionFromTokens } from './session';

/**
 * Free sign-up (ADR 0026 section 3), served by web's own route handlers like the password reset
 * (src/lib/auth/password), so the API is called with web's key and the session it answers goes
 * straight into the httpOnly cookies:
 * - POST /auth/signup/free `{ name, email, captchaToken? }`: PACKAGE_ROUTES.signupFree. Answers
 *   204 whatever the email (the API never says whether it has an account). `captchaToken` is the
 *   Turnstile token the dialog sends after the API asked for a challenge; passed on as is.
 * - POST /auth/signup/confirm `{ token, password }`: PACKAGE_ROUTES.signupFreeConfirm; stores the
 *   new session exactly as the password-reset confirm does. Answers 204.
 * Errors are the API's `{ code, message, details }`. Both are same-origin JSON POSTs (CSRF), and
 * the bodies (email, token, password) are never logged.
 */

/** POST /auth/signup/free. */
export async function handleFreeSignupRequest(request: Request, deps: AuthDeps): Promise<Response> {
  const send = deps.provider.requestFreeSignup;
  if (send === undefined) return errorResponse(404, ErrorCode.NOT_FOUND);
  if (!isSameOrigin(request, deps.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const parsed = signupFreeBodySchema.safeParse(await readBody(request));
  if (!parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);
  try {
    await send(parsed.data);
  } catch (error) {
    return providerErrorResponse(error);
  }
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

/** POST /auth/signup/confirm: creates the account; any previous session in this browser ends. */
export async function handleFreeSignupConfirm(request: Request, deps: AuthDeps): Promise<Response> {
  const confirm = deps.provider.confirmFreeSignup;
  if (confirm === undefined) return errorResponse(404, ErrorCode.NOT_FOUND);
  if (!isSameOrigin(request, deps.publicBaseUrl)) {
    return errorResponse(403, ErrorCode.FORBIDDEN);
  }
  const parsed = signupFreeConfirmBodySchema.safeParse(await readBody(request));
  if (!parsed.success) return errorResponse(400, ErrorCode.VALIDATION_FAILED);
  let tokens: Awaited<ReturnType<typeof confirm>>;
  try {
    tokens = await confirm(parsed.data);
  } catch (error) {
    return providerErrorResponse(error);
  }
  const previous = parseCookies(request.headers.get('cookie')).get(
    cookieNames(deps.secureCookies).refresh,
  );
  if (previous) await deps.provider.revoke(previous);
  const session = sessionFromTokens(tokens, deps.now?.() ?? Date.now());
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const cookie of sessionCookies(session, tokens, deps)) headers.append('set-cookie', cookie);
  return new Response(null, { status: 204, headers });
}
