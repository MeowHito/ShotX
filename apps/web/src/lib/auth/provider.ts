import type { ErrorCode, OidcProvider, PhotographerSignInResponse } from '@shotx/shared';

/**
 * The identity provider behind login, chosen by AUTH_PROVIDER (src/lib/server/auth):
 * - `shotx` / `local`: the API issues the tokens and runs LINE and Google itself
 *   (src/lib/auth/shotx, ADR 0008 section 4); `local` adds the development sign-in;
 * - `cognito`: Cognito's Hosted UI (src/lib/auth/cognito), until infra/ is removed.
 * Tests use fakes. Every method runs server-side; tokens never reach browser JS.
 */

export interface AuthTokens {
  accessToken: string;
  /** Cognito only. */
  idToken?: string;
  /** Absent on refresh when the provider doesn't rotate it (Cognito). */
  refreshToken?: string;
  /** Lifetime of the access token in seconds. */
  expiresIn: number;
  /**
   * Seconds until the refresh token's sign-in ends (the session cookies' max-age). Rotation never
   * extends it. Absent (Cognito): AuthDeps.refreshTokenMaxAgeSeconds.
   */
  refreshExpiresIn?: number;
  /** The person as the API reports it. Absent (Cognito): from the ID token. */
  user?: { email: string | null; name: string | null };
}

export interface LoginStart {
  /** Where to send the browser. */
  authorizationUrl: string;
  /** Bound to the browser in the pending-login cookie and compared on the callback. */
  state: string;
  /** PKCE verifier kept in the pending-login cookie (Cognito). Absent: the API holds it. */
  codeVerifier?: string;
}

export interface AuthProvider {
  startLogin: (input: {
    identityProvider: OidcProvider;
    redirectUri: string;
  }) => Promise<LoginStart>;
  /** Finishes the sign-in with what the identity provider sent to the callback. */
  completeLogin: (input: {
    code: string;
    state: string;
    codeVerifier?: string;
    redirectUri: string;
  }) => Promise<AuthTokens>;
  refresh: (refreshToken: string) => Promise<AuthTokens>;
  /** Revokes a refresh token (and the access tokens issued from it). Best effort. */
  revoke: (refreshToken: string) => Promise<void>;
  /** Where to send the browser to end the provider's own session, then come back. */
  logoutUrl: (returnTo: string) => string;
  /**
   * ADR 0018: exchanges an admin's one-time act-as code for a session of the photographer (API-
   * issued tokens only; absent with Cognito).
   */
  actAs?: (code: string) => Promise<AuthTokens>;
  /** The development sign-in (AUTH_PROVIDER=local only); absent everywhere else. */
  devLogin?: (identity: { email: string; name: string }) => Promise<AuthTokens>;
  /**
   * Photographer email + password (ADR 0010; API-issued tokens only, absent with Cognito).
   * `change_password`: the tokens are a restricted session that may only change the password.
   */
  passwordSignIn?: (credentials: { email: string; password: string }) => Promise<{
    step: PhotographerSignInStep;
    tokens: AuthTokens;
  }>;
  /**
   * The signed-in photographer changes their own password with their access token (the forced
   * first change and any later one). The API revokes every session of the account and answers
   * with a new one, which replaces the session cookies.
   */
  changePassword?: (input: {
    accessToken: string;
    currentPassword: string;
    newPassword: string;
  }) => Promise<AuthTokens>;
}

export type PhotographerSignInStep = PhotographerSignInResponse['step'];

export class AuthProviderError extends Error {
  override readonly name = 'AuthProviderError';

  constructor(
    message: string,
    /** HTTP status of the provider's answer; absent when there was none. */
    readonly status?: number,
    /** The API's error code (API-issued tokens). */
    readonly code?: ErrorCode,
    /** The API's error details (e.g. PASSWORD_TOO_WEAK's reason and minimum length). */
    readonly details?: unknown,
  ) {
    super(message);
  }

  /** The provider didn't decide anything (unreachable, timeout, 5xx): worth retrying later. */
  get transient(): boolean {
    return this.status === undefined || this.status >= 500;
  }
}
