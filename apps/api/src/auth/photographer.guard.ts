import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { users } from '@shotx/db';
import { and, eq } from 'drizzle-orm';
import type { Request } from 'express';
import type { Db } from '../db/db';
import { ApiError } from '../http/api-error';
import { DATABASE, TOKEN_VERIFIER, type TokenVerifier } from '../tokens';

/** The authenticated photographer. `id` is `users.id`, resolved on the server from the token. */
export interface Photographer {
  id: string;
}

const PRINCIPAL = Symbol('photographer');

type AuthedRequest = Request & { [PRINCIPAL]?: Photographer };

/** The bearer token of the Authorization header, or null. */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined) return null;
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * The one guard of every `photographer` route. It verifies a users-pool token (an admins-pool
 * token is UNAUTHENTICATED here: admins never act as photographers, ADR 0002), maps
 * (pool, sub) to the `users` row, and requires role `photographer` (else FORBIDDEN). Services
 * then filter every query by this id; ids from the client are never trusted for ownership.
 */
@Injectable()
export class PhotographerGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(DATABASE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = bearerToken(req.headers.authorization);
    if (token === null) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
    const identity = await this.verifier.verify(token);
    if (identity.pool !== 'users') {
      throw new ApiError('UNAUTHENTICATED', 'This route needs a users-pool token');
    }
    const [user] = await this.db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.cognitoPool, 'users'), eq(users.cognitoSub, identity.sub)))
      .limit(1);
    if (user?.role !== 'photographer') {
      throw new ApiError('FORBIDDEN', 'Only photographers may use this route');
    }
    req[PRINCIPAL] = { id: user.id };
    return true;
  }
}

/** The photographer the guard resolved. Use only on routes behind PhotographerGuard. */
export const CurrentPhotographer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Photographer => {
    const principal = context.switchToHttp().getRequest<AuthedRequest>()[PRINCIPAL];
    if (principal === undefined) throw new Error('PhotographerGuard did not run');
    return principal;
  },
);
