import { handleChangePassword } from '@/lib/auth/password';
import { authDeps } from '@/lib/server/auth';

/**
 * The signed-in photographer's password change (ADR 0010): the API's answer is a new session,
 * stored in the session cookies here and never passed to the browser.
 */
export function POST(request: Request) {
  return handleChangePassword(request, authDeps(request.headers));
}
