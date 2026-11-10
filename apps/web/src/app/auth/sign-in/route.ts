import { handlePasswordSignIn } from '@/lib/auth/password';
import { authDeps } from '@/lib/server/auth';

/** Photographer email + password sign-in (ADR 0010); sets the session cookies. */
export function POST(request: Request) {
  return handlePasswordSignIn(request, authDeps(request.headers));
}
