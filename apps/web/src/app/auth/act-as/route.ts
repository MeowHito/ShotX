import { handleActAs } from '@/lib/auth/handlers';
import { authDeps } from '@/lib/server/auth';

/** ADR 0018: an admin's one-time link into a photographer's studio. */
export function GET(request: Request) {
  return handleActAs(request, authDeps(request.headers));
}
