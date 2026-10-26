import { handleLogout } from '@/lib/auth/handlers';
import { authDeps } from '@/lib/server/auth';

export function POST(request: Request) {
  return handleLogout(request, authDeps(request.headers));
}
