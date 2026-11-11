import { OIDC_PROVIDERS, type OidcProvider, viewerLoginAvailable } from '@shotx/shared';

/** How a share viewer can sign in (nothing secret: what GET /auth/providers reports). */
export interface ViewerLoginOptions {
  /** LINE/Google with credentials, in display order; may be empty in production. */
  oidc: readonly OidcProvider[];
  /** The development sign-in (AUTH_PROVIDER=local). */
  devLogin: boolean;
}

/** What is offered when nothing is known (Cognito, or GET /auth/providers failed). */
export const ALL_VIEWER_LOGINS: ViewerLoginOptions = { oidc: OIDC_PROVIDERS, devLogin: false };

/** The shared viewerLoginAvailable for these options: a require_login share can be opened. */
export function canViewerSignIn(options: ViewerLoginOptions): boolean {
  return viewerLoginAvailable({ oidc: [...options.oidc], devLogin: options.devLogin });
}
