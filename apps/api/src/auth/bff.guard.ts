import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { apiIssuesTokens } from '@shotx/shared';
import type { Request } from 'express';
import { type ApiConfig, clientIpTrust } from '../config';
import { ApiError, notFound } from '../http/api-error';
import { clientIp, hasValidBffKey, ipHash } from '../http/client';
import { API_CONFIG } from '../tokens';

const IP_HASH = Symbol('bff-ip-hash');
type BffRequest = Request & { [IP_HASH]?: string };

/**
 * The guard of every `bff` route (AUTH_ROUTES): NOT_FOUND with AUTH_PROVIDER=cognito, then the
 * shared key in BFF_KEY_HEADER (constant-time compare; missing or wrong: UNAUTHENTICATED). No
 * user token, no cookies, no Origin check. Stores the client's ip_hash (clientIp: the BFF passes
 * the end user's address) for the sign-in rate limits.
 */
@Injectable()
export class BffGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    if (!apiIssuesTokens(this.config.auth.provider)) throw notFound('Route');
    const req = context.switchToHttp().getRequest<BffRequest>();
    if (!hasValidBffKey(req, clientIpTrust(this.config))) {
      throw new ApiError('UNAUTHENTICATED', 'Server-side callers only');
    }
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
