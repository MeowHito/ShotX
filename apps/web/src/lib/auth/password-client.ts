import { z } from 'zod';
import { ContractError, errorFromResponse, NetworkError } from '../api/errors';
import { AUTH_PATHS } from './handlers';
import { safeNextPath } from './session';

/**
 * Browser side of the photographer's email + password routes, which web serves itself (route
 * handlers in src/lib/auth/password) so the tokens go straight into the httpOnly session cookies.
 * Failures are thrown like the API client's (ApiError with the API's code and details,
 * NetworkError, ContractError), so the one error map (src/lib/errors/messages) words them.
 */

/** What POST /auth/sign-in answers: the step, and where the browser goes next. */
export const passwordSignInResultSchema = z.object({
  step: z.enum(['signed_in', 'change_password']),
  /** Same-origin path: `next`, or the change-password page for a temporary password. */
  redirectTo: z.string(),
});
export type PasswordSignInResult = z.output<typeof passwordSignInResultSchema>;

/**
 * Where to go after a forced password change: `next`, unless it is the change page itself (a
 * redirect loop), then the studio.
 */
export function afterPasswordChangePath(next: string | null | undefined): string {
  const path = safeNextPath(next);
  return path === AUTH_PATHS.changePasswordPage ||
    path.startsWith(`${AUTH_PATHS.changePasswordPage}?`) ||
    path.startsWith(`${AUTH_PATHS.changePasswordPage}/`)
    ? safeNextPath(null)
    : path;
}

/** The change-password page that returns to `next` afterwards. */
export function changePasswordPageHref(next: string | null | undefined): string {
  const query = new URLSearchParams({ next: afterPasswordChangePath(next) });
  return `${AUTH_PATHS.changePasswordPage}?${query.toString()}`;
}

async function post(
  path: string,
  body: unknown,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(path, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : 'Network request failed');
  }
  if (!response.ok) throw errorFromResponse(response.status, await readJson(response));
  return response;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Signs a photographer in; the response sets the session cookies. */
export async function requestPasswordSignIn(
  input: { email: string; password: string; next: string },
  fetchImpl?: typeof fetch,
): Promise<PasswordSignInResult> {
  const response = await post(AUTH_PATHS.passwordSignIn, input, fetchImpl);
  const parsed = passwordSignInResultSchema.safeParse(await readJson(response));
  if (!parsed.success) throw new ContractError(response.status, 'Unexpected sign-in response');
  // Never follow anything but a same-origin path.
  return { step: parsed.data.step, redirectTo: safeNextPath(parsed.data.redirectTo) };
}

/** Changes the signed-in photographer's password; the response replaces the session cookies. */
export async function requestPasswordChange(
  input: { currentPassword: string; newPassword: string },
  fetchImpl?: typeof fetch,
): Promise<void> {
  await post(AUTH_PATHS.changePassword, input, fetchImpl);
}

/** ADR 0025: asks for a reset link (resolves the same whether or not the email has an account). */
export async function requestPasswordReset(email: string, fetchImpl?: typeof fetch): Promise<void> {
  await post(AUTH_PATHS.passwordResetRequest, { email }, fetchImpl);
}

/** ADR 0025: sets the new password with the emailed token; the response sets the session cookies. */
export async function confirmPasswordReset(
  input: { token: string; newPassword: string },
  fetchImpl?: typeof fetch,
): Promise<void> {
  await post(AUTH_PATHS.passwordResetConfirm, input, fetchImpl);
}
