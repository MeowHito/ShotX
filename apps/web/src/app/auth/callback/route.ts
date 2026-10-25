import { handleCallback } from '@/lib/auth/handlers';
import { authDeps } from '@/lib/server/auth';

/** OAuth redirect URI (infra `auth.callbackPath`). */
export function GET(request: Request) {
  return handleCallback(request, authDeps());
}
