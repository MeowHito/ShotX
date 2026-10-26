import { handleDevLogin } from '@/lib/auth/handlers';
import { authDeps } from '@/lib/server/auth';

/** The development sign-in form's target (AUTH_PROVIDER=local only; 404 otherwise). */
export function POST(request: Request) {
  return handleDevLogin(request, authDeps(request.headers));
}
