/**
 * The identity provider behind login. Production uses Cognito's Hosted UI (src/lib/auth/cognito);
 * tests use a fake. Every method talks to the provider server-side; tokens never reach browser JS.
 */

/** Cognito identity provider names (infra IDP_NAMES). Absent: the Hosted UI's own sign-in. */
export const IDENTITY_PROVIDERS = { google: 'Google', line: 'LINE' } as const;
export type IdentityProviderName = (typeof IDENTITY_PROVIDERS)[keyof typeof IDENTITY_PROVIDERS];

export interface AuthTokens {
  accessToken: string;
  /** Absent on refresh when the provider doesn't rotate it. */
  idToken?: string;
  refreshToken?: string;
  /** Lifetime of the access token in seconds. */
  expiresIn: number;
}

export interface AuthorizationRequest {
  state: string;
  codeChallenge: string;
  redirectUri: string;
  identityProvider?: IdentityProviderName;
}

export interface AuthProvider {
  authorizationUrl: (request: AuthorizationRequest) => string;
  exchangeCode: (input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }) => Promise<AuthTokens>;
  refresh: (refreshToken: string) => Promise<AuthTokens>;
  /** Revokes a refresh token (and the access tokens issued from it). Best effort. */
  revoke: (refreshToken: string) => Promise<void>;
  /** Where to send the browser to end the provider's own session, then come back. */
  logoutUrl: (returnTo: string) => string;
}

export class AuthProviderError extends Error {
  override readonly name = 'AuthProviderError';

  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
