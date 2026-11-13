import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import { allowedDuringPasswordChange, PHOTOGRAPHER_ACCOUNT_ROUTES } from '@shotx/shared';
import type { Request } from 'express';
import type { Db } from '../db/db';
import { ApiError } from '../http/api-error';
import { writeAdminAudit } from '../admin/admin-audit';
import { matchedRoute } from '../http/route-contract';
import { CLOCK, type Clock, DATABASE, TOKEN_VERIFIER, type TokenVerifier } from '../tokens';
import {
  type AppUser,
  assertAccountActive,
  assertUserSessionLive,
  bearerToken,
  provisionUser,
} from './users';

export { bearerToken } from './users';

/** The authenticated photographer. `id` is `users.id`, resolved on the server from the token. */
export interface Photographer {
  id: string;
}

const PRINCIPAL = Symbol('principal');

/** The guard's user plus whether the session is restricted (PASSWORD_CHANGE_CLAIM). */
export interface UserPrincipal extends AppUser {
  passwordChangeRequired: boolean;
  /** ADR 0018: the admin acting in this account (act-as session), or null. */
  actingAdminId: string | null;
}

const AUDITED_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

type AuthedRequest = Request & { [PRINCIPAL]?: UserPrincipal };

/**
 * Verifies a users-pool token and provisions its `users` row (ADR 0002). An admins-pool token is
 * UNAUTHENTICATED here: admins never act as photographers or viewers outside `/admin/*`. Then,
 * in this one place for every `user` and `photographer` route (ADR 0010):
 * - a ShotX-issued token's session must be live (assertUserSessionLive), else UNAUTHENTICATED;
 * - a disabled account is ACCOUNT_DISABLED (its sessions were revoked when it was disabled, but
 *   an access token lives until it expires);
 * - a restricted session (PASSWORD_CHANGE_CLAIM) is PASSWORD_CHANGE_REQUIRED on every route but
 *   PASSWORD_CHANGE_ALLOWED_ROUTES.
 */
async function authenticateUser(
  req: AuthedRequest,
  verifier: TokenVerifier,
  db: Db,
  clock: Clock,
): Promise<UserPrincipal> {
  const token = bearerToken(req.headers.authorization);
  if (token === null) throw new ApiError('UNAUTHENTICATED', 'Authentication required');
  const identity = await verifier.verify(token);
  if (identity.pool !== 'users') {
    throw new ApiError('UNAUTHENTICATED', 'This route needs a users-pool token');
  }
  const user = await provisionUser(db, identity);
  assertAccountActive(user);
  const now = clock.now();
  const { actingAdminId } = await assertUserSessionLive(db, identity, user.id, now);
  if (actingAdminId !== null) {
    const route = matchedRoute(req);
    // ADR 0018: an admin never changes the photographer's password from their studio (the admin
    // app resets it, audited, instead).
    if (
      route !== null &&
      route.method === PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword.method &&
      route.path === PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword.path
    ) {
      throw new ApiError('FORBIDDEN', 'Reset the password from the admin app instead');
    }
    // Every change the admin makes here is audited under the admin's name: the route pattern
    // only, never ids or bodies from the request.
    if (route !== null && AUDITED_METHODS.has(route.method) && identity.sessionId !== undefined) {
      await writeAdminAudit(db, {
        actorId: actingAdminId,
        action: 'admin.act_as.request',
        target: 'user',
        targetId: user.id,
        meta: {
          method: route.method as 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          route: route.path,
          sessionId: identity.sessionId,
        },
        now,
      });
    }
  }
  const passwordChangeRequired = identity.passwordChange === true && actingAdminId === null;
  if (passwordChangeRequired) {
    const route = matchedRoute(req);
    if (route === null || !allowedDuringPasswordChange(route)) {
      throw new ApiError('PASSWORD_CHANGE_REQUIRED', 'Change your temporary password first');
    }
  }
  const principal = { ...user, passwordChangeRequired, actingAdminId };
  req[PRINCIPAL] = principal;
  return principal;
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
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    await authenticateUser(context.switchToHttp().getRequest(), this.verifier, this.db, this.clock);
    return true;
  }
}

/**
 * The one guard of every `photographer` route. Like UserGuard (so a first request provisions the
 * user), then requires role `photographer` (else FORBIDDEN: only an admin creates photographers,
 * ADR 0010).
 * Services filter every query by this id; ids from the client are never trusted for ownership.
 */
@Injectable()
export class PhotographerGuard implements CanActivate {
  constructor(
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const user = await authenticateUser(
      context.switchToHttp().getRequest(),
      this.verifier,
      this.db,
      this.clock,
    );
    if (user.role !== 'photographer') {
      throw new ApiError('FORBIDDEN', 'Only photographers may use this route');
    }
    return true;
  }
}

function principal(context: ExecutionContext): UserPrincipal {
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
  (_data: unknown, context: ExecutionContext): UserPrincipal => principal(context),
);
