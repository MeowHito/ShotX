import { handleBffRequest } from '@/lib/bff/handler';
import { authDeps, serverCallContext } from '@/lib/server/auth';
import { webConfig } from '@/lib/server/config';

function forward(request: Request) {
  return handleBffRequest(request, {
    auth: authDeps(request.headers),
    apiInternalUrl: webConfig().apiInternalUrl,
    context: serverCallContext(request.headers),
  });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
