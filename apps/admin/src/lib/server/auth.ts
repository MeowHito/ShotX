import 'server-only';
import { cookies } from 'next/headers';
import { createAdminAuthApi } from '../auth/admin-auth-api';
import type { AuthDeps } from '../auth/handlers';
import { cookieNames, decodeSession, type SessionUser } from '../auth/session';
import { clientIpFromHeaders, type ServerCallContext } from '../bff/client-ip';
import { type AdminConfig, adminConfig } from './config';

/** The BFF key and the end user's address for API calls made while serving this request. */
export function serverCallContext(
  requestHeaders: Headers,
  config: AdminConfig = adminConfig(),
): ServerCallContext {
  return { bffKey: config.bffKey, clientIp: clientIpFromHeaders(requestHeaders) };
}

/** Auth dependencies of a route handler, from the environment and the request's headers. */
export function authDeps(requestHeaders: Headers): AuthDeps {
  const config = adminConfig();
  return {
    api: createAdminAuthApi({
      apiInternalUrl: config.apiInternalUrl,
      client: config.authClient,
      context: serverCallContext(requestHeaders, config),
    }),
    adminBaseUrl: config.adminBaseUrl,
    secureCookies: config.secureCookies,
  };
}

export interface AdminViewerState {
  /** Display claims of the signed-in admin, or null when the session cookie has expired. */
  user: SessionUser | null;
  /** A session or a refresh token is present (the BFF refreshes on the next API call). */
  signedIn: boolean;
}

/** The signed-in admin for server components (no refresh: server components can't set cookies). */
export async function adminViewerState(): Promise<AdminViewerState> {
  const store = await cookies();
  const names = cookieNames(adminConfig().secureCookies);
  const session = decodeSession(store.get(names.session)?.value);
  const hasRefresh = Boolean(store.get(names.refresh)?.value);
  return { user: session?.user ?? null, signedIn: session !== null || hasRefresh };
}
