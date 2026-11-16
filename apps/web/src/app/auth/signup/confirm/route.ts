import { handleFreeSignupConfirm } from '@/lib/auth/signup';
import { authDeps } from '@/lib/server/auth';

/** ADR 0026: Free sign-up, step 2 — creates the account from the emailed link; sets the session. */
export function POST(request: Request) {
  return handleFreeSignupConfirm(request, authDeps(request.headers));
}
