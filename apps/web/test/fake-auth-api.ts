import {
  AUTH_ROUTES,
  type AuthPool,
  normalizeAccountEmail,
  PASSWORD_CHANGE_CLAIM,
  PHOTOGRAPHER_ACCOUNT_ROUTES,
  passwordAccountSubject,
  passwordPolicyViolation,
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
 * token revokes the family (REFRESH_TOKEN_REUSED). Photographer email + password (ADR 0010):
 * one INVALID_CREDENTIALS for every wrong pair, a lockout after `lockoutThreshold` failures
 * (RATE_LIMITED), ACCOUNT_DISABLED only after the right password, a temporary password answers
 * `change_password` with a restricted, short-lived session (PASSWORD_CHANGE_CLAIM), and the
 * password change (the photographer's bearer token) checks the current password and the policy,
 * revokes every session of the account and answers a new one.
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
  /** A temporary password's session: only the password change works. */
  restricted?: boolean;
}

/** A photographer account an admin created (users pool, `password:` subject). */
export interface PasswordAccount {
  subject: string;
  email: string;
  name: string;
  password: string;
  mustChange: boolean;
  disabled: boolean;
  failures: number;
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
  /** PHOTOGRAPHER_PASSWORD_MIN_LENGTH. */
  passwordMinLength = 10;
  /** PHOTOGRAPHER_PASSWORD_CHANGE_SESSION_TTL_SECONDS. */
  restrictedTtlSeconds = 30 * 60;
  /** PHOTOGRAPHER_LOGIN_LOCKOUT_THRESHOLD; the lock lasts PHOTOGRAPHER_LOGIN_LOCKOUT_SECONDS. */
  lockoutThreshold = 5;
  lockoutSeconds = 15 * 60;
  /** Photographer accounts by normalized email. */
  readonly accounts = new Map<string, PasswordAccount>();
  /** Every family issued, for revocation and bearer checks. */
  private readonly families: Family[] = [];
  private readonly accessTokens = new Map<string, Family>();

  private readonly states = new Map<string, { provider: OidcProvider; redirectUri: string }>();
  private readonly refreshTokens = new Map<string, { family: Family; used: boolean }>();

  /** The tokens of a fresh sign-in (also usable to seed a session in tests). */
  signIn(
    subject: string,
    user: AuthTokenResponse['user'],
    pool: AuthPool = 'users',
    restricted = false,
  ) {
    const family: Family = {
      subject,
      user,
      pool,
      expiresAt:
        this.now + (restricted ? this.restrictedTtlSeconds : this.refreshTtlSeconds) * 1000,
      revoked: false,
      restricted,
    };
    this.families.push(family);
    return this.issue(family);
  }

  /** Seeds a photographer account an admin created (temporary password by default). */
  addPhotographer(account: {
    email: string;
    password: string;
    name?: string;
    mustChange?: boolean;
    disabled?: boolean;
  }): PasswordAccount {
    const created: PasswordAccount = {
      subject: passwordAccountSubject(crypto.randomUUID()),
      email: account.email,
      name: account.name ?? 'ช่างภาพ',
      password: account.password,
      mustChange: account.mustChange ?? true,
      disabled: account.disabled ?? false,
      failures: 0,
    };
    this.accounts.set(normalizeAccountEmail(account.email), created);
    return created;
  }

  /** True while the refresh token can still be used (not revoked, rotated or expired). */
  refreshTokenWorks(refreshToken: string): boolean {
    const entry = this.refreshTokens.get(refreshToken);
    return (
      entry !== undefined &&
      !entry.used &&
      !entry.family.revoked &&
      entry.family.expiresAt > this.now
    );
  }

  /** The family an access token belongs to (tests). */
  familyOf(accessToken: string): Family | undefined {
    return this.accessTokens.get(accessToken);
  }

  private issue(family: Family): AuthTokenResponse {
    const refreshToken = randomToken(32);
    this.refreshTokens.set(refreshToken, { family, used: false });
    const accessToken = `h.${encodeJsonCookie({
      sub: family.subject,
      iat: this.now,
      jti: randomToken(8),
      ...(family.restricted === true ? { [PASSWORD_CHANGE_CLAIM]: true } : {}),
    })}.s`;
    this.accessTokens.set(accessToken, family);
    return {
      accessToken,
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
    const changePassword = route === PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword;
    if (route === null || (route.auth !== 'bff' && !changePassword)) {
      return Response.json({ code: ErrorCode.NOT_FOUND, message: 'no' }, { status: 404 });
    }
    this.calls.push({ route, path, headers, body });
    if (this.outage !== null) return new Response('upstream down', { status: this.outage });
    try {
      // `bff` routes need web's key; the password change needs the photographer's own token.
      if (!changePassword && headers[BFF_KEY_HEADER] !== BFF_KEY) {
        throw new Fail(ErrorCode.UNAUTHENTICATED);
      }
      const result = changePassword
        ? this.changePassword(headers.authorization, body)
        : this.handle(route, path, body);
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
      case AUTH_ROUTES.photographerSignIn: {
        const account = this.accounts.get(normalizeAccountEmail(body?.email ?? ''));
        if (account !== undefined && account.failures >= this.lockoutThreshold) {
          throw new Fail(ErrorCode.RATE_LIMITED, {
            retryAfterSeconds: this.lockoutSeconds,
            captcha: null,
          });
        }
        if (account === undefined || account.password !== body?.password) {
          if (account !== undefined) account.failures++;
          throw new Fail(ErrorCode.INVALID_CREDENTIALS);
        }
        if (account.disabled) throw new Fail(ErrorCode.ACCOUNT_DISABLED);
        account.failures = 0;
        const tokens = this.signIn(
          account.subject,
          { email: account.email, name: account.name },
          'users',
          account.mustChange,
        );
        return { step: account.mustChange ? 'change_password' : 'signed_in', ...tokens };
      }
      default:
        throw new Fail(ErrorCode.NOT_FOUND);
    }
  }

  /** POST /auth/photographer/password with `Authorization: Bearer <access token>`. */
  private changePassword(authorization: string | undefined, rawBody: unknown): AuthTokenResponse {
    const family = this.accessTokens.get(authorization?.replace(/^Bearer /, '') ?? '');
    if (family === undefined || family.revoked || family.expiresAt <= this.now) {
      throw new Fail(ErrorCode.UNAUTHENTICATED);
    }
    const account = [...this.accounts.values()].find((a) => a.subject === family.subject);
    if (account === undefined) throw new Fail(ErrorCode.FORBIDDEN);
    if (account.disabled) throw new Fail(ErrorCode.ACCOUNT_DISABLED);
    const parsed = PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword.body.safeParse(rawBody);
    if (!parsed.success) throw new Fail(ErrorCode.VALIDATION_FAILED);
    const { currentPassword, newPassword } = parsed.data;
    if (account.failures >= this.lockoutThreshold) {
      throw new Fail(ErrorCode.RATE_LIMITED, {
        retryAfterSeconds: this.lockoutSeconds,
        captcha: null,
      });
    }
    if (currentPassword !== account.password) {
      account.failures++;
      throw new Fail(ErrorCode.PASSWORD_INCORRECT);
    }
    const reason =
      passwordPolicyViolation(newPassword, {
        minLength: this.passwordMinLength,
        email: account.email,
      }) ?? (newPassword === currentPassword ? 'same_as_current' : null);
    if (reason !== null) {
      throw new Fail(ErrorCode.PASSWORD_TOO_WEAK, { reason, minLength: this.passwordMinLength });
    }
    account.password = newPassword;
    account.mustChange = false;
    account.failures = 0;
    // Every session of the account ends, this one too.
    for (const f of this.families) if (f.subject === account.subject) f.revoked = true;
    return this.signIn(account.subject, { email: account.email, name: account.name });
  }
}
