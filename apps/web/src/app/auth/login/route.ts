import { handleLogin } from '@/lib/auth/handlers';
import { authDeps } from '@/lib/server/auth';

export function GET(request: Request) {
  return handleLogin(request, authDeps());
}
