import { handlePasswordResetConfirm } from '@/lib/auth/password';
import { authDeps } from '@/lib/server/auth';

/** ADR 0025: sets the new password from the emailed link; sets the session cookies. */
export function POST(request: Request) {
  return handlePasswordResetConfirm(request, authDeps(request.headers));
}
