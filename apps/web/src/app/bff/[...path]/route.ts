import { handleBffRequest } from '@/lib/bff/handler';
import { authDeps } from '@/lib/server/auth';
import { webConfig } from '@/lib/server/config';

function forward(request: Request) {
  return handleBffRequest(request, {
    auth: authDeps(),
    apiInternalUrl: webConfig().apiInternalUrl,
  });
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
