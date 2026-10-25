import { randomUUID } from 'node:crypto';
import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  ANON_ID_COOKIE,
  anonIdCookie,
  isOpaqueCookieToken,
  isValidAnonId,
  VIEWER_SESSION_COOKIE,
  type Viewer,
  viewerSessionKey,
} from '@shotx/shared';
import type { Request, Response } from 'express';
import { type ApiConfig, secureCookies } from '../config';
import type { Db } from '../db/db';
import { ApiError } from '../http/api-error';
import { clientIp, ipHash, sha256Hex } from '../http/client';
import { readCookies, setCookie } from '../http/cookies';
import {
  API_CONFIG,
  DATABASE,
  KEY_VALUE_STORE,
  type KeyValueStore,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from '../tokens';
import { bearerToken, provisionUser, userById } from './users';

/** Who is calling a public route, resolved by PublicGuard (see share/viewer in @shotx/shared). */
export interface PublicContext {
  viewer: Viewer;
  /** The browser's anon id (cookie), also when the viewer is signed in. */
  anonId: string;
  /** Keyed hash of the client address (ip_hash); the address itself is never stored. */
  ipHash: string;
  /** Cookie values of the request (unlock tokens are read per share). */
  cookies: Map<string, string>;
}

const CONTEXT = Symbol('public-context');
type PublicRequest = Request & { [CONTEXT]?: PublicContext };

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const unauthenticated = (message: string) => new ApiError('UNAUTHENTICATED', message);

/** FORBIDDEN for a state-changing request whose Origin isn't PUBLIC_BASE_URL's. */
export function checkOrigin(req: Request, config: Pick<ApiConfig, 'app'>): void {
  if (!STATE_CHANGING.has(req.method)) return;
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (origin !== new URL(config.app.publicBaseUrl).origin) {
    throw new ApiError('FORBIDDEN', 'Cross-origin request refused');
  }
}

/**
 * Only the Origin check of PublicGuard, for public routes that must work whatever the cookies
 * hold (signing out with an expired viewer session).
 */
@Injectable()
export class OriginGuard implements CanActivate {
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  canActivate(context: ExecutionContext): boolean {
    checkOrigin(context.switchToHttp().getRequest<Request>(), this.config);
    return true;
  }
}

/**
 * The guard of every `public` route (RouteAuth `public`):
 *
 * 1. State-changing requests that carry an Origin other than PUBLIC_BASE_URL's are FORBIDDEN
 *    (another site's form or script). Requests without Origin (server-side callers) pass; the
 *    SameSite=Lax cookies keep cross-site POSTs anonymous anyway.
 * 2. The viewer: a users-pool bearer token, else the viewer-session cookie, else the anon cookie.
 *    A bearer token or session cookie that is present but invalid or expired is UNAUTHENTICATED.
 * 3. The anon cookie is set when missing or malformed.
 */
@Injectable()
export class PublicGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier,
    @Inject(DATABASE) private readonly db: Db,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<PublicRequest>();
    const res = http.getResponse<Response>();
    this.checkOrigin(req);

    const cookies = readCookies(req);
    let anonId = cookies.get(ANON_ID_COOKIE);
    if (anonId === undefined || !isValidAnonId(anonId)) {
      anonId = randomUUID();
      setCookie(
        res,
        anonIdCookie(this.config.share.anonIdMaxAgeDays, secureCookies(this.config)),
        anonId,
      );
    }
    const viewer = (await this.signedInViewer(req, cookies)) ?? { kind: 'anon' as const, anonId };
    req[CONTEXT] = {
      viewer,
      anonId,
      ipHash: ipHash(this.config.consent.ipHashSecret, clientIp(req)),
      cookies,
    };
    return true;
  }

  private checkOrigin(req: Request): void {
    checkOrigin(req, this.config);
  }

  private async signedInViewer(req: Request, cookies: Map<string, string>): Promise<Viewer | null> {
    if (req.headers.authorization !== undefined) {
      const token = bearerToken(req.headers.authorization);
      if (token === null) throw unauthenticated('Malformed Authorization header');
      const identity = await this.verifier.verify(token);
      if (identity.pool !== 'users') throw unauthenticated('This route needs a users-pool token');
      const user = await provisionUser(this.db, identity);
      return { kind: 'user', viewerId: user.id };
    }
    const session = cookies.get(VIEWER_SESSION_COOKIE);
    if (session === undefined) return null;
    if (!isOpaqueCookieToken(session)) throw unauthenticated('Invalid viewer session');
    const userId = await this.store.get(viewerSessionKey(sha256Hex(session)));
    if (userId === null) throw unauthenticated('Viewer session expired');
    const user = await userById(this.db, userId);
    if (user === null) throw unauthenticated('Viewer session expired');
    return { kind: 'user', viewerId: user.id };
  }
}

/** The caller of a public route. Use only on routes behind PublicGuard. */
export const CurrentPublic = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PublicContext => {
    const ctx = context.switchToHttp().getRequest<PublicRequest>()[CONTEXT];
    if (ctx === undefined) throw new Error('PublicGuard did not run');
    return ctx;
  },
);
