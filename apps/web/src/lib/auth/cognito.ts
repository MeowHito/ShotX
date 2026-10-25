import type { CognitoPoolConfig } from '@shotx/shared';
import { z } from 'zod';
import { type AuthProvider, AuthProviderError, type AuthTokens } from './provider';

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  id_token: z.string().min(1).optional(),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
});

const SCOPES = 'openid email profile';

/**
 * Cognito user pool OAuth 2.0 endpoints (Hosted UI / managed login). The web client is public
 * (no secret): authorization code flow with PKCE.
 */
export function createCognitoAuthProvider(
  config: Pick<CognitoPoolConfig, 'domain' | 'clientId'>,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): AuthProvider {
  const domain = config.domain.replace(/\/+$/, '');

  async function tokenRequest(params: Record<string, string>): Promise<AuthTokens> {
    let response: Response;
    try {
      response = await fetchImpl(`${domain}/oauth2/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: config.clientId, ...params }).toString(),
        cache: 'no-store',
      });
    } catch {
      throw new AuthProviderError('Token endpoint unreachable');
    }
    if (!response.ok) {
      throw new AuthProviderError(`Token endpoint answered ${response.status}`, response.status);
    }
    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new AuthProviderError('Unexpected token response');
    return {
      accessToken: parsed.data.access_token,
      idToken: parsed.data.id_token,
      refreshToken: parsed.data.refresh_token,
      expiresIn: parsed.data.expires_in,
    };
  }

  return {
    authorizationUrl({ state, codeChallenge, redirectUri, identityProvider }) {
      const url = new URL(`${domain}/oauth2/authorize`);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('scope', SCOPES);
      url.searchParams.set('state', state);
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      // Managed login pages in Thai.
      url.searchParams.set('lang', 'th');
      if (identityProvider !== undefined) {
        url.searchParams.set('identity_provider', identityProvider);
      }
      return url.toString();
    },

    exchangeCode({ code, codeVerifier, redirectUri }) {
      return tokenRequest({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
      });
    },

    refresh(refreshToken) {
      return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
    },

    async revoke(refreshToken) {
      try {
        await fetchImpl(`${domain}/oauth2/revoke`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, token: refreshToken }).toString(),
          cache: 'no-store',
        });
      } catch {
        // Best effort: the cookies are cleared either way.
      }
    },

    logoutUrl(returnTo) {
      const url = new URL(`${domain}/logout`);
      url.searchParams.set('client_id', config.clientId);
      url.searchParams.set('logout_uri', returnTo);
      return url.toString();
    },
  };
}
