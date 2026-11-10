import { handleBffRequest } from '@/lib/bff/handler';
import { authDeps, serverCallContext } from '@/lib/server/auth';
import { adminConfig } from '@/lib/server/config';

function forward(request: Request) {
  return handleBffRequest(request, {
    auth: authDeps(request.headers),
    apiInternalUrl: adminConfig().apiInternalUrl,
    context: serverCallContext(request.headers),
  });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;

export const dynamic = 'force-dynamic';
