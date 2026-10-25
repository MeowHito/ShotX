import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Db } from '../db/db';
import { ApiError } from '../http/api-error';
import { DATABASE, TOKEN_VERIFIER, type TokenVerifier } from '../tokens';
import { type AppUser, bearerToken, provisionUser } from './users';

export { bearerToken } from './users';

/** The authenticated photographer. `id` is `users.id`, resolved on the server from the token. */
export interface Photographer {
  id: string;
}

const PRINCIPAL = Symbol('principal');

type AuthedRequest = Request & { [PRINCIPAL]?: AppUser };

/**
 * Verifies a users-pool token and provisions its `users` row (ADR 0002). An admins-pool token is
 * UNAUTHENTICATED here: admins never act as photographers or viewers outside `/admin/*`.
 */
async function authenticateUser(
  req: AuthedRequest,
  verifier: TokenVerifier,
  db: Db,
): Promise<AppUser> {
  const token = bearerToken(req.headers.authorization);
  if (token === null) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
  const identity = await verifier.verify(token);
  if (identity.pool !== 'users') {
    throw new ApiError('UNAUTHENTICATED', 'This route needs a users-pool token');
  }
  const user = await provisionUser(db, identity);
  req[PRINCIPAL] = user;
  return user;
}

/**
 * The guard of every `user` route (RouteAuth `user`): any users-pool identity, viewer or
 * photographer. The `users` row is provisioned on first use.
 */
@Injectable()
export class UserGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(DATABASE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await authenticateUser(context.switchToHttp().getRequest(), this.verifier, this.db);
    return true;
  }
}

/**
 * The one guard of every `photographer` route. Like UserGuard (so a first request provisions the
 * user), then requires role `photographer` (else FORBIDDEN: POST /me/photographer first).
 * Services filter every query by this id; ids from the client are never trusted for ownership.
 */
@Injectable()
export class PhotographerGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(DATABASE) private readonly db: Db,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = await authenticateUser(
      context.switchToHttp().getRequest(),
      this.verifier,
      this.db,
    );
    if (user.role !== 'photographer') {
      throw new ApiError('FORBIDDEN', 'Only photographers may use this route');
    }
    return true;
  }
}

function principal(context: ExecutionContext): AppUser {
  const user = context.switchToHttp().getRequest<AuthedRequest>()[PRINCIPAL];
  if (user === undefined) throw new Error('UserGuard or PhotographerGuard did not run');
  return user;
}

/** The photographer the guard resolved. Use only on routes behind PhotographerGuard. */
export const CurrentPhotographer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Photographer => ({ id: principal(context).id }),
);

/** The user the guard resolved. Use only on routes behind UserGuard or PhotographerGuard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AppUser => principal(context),
);
