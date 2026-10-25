import { AUTH_POOLS, type AuthPool, type CognitoPoolConfig } from '@shotx/shared';
import {
  createRemoteJWKSet,
  decodeJwt,
  type JWTPayload,
  jwtVerify,
  type JWTVerifyGetKey,
} from 'jose';
import { ApiError } from '../http/api-error';
import type { TokenVerifier, VerifiedIdentity } from '../tokens';

/** The JWKS of each pool. Production fetches `<issuer>/.well-known/jwks.json`; tests pass local keys. */
export type JwksByPool = Record<AuthPool, JWTVerifyGetKey>;

export function remoteJwks(pools: Record<AuthPool, CognitoPoolConfig>): JwksByPool {
  const jwks = (pool: AuthPool) =>
    createRemoteJWKSet(new URL(`${pools[pool].issuer}/.well-known/jwks.json`));
  return { users: jwks('users'), admins: jwks('admins') };
}

const unauthenticated = () => new ApiError('UNAUTHENTICATED', 'Invalid or expired token');

/**
 * Verifies Cognito JWTs from both user pools (ADR 0002). The pool is chosen by the token's
 * issuer, then the token is verified against that pool's own JWKS, issuer and app client:
 * `aud` for ID tokens, `client_id` for access tokens. A token whose issuer is neither pool is
 * rejected before any key lookup. Groups and other claims are never used for roles.
 */
export class CognitoTokenVerifier implements TokenVerifier {
  constructor(
    private readonly pools: Record<AuthPool, CognitoPoolConfig>,
    private readonly jwks: JwksByPool,
  ) {}

  async verify(token: string): Promise<VerifiedIdentity> {
    let unverified: JWTPayload;
    try {
      unverified = decodeJwt(token);
    } catch {
      throw unauthenticated();
    }
    const pool = AUTH_POOLS.find((p) => this.pools[p].issuer === unverified.iss);
    if (pool === undefined) throw unauthenticated();
    const config = this.pools[pool];

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.jwks[pool], {
        issuer: config.issuer,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'token_use'],
      }));
    } catch {
      throw unauthenticated();
    }

    const tokenUse = payload.token_use;
    if (tokenUse === 'id') {
      // jose checks `aud` only when asked; check it here so the message stays generic.
      const aud = payload.aud;
      const audiences = Array.isArray(aud) ? aud : [aud];
      if (audiences.length !== 1 || audiences[0] !== config.clientId) throw unauthenticated();
    } else if (tokenUse === 'access') {
      if (payload.client_id !== config.clientId) throw unauthenticated();
    } else {
      throw unauthenticated();
    }
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub === '') throw unauthenticated();
    return { pool, sub, tokenUse };
  }
}
