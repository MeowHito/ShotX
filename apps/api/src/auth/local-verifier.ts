import { LOCAL_AUTH_AUDIENCE, LOCAL_AUTH_ISSUER } from '@shotx/shared';
import { type JWTPayload, jwtVerify } from 'jose';
import { ApiError } from '../http/api-error';
import type { TokenVerifier, VerifiedIdentity } from '../tokens';
import { profileClaims } from './cognito-verifier';

const unauthenticated = () => new ApiError('UNAUTHENTICATED', 'Invalid or expired token');

/**
 * Verifies the HS256 tokens web mints with AUTH_PROVIDER=local (development only; the config
 * loader refuses `local` outside APP_STAGE=local). Every local identity is in the `users` pool:
 * there is no local admin sign-in. Local tokens carry email and name in access tokens too, so the
 * user row gets them on first use.
 */
export class LocalTokenVerifier implements TokenVerifier {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        issuer: LOCAL_AUTH_ISSUER,
        audience: LOCAL_AUTH_AUDIENCE,
        algorithms: ['HS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'token_use'],
      }));
    } catch {
      throw unauthenticated();
    }
    const tokenUse = payload.token_use;
    if (tokenUse !== 'id' && tokenUse !== 'access') throw unauthenticated();
    const sub = payload.sub;
    if (typeof sub !== 'string' || sub === '') throw unauthenticated();
    return { pool: 'users', sub, tokenUse, ...profileClaims('id', payload) };
  }
}
