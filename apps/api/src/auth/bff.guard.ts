import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { apiIssuesTokens, type AuthPool, type BffKeyScope } from '@shotx/shared';
import type { Request } from 'express';
import { type ApiConfig, clientIpTrust } from '../config';
import { ApiError, notFound } from '../http/api-error';
import { clientIp, hasValidBffKey, ipHash } from '../http/client';
import { matchedContract } from '../http/route-contract';
import { API_CONFIG } from '../tokens';

const IP_HASH = Symbol('bff-ip-hash');
const KEY_POOL = Symbol('bff-key-pool');
type BffRequest = Request & { [IP_HASH]?: string; [KEY_POOL]?: AuthPool };

const wrongKey = () => new ApiError('UNAUTHENTICATED', 'Server-side callers only');

/** Whether a key of `pool` may call a route of `scope` (BffKeyScope; `request` is checked later). */
function scopeAllows(scope: BffKeyScope, pool: AuthPool): boolean {
  switch (scope) {
    case 'users':
      return pool === 'users';
    case 'admins':
      return pool === 'admins';
    case 'request':
    case 'either':
      return true;
  }
}

/**
 * The guard of every `bff` route (AUTH_ROUTES): NOT_FOUND with AUTH_PROVIDER=cognito, then the
 * BFF key in BFF_KEY_HEADER (constant-time compare against both apps' keys) must be one the
 * route's `bffKey` scope accepts (ADR 0010 round 2): `users` web's key only, `admins` the admin
 * app's only, `either` any, `request` any here, then matched against the request's pool by the
 * route (POST /auth/refresh: the body's `pool`; POST /auth/logout: the token's session pool; see
 * BffKeyPool). Missing, wrong or the other app's key: UNAUTHENTICATED; a route without a contract
 * scope fails closed. No user token, no cookies, no Origin check. Stores the client's ip_hash
 * (clientIp: the BFF passes the end user's address) for the sign-in rate limits.
 */
@Injectable()
export class BffGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!apiIssuesTokens(this.config.auth.provider)) throw notFound('Route');
    const req = context.switchToHttp().getRequest<BffRequest>();
    const pool = hasValidBffKey(req, clientIpTrust(this.config));
    const scope = matchedContract(req)?.bffKey;
    if (pool === null || scope === undefined || !scopeAllows(scope, pool)) throw wrongKey();
    req[KEY_POOL] = pool;
    req[IP_HASH] = ipHash(
      this.config.consent.ipHashSecret,
      clientIp(req, clientIpTrust(this.config)),
    );
    return true;
  }
}

/** The caller's ip_hash. Use only on routes behind BffGuard. */
export const BffIpHash = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const value = context.switchToHttp().getRequest<BffRequest>()[IP_HASH];
  if (value === undefined) throw new Error('BffGuard did not run');
  return value;
});

/**
 * The pool of the BFF key the caller sent (`users`: web, `admins`: admin app). For `request`
 * scoped routes, which compare it with the pool the request concerns. Only behind BffGuard.
 */
export const BffKeyPool = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthPool => {
    const value = context.switchToHttp().getRequest<BffRequest>()[KEY_POOL];
    if (value === undefined) throw new Error('BffGuard did not run');
    return value;
  },
);

/**
 * The admin app's key only (AUTH_ADMIN_BFF_KEY; `bffKey: 'admins'`): runs before AdminGuard on
 * every `auth: 'admin'` route, so an admins-pool token is accepted only from the admin app's
 * server (ADR 0010). No NOT_FOUND by AUTH_PROVIDER and no ip_hash. Missing key, web's key, a
 * wrong one, or a request through the public proxy: UNAUTHENTICATED. Without AUTH_ADMIN_BFF_KEY
 * (allowed only with AUTH_PROVIDER=cognito) every admin route refuses.
 */
@Injectable()
export class BffKeyGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (hasValidBffKey(req, clientIpTrust(this.config)) !== 'admins') throw wrongKey();
    return true;
  }
}
