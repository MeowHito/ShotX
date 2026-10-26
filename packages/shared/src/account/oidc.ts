import type { OidcProvider } from '../domain';

/**
 * Static OpenID Connect metadata of the providers the API runs itself (authorization code flow
 * with PKCE S256 and a nonce). Values from each provider's documentation; Google also publishes
 * them at https://accounts.google.com/.well-known/openid-configuration. Verify ID tokens per
 * provider: Google with its JWKS (RS256); LINE as documented for LINE Login v2.1 (web login ID
 * tokens are HS256 with the channel secret, or use `verifyEndpoint`). Never trust an unverified
 * ID token's `sub`.
 */
export interface OidcProviderMetadata {
  /** Accepted `iss` values of ID tokens. */
  issuers: readonly string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** LINE's ID token verification endpoint; null for providers without one. */
  verifyEndpoint: string | null;
  scopes: readonly string[];
}

export const OIDC_PROVIDER_METADATA = {
  line: {
    issuers: ['https://access.line.me'],
    authorizationEndpoint: 'https://access.line.me/oauth2/v2.1/authorize',
    tokenEndpoint: 'https://api.line.me/oauth2/v2.1/token',
    jwksUri: 'https://api.line.me/oauth2/v2.1/certs',
    verifyEndpoint: 'https://api.line.me/oauth2/v2.1/verify',
    // `email` needs LINE's approval of the channel's email permission; until then it is absent.
    scopes: ['openid', 'profile', 'email'],
  },
  google: {
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    verifyEndpoint: null,
    scopes: ['openid', 'profile', 'email'],
  },
} as const satisfies Record<OidcProvider, OidcProviderMetadata>;
