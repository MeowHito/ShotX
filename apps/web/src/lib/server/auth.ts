import 'server-only';
import { apiIssuesTokens, OIDC_PROVIDERS, type OidcProvider } from '@shotx/shared';
import { cookies, headers } from 'next/headers';
import { createCognitoAuthProvider } from '../auth/cognito';
import type { AuthDeps } from '../auth/handlers';
import type { AuthProvider } from '../auth/provider';
import { cookieNames, decodeSession, type Session } from '../auth/session';
import { createShotxAuthProvider, fetchLoginProviders } from '../auth/shotx';
import { clientIpFromHeaders, type ServerCallContext } from '../bff/client-ip';
import { type WebConfig, webConfig } from './config';

/** The BFF key and the end user's address for API calls made while serving this request. */
export function serverCallContext(
  requestHeaders: Headers,
  config: WebConfig = webConfig(),
): ServerCallContext {
  return {
    bffKey: config.bffKey,
    clientIp: clientIpFromHeaders(requestHeaders, config.clientIpSource),
  };
}

/** {@link serverCallContext} of the request a server component is rendering. */
export async function requestServerCallContext(): Promise<ServerCallContext> {
  return serverCallContext(await headers());
}

function shotxContext(config: WebConfig, context: ServerCallContext) {
  // loadBffAuthConfig requires AUTH_BFF_KEY with shotx and local.
  if (config.bffKey === null) throw new Error('AUTH_BFF_KEY is missing');
  return { ...context, bffKey: config.bffKey };
}

function authProvider(config: WebConfig, context: ServerCallContext): AuthProvider {
  if (apiIssuesTokens(config.authProvider)) {
    return createShotxAuthProvider({
      apiInternalUrl: config.apiInternalUrl,
      client: config.authClient,
      context: shotxContext(config, context),
      devLogin: config.authProvider === 'local',
    });
  }
  if (config.cognito === null) throw new Error('Cognito configuration is missing');
  return createCognitoAuthProvider(config.cognito);
}

/** Auth dependencies of a route handler, from the environment and the request's headers. */
export function authDeps(requestHeaders: Headers): AuthDeps {
  const config = webConfig();
  return {
    provider: authProvider(config, serverCallContext(requestHeaders, config)),
    publicBaseUrl: config.publicBaseUrl,
    secureCookies: config.secureCookies,
  };
}

export interface LoginOptions {
  /** Identity providers to offer, in display order. */
  oidc: OidcProvider[];
  /** Show the development sign-in form (AUTH_PROVIDER=local and the API offers it). */
  devLogin: boolean;
}

/**
 * What the sign-in page offers: with API-issued tokens, what GET /auth/providers reports (null
 * when the API failed); with Cognito, LINE and Google (both are configured in infra).
 */
export async function loginOptions(): Promise<LoginOptions | null> {
  const config = webConfig();
  if (!apiIssuesTokens(config.authProvider)) return { oidc: [...OIDC_PROVIDERS], devLogin: false };
  const providers = await fetchLoginProviders({
    apiInternalUrl: config.apiInternalUrl,
    client: config.authClient,
    context: shotxContext(config, serverCallContext(await headers(), config)),
  });
  if (providers === null) return null;
  return {
    oidc: OIDC_PROVIDERS.filter((p) => providers.oidc.includes(p)),
    devLogin: config.authProvider === 'local' && providers.devLogin,
  };
}

export interface ViewerState {
  /** Display claims of the signed-in user, or null when their session cookie has expired. */
  user: Session['user'] | null;
  /** Signed in: a session or a refresh token (the BFF refreshes on the next API call). */
  signedIn: boolean;
}

/** The signed-in user for server components. Server components can't set cookies, so no refresh here. */
export async function viewerState(): Promise<ViewerState> {
  const store = await cookies();
  const names = cookieNames(webConfig().secureCookies);
  const session = decodeSession(store.get(names.session)?.value);
  const hasRefresh = Boolean(store.get(names.refresh)?.value);
  return { user: session?.user ?? null, signedIn: session !== null || hasRefresh };
}
