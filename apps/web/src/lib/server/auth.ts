import 'server-only';
import { cookies } from 'next/headers';
import { createCognitoAuthProvider } from '../auth/cognito';
import type { AuthDeps } from '../auth/handlers';
import { cookieNames, decodeSession, type Session } from '../auth/session';
import { webConfig } from './config';

/** Auth dependencies of the route handlers, from the environment. */
export function authDeps(): AuthDeps {
  const config = webConfig();
  return {
    provider: createCognitoAuthProvider(config.cognito),
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
