import { handleMfaStep } from '@/lib/auth/handlers';
import { authDeps } from '@/lib/server/auth';

export function POST(request: Request) {
  return handleMfaStep(request, authDeps(request.headers));
}

export const dynamic = 'force-dynamic';
