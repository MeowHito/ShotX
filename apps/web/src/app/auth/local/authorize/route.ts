import { handleLocalAuthorize } from '@/lib/auth/local';
import { webConfig } from '@/lib/server/config';

/** The local stand-in's authorize step (AUTH_PROVIDER=local only; 404 otherwise). */
export function POST(request: Request) {
  const config = webConfig();
  return handleLocalAuthorize(
    request,
    config.auth.provider === 'local'
      ? { secret: config.auth.secret, publicBaseUrl: config.publicBaseUrl }
      : null,
  );
}
