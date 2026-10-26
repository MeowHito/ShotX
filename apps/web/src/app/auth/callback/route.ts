import { handleCallback } from '@/lib/auth/handlers';
import { authDeps } from '@/lib/server/auth';

/** The redirect URI registered with the identity providers (and infra `auth.callbackPath`). */
export function GET(request: Request) {
  return handleCallback(request, authDeps(request.headers));
}
