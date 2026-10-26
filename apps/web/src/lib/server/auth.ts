import 'server-only';
import { cookies } from 'next/headers';
import { createCognitoAuthProvider } from '../auth/cognito';
import type { AuthDeps } from '../auth/handlers';
import { createLocalAuthProvider } from '../auth/local';
import type { AuthProvider } from '../auth/provider';
import { cookieNames, decodeSession, type Session } from '../auth/session';
import { type WebConfig, webConfig } from './config';

function authProvider(config: WebConfig): AuthProvider {
  if (config.auth.provider === 'local') {
    return createLocalAuthProvider({
      secret: config.auth.secret,
      publicBaseUrl: config.publicBaseUrl,
    });
  }
  if (config.cognito === null) throw new Error('Cognito configuration is missing');
  return createCognitoAuthProvider(config.cognito);
}

/** Auth dependencies of the route handlers, from the environment. */
export function authDeps(): AuthDeps {
  const config = webConfig();
  return {
    provider: authProvider(config),
    publicBaseUrl: config.publicBaseUrl,
    secureCookies: config.secureCookies,
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
