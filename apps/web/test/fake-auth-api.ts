import {
  AUTH_ROUTES,
  type AuthPool,
  type AuthTokenResponse,
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  ERROR_HTTP_STATUS,
  ErrorCode,
  type OidcProvider,
  type RouteContract,
} from '@shotx/shared';
import { randomToken } from '@/lib/auth/pkce';
import { encodeJsonCookie } from '@/lib/auth/session';
import { matchRoute } from '@/lib/bff/handler';

/**
 * In-memory stand-in for the API's sign-in routes (AUTH_ROUTES, AUTH_PROVIDER=shotx or local),
 * as web assumes they behave; the real ones are built in parallel in apps/api. Requests are
 * parsed with the contract's schemas, responses are checked against them, and every call is
 * recorded with its headers so tests can assert the BFF key and client IP.
 *
 * Behaviour modelled: `bff` routes need the BFF key (else UNAUTHENTICATED); OIDC state is
 * one-time; refresh tokens rotate, the family's expiry never extends, and re-use of a rotated
 * token revokes the family (REFRESH_TOKEN_REUSED).
 */

export const BFF_KEY = 'test-bff-key-0123456789abcdef0123456789';
const ACCESS_TOKEN_SECONDS = 900;

export interface RecordedCall {
  route: RouteContract;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Family {
  subject: string;
  user: AuthTokenResponse['user'];
  pool: AuthPool;
  /** Epoch ms: fixed at sign-in, never extended by rotation. */
  expiresAt: number;
  revoked: boolean;
}

class Fail extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly details?: unknown,
  ) {
    super(code);
  }
}

export class FakeAuthApi {
  readonly calls: RecordedCall[] = [];
  /** Identity providers with credentials. */
  oidc: OidcProvider[] = ['line', 'google'];
  devLogin = false;
  /** The code LINE or Google would hand back; any other code is IDENTITY_PROVIDER_ERROR. */
  readonly goodCode = 'provider-code-1';
  refreshTtlSeconds = 30 * 24 * 60 * 60;
  now = 1_700_000_000_000;
  /** Answer every call with this status (e.g. 503) instead. */
  outage: number | null = null;

  private readonly states = new Map<string, { provider: OidcProvider; redirectUri: string }>();
  private readonly refreshTokens = new Map<string, { family: Family; used: boolean }>();

  /** The tokens of a fresh sign-in (also usable to seed a session in tests). */
  signIn(subject: string, user: AuthTokenResponse['user'], pool: AuthPool = 'users') {
    const family: Family = {
      subject,
      user,
      pool,
      expiresAt: this.now + this.refreshTtlSeconds * 1000,
      revoked: false,
    };
    return this.issue(family);
  }

  private issue(family: Family): AuthTokenResponse {
    const refreshToken = randomToken(32);
    this.refreshTokens.set(refreshToken, { family, used: false });
    return {
      accessToken: `h.${encodeJsonCookie({ sub: family.subject, iat: this.now })}.s`,
      refreshToken,
      expiresIn: ACCESS_TOKEN_SECONDS,
      refreshExpiresIn: Math.ceil((family.expiresAt - this.now) / 1000),
      user: family.user,
    };
  }

  fetch: typeof fetch = (input, init) => Promise.resolve(this.respond(input, init));

  private respond(input: RequestInfo | URL, init: RequestInit | undefined): Response {
    const url = new URL(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const path = url.pathname.replace(/^\/api/, '');
    const route = matchRoute(method, path);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (route === null || route.auth !== 'bff') {
      return Response.json({ code: ErrorCode.NOT_FOUND, message: 'no' }, { status: 404 });
    }
    this.calls.push({ route, path, headers, body });
    if (this.outage !== null) return new Response('upstream down', { status: this.outage });
    try {
      if (headers[BFF_KEY_HEADER] !== BFF_KEY) throw new Fail(ErrorCode.UNAUTHENTICATED);
      const result = this.handle(route, path, body);
      if (route.status === 204) return new Response(null, { status: 204 });
      const checked = route.response?.parse(result);
      return Response.json(checked, { status: route.status });
    } catch (error) {
      if (!(error instanceof Fail)) throw error;
      return Response.json(
        { code: error.code, message: error.code, details: error.details },
        { status: ERROR_HTTP_STATUS[error.code] },
      );
    }
  }

  /** The BFF client IP header of every recorded call. */
  clientIps(): (string | undefined)[] {
    return this.calls.map((c) => c.headers[BFF_CLIENT_IP_HEADER]);
  }

  private handle(route: RouteContract, path: string, rawBody: unknown): unknown {
    const parsed = route.body?.safeParse(rawBody);
    if (parsed !== undefined && !parsed.success) throw new Fail(ErrorCode.VALIDATION_FAILED);
    const body = parsed?.data as Record<string, string> | undefined;

    switch (route) {
      case AUTH_ROUTES.providers:
        return { oidc: this.oidc, devLogin: this.devLogin, adminLogin: false };
      case AUTH_ROUTES.oidcStart: {
        const provider = AUTH_ROUTES.oidcStart.params.parse({
          provider: path.split('/')[3],
        }).provider;
        if (!this.oidc.includes(provider)) {
          throw new Fail(ErrorCode.AUTH_PROVIDER_UNAVAILABLE, { provider });
        }
        const state = randomToken(32);
        this.states.set(state, { provider, redirectUri: body?.redirectUri ?? '' });
        const authorize =
          provider === 'line'
            ? 'https://access.line.me/oauth2/v2.1/authorize'
            : 'https://accounts.google.com/o/oauth2/v2/auth';
        return { authorizationUrl: `${authorize}?state=${state}`, state };
      }
      case AUTH_ROUTES.oidcCallback: {
        const pending = this.states.get(body?.state ?? '');
        if (pending === undefined) throw new Fail(ErrorCode.LOGIN_STATE_INVALID);
        this.states.delete(body?.state ?? '');
        if (body?.code !== this.goodCode) {
          throw new Fail(ErrorCode.IDENTITY_PROVIDER_ERROR, {
            provider: pending.provider,
            reason: 'exchange_failed',
          });
        }
        return this.signIn(`${pending.provider}:U123`, { email: null, name: 'ช่างภาพ LINE' });
      }
      case AUTH_ROUTES.devLogin:
        if (!this.devLogin) throw new Fail(ErrorCode.NOT_FOUND);
        return this.signIn(`local:${body?.email ?? ''}`, {
          email: body?.email ?? null,
          name: body?.name ?? null,
        });
      case AUTH_ROUTES.refresh: {
        const entry = this.refreshTokens.get(body?.refreshToken ?? '');
        if (
          entry === undefined ||
          entry.family.revoked ||
          entry.family.pool !== body?.pool ||
          entry.family.expiresAt <= this.now
        ) {
          throw new Fail(ErrorCode.REFRESH_TOKEN_INVALID);
        }
        if (entry.used) {
          entry.family.revoked = true;
          throw new Fail(ErrorCode.REFRESH_TOKEN_REUSED);
        }
        entry.used = true;
        return this.issue(entry.family);
      }
      case AUTH_ROUTES.logout: {
        const entry = this.refreshTokens.get(body?.refreshToken ?? '');
        if (entry !== undefined) entry.family.revoked = true;
        return undefined;
      }
      default:
        throw new Fail(ErrorCode.NOT_FOUND);
    }
  }
}
