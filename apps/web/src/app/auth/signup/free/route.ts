import { handleFreeSignupRequest } from '@/lib/auth/signup';
import { authDeps } from '@/lib/server/auth';

/** ADR 0026: Free sign-up, step 1 — asks the API to email a confirmation link. */
export function POST(request: Request) {
  return handleFreeSignupRequest(request, authDeps(request.headers));
}
