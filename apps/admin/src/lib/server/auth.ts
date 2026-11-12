import 'server-only';
import type { AdminMfaMode } from '@shotx/shared';
import { cookies, headers } from 'next/headers';
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

/** How long the admin app reuses GET /auth/providers' answer (ADMIN_MFA_MODE is fixed config). */
const PROVIDERS_CACHE_MS = 60_000;

let cachedMfaMode: { mode: AdminMfaMode | null; at: number } | undefined;

/**
 * ADMIN_MFA_MODE as the API reports it (GET /auth/providers `adminMfaMode`), cached per process
 * for a minute; null when admin sign-in is off or the API couldn't be asked (the UI then shows no
 * TOTP-only flags; the flow itself always follows what the API answers).
 */
export async function adminMfaMode(now: number = Date.now()): Promise<AdminMfaMode | null> {
  if (cachedMfaMode !== undefined && now - cachedMfaMode.at < PROVIDERS_CACHE_MS) {
    return cachedMfaMode.mode;
  }
  try {
    const providers = await authDeps(await headers()).api.providers();
    cachedMfaMode = { mode: providers.adminMfaMode, at: now };
    return providers.adminMfaMode;
  } catch {
    // Not cached: ask again on the next request.
    return null;
  }
}
