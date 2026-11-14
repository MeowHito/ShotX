import { handlePasswordResetRequest } from '@/lib/auth/password';
import { authDeps } from '@/lib/server/auth';

/** ADR 0025: "forgot password" — asks the API to email a reset link. */
export function POST(request: Request) {
  return handlePasswordResetRequest(request, authDeps(request.headers));
}
