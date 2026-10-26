import { createHash } from 'node:crypto';
import {
  authIdentitySchema,
  authSubject,
  type IdentityProviderErrorReason,
  OIDC_PROVIDER_METADATA,
  OIDC_PROVIDERS,
  type OidcClientConfig,
  type OidcProvider,
} from '@shotx/shared';
import {
  createRemoteJWKSet,
  errors as joseErrors,
  type JWTPayload,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { ApiError } from '../http/api-error';

// LINE Login and Google sign-in run by the API (OpenID Connect authorization code flow with PKCE
// S256, `state` and `nonce`; ADR 0008 section 4). Nothing here logs codes, tokens or claims.

/** The HTTP client of the code exchange (global fetch in production; a fake in tests). */
export type OidcFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface OidcDeps {
  fetch: OidcFetch;
  /** Google's signing keys (createRemoteJWKSet in production; local keys in tests). */
  googleJwks: JWTVerifyGetKey;
  /** AUTH_OIDC_HTTP_TIMEOUT_MS: one HTTP call to a provider (code exchange, Google's JWKS). */
  timeoutMs: number;
  now: () => Date;
}

/** Google's JWKS, fetched over HTTPS and cached by jose. */
export function remoteGoogleJwks(timeoutMs: number): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(OIDC_PROVIDER_METADATA.google.jwksUri), {
    timeoutDuration: timeoutMs,
  });
}

/** The PKCE S256 challenge of a verifier (RFC 7636). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** A verified provider identity, ready for provisionUser. */
export interface OidcIdentity {
  /** `line:<sub>` or `google:<sub>`. */
  subject: string;
  /** Only when the provider says it is verified (`email_verified: true`). */
  email: string | null;
  name: string | null;
}

const providerError = (provider: OidcProvider, reason: IdentityProviderErrorReason) =>
  new ApiError('IDENTITY_PROVIDER_ERROR', 'The identity provider sign-in failed', {
    provider,
    reason,
  });

/**
 * Email and name from verified ID token claims: email only with `email_verified === true` (LINE
 * ID tokens carry no such claim, so LINE emails are never taken as verified), each only when it
 * fits the shared identity schema.
 */
export function idTokenProfile(payload: JWTPayload): { email: string | null; name: string | null } {
  const email =
    payload.email_verified === true
      ? authIdentitySchema.shape.email.safeParse(payload.email)
      : { success: false as const };
  const rawName = typeof payload.name === 'string' ? payload.name : null;
  const name = authIdentitySchema.shape.name.safeParse(rawName);
  return {
    email: email.success ? (email.data ?? null) : null,
    name: name.success ? (name.data ?? null) : null,
  };
}

/** The configured OIDC clients of the users pool. */
export class OidcClients {
  constructor(
    private readonly clients: Record<OidcProvider, OidcClientConfig | null>,
    private readonly deps: OidcDeps,
  ) {}

  /** Providers with credentials (GET /auth/providers). */
  enabled(): OidcProvider[] {
    return OIDC_PROVIDERS.filter((p) => this.clients[p] !== null);
  }

  /** AUTH_PROVIDER_UNAVAILABLE for a provider without credentials. */
  client(provider: OidcProvider): OidcClientConfig {
    const client = this.clients[provider];
    if (client === null) {
      throw new ApiError('AUTH_PROVIDER_UNAVAILABLE', 'This sign-in method is not available', {
        provider,
      });
    }
    return client;
  }

  /** The provider's authorization URL with state, nonce and the PKCE S256 challenge. */
  authorizationUrl(
    provider: OidcProvider,
    input: { state: string; nonce: string; codeVerifier: string; redirectUri: string },
  ): string {
    const meta = OIDC_PROVIDER_METADATA[provider];
    const url = new URL(meta.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.client(provider).clientId,
      redirect_uri: input.redirectUri,
      scope: meta.scopes.join(' '),
      state: input.state,
      nonce: input.nonce,
      code_challenge: pkceChallenge(input.codeVerifier),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  /**
   * Exchanges the code at the provider's token endpoint (HTTPS, with a timeout, no redirects) and
   * verifies the ID token. IDENTITY_PROVIDER_ERROR: `exchange_failed` (4xx or no ID token),
   * `unavailable` (timeout, network, 5xx, JWKS fetch), `id_token_invalid` (signature, iss, aud,
   * exp, nonce, sub).
   */
  async exchange(
    provider: OidcProvider,
    input: { code: string; codeVerifier: string; redirectUri: string; nonce: string },
  ): Promise<OidcIdentity> {
    const client = this.client(provider);
    const meta = OIDC_PROVIDER_METADATA[provider];
    if (new URL(meta.tokenEndpoint).protocol !== 'https:')
      throw providerError(provider, 'unavailable');

    let response: Response;
    try {
      response = await this.deps.fetch(meta.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: input.redirectUri,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          code_verifier: input.codeVerifier,
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(this.deps.timeoutMs),
      });
    } catch {
      throw providerError(provider, 'unavailable');
    }
    if (response.status >= 500) throw providerError(provider, 'unavailable');
    if (!response.ok) throw providerError(provider, 'exchange_failed');
    let idToken: unknown;
    try {
      idToken = ((await response.json()) as { id_token?: unknown }).id_token;
    } catch {
      throw providerError(provider, 'exchange_failed');
    }
    if (typeof idToken !== 'string' || idToken === '') {
      throw providerError(provider, 'exchange_failed');
    }

    const payload = await this.verifyIdToken(provider, client, idToken);
    if (payload.nonce !== input.nonce) throw providerError(provider, 'id_token_invalid');
    let subject: string;
    try {
      subject = authSubject(provider, String(payload.sub));
    } catch {
      throw providerError(provider, 'id_token_invalid');
    }
    return { subject, ...idTokenProfile(payload) };
  }

  private async verifyIdToken(
    provider: OidcProvider,
    client: OidcClientConfig,
    idToken: string,
  ): Promise<JWTPayload> {
    const meta = OIDC_PROVIDER_METADATA[provider];
    const options = {
      issuer: [...meta.issuers],
      audience: client.clientId,
      currentDate: this.deps.now(),
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
    };
    try {
      if (provider === 'google') {
        const { payload } = await jwtVerify(idToken, this.deps.googleJwks, {
          ...options,
          algorithms: ['RS256'],
        });
        // With several audiences, the authorized party must be us.
        if (payload.azp !== undefined && payload.azp !== client.clientId) {
          throw providerError(provider, 'id_token_invalid');
        }
        return payload;
      }
      // LINE Login v2.1 web login: HS256 with the channel secret.
      const { payload } = await jwtVerify(idToken, new TextEncoder().encode(client.clientSecret), {
        ...options,
        algorithms: ['HS256'],
      });
      return payload;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const unavailable =
        error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError);
      throw providerError(provider, unavailable ? 'unavailable' : 'id_token_invalid');
    }
  }
}
