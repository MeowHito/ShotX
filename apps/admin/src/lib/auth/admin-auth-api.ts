import { createHash } from 'node:crypto';
import {
  type AdminChangePasswordBody,
  type AdminChangePasswordResponse,
  type AdminLoginBody,
  type AdminLoginResponse,
  type AdminMfaBody,
  AUTH_ROUTES,
  type AuthClientConfig,
  type AuthTokenResponse,
} from '@shotx/shared';
import { createApiClient } from '../api/client';
import { type ServerCallContext, serverCallHeaders } from '../bff/client-ip';

/**
 * The API's admin sign-in routes (AUTH_ROUTES, RouteAuth `bff`), called server-side only with the
 * BFF key and the end user's address. Tokens and challenge ids returned here go into httpOnly
 * cookies (src/lib/auth/handlers); none of them is ever sent to the browser or logged.
 *
 * Every method rejects with the API client's errors: ApiError (an answer with a code),
 * ContractError (an unexpected answer) or NetworkError / a timeout (no answer).
 */
export interface AdminAuthApi {
  login: (body: AdminLoginBody) => Promise<AdminLoginResponse>;
  changePassword: (body: AdminChangePasswordBody) => Promise<AdminChangePasswordResponse>;
  mfa: (body: AdminMfaBody) => Promise<AuthTokenResponse>;
  /** Rotates an admins-pool refresh token. */
  refresh: (refreshToken: string) => Promise<AuthTokenResponse>;
  /** Revokes the refresh token's family. */
  logout: (refreshToken: string) => Promise<void>;
}

export interface AdminAuthApiOptions {
  /** API origin (API_INTERNAL_URL); routes are under `/api` on it. */
  apiInternalUrl: string;
  client: AuthClientConfig;
  context: ServerCallContext;
  fetch?: typeof fetch;
  refreshCache?: RefreshCache;
}

export function createAdminAuthApi(options: AdminAuthApiOptions): AdminAuthApi {
  const api = createApiClient({
    baseUrl: `${options.apiInternalUrl.replace(/\/+$/, '')}/api`,
    fetch: options.fetch,
    headers: serverCallHeaders(options.context),
  });
  const signal = () => AbortSignal.timeout(options.client.callTimeoutMs);
  const refreshCache =
    options.refreshCache ??
    processRefreshCache(refreshReuseWindowMs(options.client.refreshReuseGraceSeconds));
  return {
    login: (body) => api.call(AUTH_ROUTES.adminLogin, { body, signal: signal() }),
    changePassword: (body) => api.call(AUTH_ROUTES.adminChangePassword, { body, signal: signal() }),
    mfa: (body) => api.call(AUTH_ROUTES.adminMfa, { body, signal: signal() }),
    refresh: (refreshToken) =>
      refreshCache.run(refreshToken, () =>
        api.call(AUTH_ROUTES.refresh, {
          body: { refreshToken, pool: 'admins' },
          signal: signal(),
        }),
      ),
    logout: (refreshToken) =>
      api.call(AUTH_ROUTES.logout, { body: { refreshToken }, signal: signal() }),
  };
}

/** How much earlier than the API's reuse grace the admin app stops reusing a rotation. */
const REFRESH_REUSE_MARGIN_MS = 1000;

/**
 * How long a rotated refresh result is reused for the same old refresh token: the API's
 * AUTH_REFRESH_REUSE_GRACE_SECONDS minus a margin, 0 when that leaves nothing. Several BFF calls
 * that arrive together near the access token's expiry then share one rotation instead of
 * presenting the rotated token (REFRESH_TOKEN_REUSED).
 */
export function refreshReuseWindowMs(graceSeconds: number): number {
  return Math.max(0, graceSeconds * 1000 - REFRESH_REUSE_MARGIN_MS);
}

/**
 * Single-flight refresh per refresh token: concurrent callers share one API call, and callers
 * within `reuseMs` of when that call was sent get its result. Per process. Keyed by a SHA-256 of
 * the token, so the map never holds the token itself.
 */
export class RefreshCache {
  private readonly entries = new Map<
    string,
    { promise: Promise<{ tokens: AuthTokenResponse; at: number }>; expiresAt: number }
  >();

  constructor(
    readonly reuseMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get size(): number {
    return this.entries.size;
  }

  run(refreshToken: string, rotate: () => Promise<AuthTokenResponse>): Promise<AuthTokenResponse> {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    const key = createHash('sha256').update(refreshToken).digest('hex');
    let entry = this.entries.get(key);
    if (entry === undefined) {
      const startedAt = now;
      const created = {
        promise: rotate().then((tokens) => ({ tokens, at: this.now() })),
        expiresAt: Number.POSITIVE_INFINITY,
      };
      created.promise.then(
        () => {
          created.expiresAt = startedAt + this.reuseMs;
        },
        () => {
          // Failures are shared with concurrent callers only, never cached.
          this.entries.delete(key);
        },
      );
      this.entries.set(key, created);
      entry = created;
    }
    return entry.promise.then(({ tokens, at }) => age(tokens, this.now() - at));
  }
}

/** Tokens obtained `elapsedMs` ago, with their lifetimes shortened accordingly. */
function age(tokens: AuthTokenResponse, elapsedMs: number): AuthTokenResponse {
  const elapsed = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (elapsed === 0) return tokens;
  return {
    ...tokens,
    expiresIn: Math.max(1, tokens.expiresIn - elapsed),
    refreshExpiresIn: Math.max(1, tokens.refreshExpiresIn - elapsed),
  };
}

let sharedRefreshCache: RefreshCache | undefined;

function processRefreshCache(reuseMs: number): RefreshCache {
  if (sharedRefreshCache?.reuseMs !== reuseMs) sharedRefreshCache = new RefreshCache(reuseMs);
  return sharedRefreshCache;
}
