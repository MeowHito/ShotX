import { createHash } from 'node:crypto';
import {
  AUTH_ROUTES,
  type AuthClientConfig,
  type AuthProvidersResponse,
  type AuthTokenResponse,
  ErrorCode,
  opaqueTokenSchema,
  PACKAGE_ROUTES,
  PHOTOGRAPHER_ACCOUNT_ROUTES,
} from '@shotx/shared';
import { createApiClient } from '../api/client';
import { ApiError, ContractError } from '../api/errors';
import { type ServerCallContext, serverCallHeaders } from '../bff/client-ip';
import { type AuthProvider, AuthProviderError, type AuthTokens } from './provider';

/**
 * AUTH_PROVIDER=shotx or local: the API issues the tokens (ADR 0008 section 4). Web calls the
 * `bff` routes of AUTH_ROUTES server-side with the BFF key and the end user's address; the API
 * runs LINE and Google (state, nonce and PKCE live there), and web binds the returned `state` to
 * the browser in the pending-login cookie (login-CSRF protection). Refresh tokens are opaque and
 * rotated on every use; the web app is the `users` pool.
 */

/**
 * How much earlier than the API's reuse grace web stops reusing a rotation. The window is
 * measured from before the refresh request is sent, so it already starts no later than the API's
 * (which counts from the rotation itself); the margin keeps it strictly inside.
 */
const REFRESH_REUSE_MARGIN_MS = 1000;

/**
 * How long web reuses a rotated refresh result for the same old refresh token, from the API's
 * AUTH_REFRESH_REUSE_GRACE_SECONDS: the grace minus REFRESH_REUSE_MARGIN_MS, and 0 (no reuse
 * after the call settles) when that leaves nothing. The browser fires several BFF calls at once
 * when the access token is about to expire, each with the same refresh cookie; without this they
 * would each present the rotated token. Never longer than the API's grace, so web never hands out
 * a successor the API itself would have refused as REFRESH_TOKEN_REUSED.
 */
export function refreshReuseWindowMs(graceSeconds: number): number {
  return Math.max(0, graceSeconds * 1000 - REFRESH_REUSE_MARGIN_MS);
}

/**
 * Single-flight refresh per refresh token: concurrent callers share one API call, and callers
 * within `reuseMs` of when that call was sent get its result. Per web process.
 */
export class RefreshCache {
  private readonly entries = new Map<
    string,
    { promise: Promise<{ tokens: AuthTokens; at: number }>; expiresAt: number }
  >();

  constructor(
    readonly reuseMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Number of entries (tests). */
  get size(): number {
    return this.entries.size;
  }

  run(refreshToken: string, rotate: () => Promise<AuthTokens>): Promise<AuthTokens> {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    // Keyed by a hash so the map never holds the old token itself.
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
          // Counted from before the call, so the window ends before the API's grace does.
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
function age(tokens: AuthTokens, elapsedMs: number): AuthTokens {
  const elapsed = Math.floor(Math.max(0, elapsedMs) / 1000);
  if (elapsed === 0) return tokens;
  return {
    ...tokens,
    expiresIn: Math.max(1, tokens.expiresIn - elapsed),
    ...(tokens.refreshExpiresIn !== undefined
      ? { refreshExpiresIn: Math.max(1, tokens.refreshExpiresIn - elapsed) }
      : {}),
  };
}

let sharedRefreshCache: RefreshCache | undefined;

/** The process-wide cache for a reuse window (the window comes from config, fixed per process). */
function processRefreshCache(reuseMs: number): RefreshCache {
  if (sharedRefreshCache?.reuseMs !== reuseMs) sharedRefreshCache = new RefreshCache(reuseMs);
  return sharedRefreshCache;
}

export interface ShotxAuthOptions {
  /** API origin (API_INTERNAL_URL); routes are under `/api` on it. */
  apiInternalUrl: string;
  /** AUTH_CLIENT_TIMEOUT_MS and AUTH_REFRESH_REUSE_GRACE_SECONDS (loadAuthClientConfig). */
  client: AuthClientConfig;
  /** The BFF key (required by every `bff` route) and the end user's address. */
  context: ServerCallContext & { bffKey: string };
  fetch?: typeof fetch;
}

function authApi(options: ShotxAuthOptions, accessToken?: string) {
  const api = createApiClient({
    baseUrl: `${options.apiInternalUrl.replace(/\/+$/, '')}/api`,
    fetch: options.fetch,
    headers: {
      ...serverCallHeaders(options.context),
      ...(accessToken !== undefined ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  });
  return { api, timeoutMs: options.client.callTimeoutMs };
}

/**
 * Runs an auth API call with the client timeout (the API may be waiting on LINE or Google),
 * turning its failures into AuthProviderError (never with a token).
 */
async function guarded<T>(
  timeoutMs: number,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  try {
    return await call(AbortSignal.timeout(timeoutMs));
  } catch (error) {
    if (error instanceof ApiError) {
      throw new AuthProviderError(
        `API answered ${error.code}`,
        error.status,
        error.code,
        error.details,
      );
    }
    if (error instanceof ContractError) {
      throw new AuthProviderError('Unexpected API response', error.status);
    }
    throw new AuthProviderError('API unreachable');
  }
}

function toTokens(response: AuthTokenResponse): AuthTokens {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresIn: response.expiresIn,
    refreshExpiresIn: response.refreshExpiresIn,
    user: { email: response.user.email, name: response.user.name },
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function createShotxAuthProvider(
  options: ShotxAuthOptions & {
    /** AUTH_PROVIDER=local: offer POST /auth/dev/login. */
    devLogin: boolean;
    refreshCache?: RefreshCache;
  },
): AuthProvider {
  const { api, timeoutMs } = authApi(options);
  const refreshCache =
    options.refreshCache ??
    processRefreshCache(refreshReuseWindowMs(options.client.refreshReuseGraceSeconds));

  const provider: AuthProvider = {
    async startLogin({ identityProvider, redirectUri }) {
      const start = await guarded(timeoutMs, (signal) =>
        api.call(AUTH_ROUTES.oidcStart, {
          params: { provider: identityProvider },
          body: { redirectUri },
          signal,
        }),
      );
      if (!isHttpUrl(start.authorizationUrl)) {
        throw new AuthProviderError('Unexpected authorization URL', 200);
      }
      return { authorizationUrl: start.authorizationUrl, state: start.state };
    },

    async completeLogin({ code, state }) {
      if (!opaqueTokenSchema.safeParse(state).success) {
        throw new AuthProviderError('Malformed state', 400, ErrorCode.LOGIN_STATE_INVALID);
      }
      return toTokens(
        await guarded(timeoutMs, (signal) =>
          api.call(AUTH_ROUTES.oidcCallback, { body: { state, code }, signal }),
        ),
      );
    },

    refresh(refreshToken) {
      // Anything else (an old Cognito or web-minted token) is cleared without asking the API.
      if (!opaqueTokenSchema.safeParse(refreshToken).success) {
        return Promise.reject(
          new AuthProviderError('Malformed refresh token', 400, ErrorCode.REFRESH_TOKEN_INVALID),
        );
      }
      return refreshCache.run(refreshToken, async () =>
        toTokens(
          await guarded(timeoutMs, (signal) =>
            api.call(AUTH_ROUTES.refresh, { body: { refreshToken, pool: 'users' }, signal }),
          ),
        ),
      );
    },

    async revoke(refreshToken) {
      if (!opaqueTokenSchema.safeParse(refreshToken).success) return;
      try {
        await guarded(timeoutMs, (signal) =>
          api.call(AUTH_ROUTES.logout, { body: { refreshToken }, signal }),
        );
      } catch {
        // Best effort: the cookies are cleared either way.
      }
    },

    // The API keeps no browser session at LINE or Google to end.
    logoutUrl: (returnTo) => returnTo,

    async actAs(code) {
      return toTokens(
        await guarded(timeoutMs, (signal) =>
          api.call(AUTH_ROUTES.actAs, { body: { code }, signal }),
        ),
      );
    },

    async passwordSignIn({ email, password }) {
      const response = await guarded(timeoutMs, (signal) =>
        api.call(AUTH_ROUTES.photographerSignIn, { body: { email, password }, signal }),
      );
      return { step: response.step, tokens: toTokens(response) };
    },

    async requestPasswordReset(email) {
      await guarded(timeoutMs, (signal) =>
        api.call(AUTH_ROUTES.photographerPasswordResetRequest, { body: { email }, signal }),
      );
    },

    async confirmPasswordReset({ token, newPassword }) {
      return toTokens(
        await guarded(timeoutMs, (signal) =>
          api.call(AUTH_ROUTES.photographerPasswordResetConfirm, {
            body: { token, newPassword },
            signal,
          }),
        ),
      );
    },

    async requestFreeSignup({ name, email, captchaToken }) {
      const body = { name, email, ...(captchaToken !== undefined ? { captchaToken } : {}) };
      await guarded(timeoutMs, (signal) => api.call(PACKAGE_ROUTES.signupFree, { body, signal }));
    },

    async confirmFreeSignup({ token, password }) {
      return toTokens(
        await guarded(timeoutMs, (signal) =>
          api.call(PACKAGE_ROUTES.signupFreeConfirm, { body: { token, password }, signal }),
        ),
      );
    },

    async changePassword({ accessToken, currentPassword, newPassword }) {
      // Not a `bff` route: it needs the photographer's own token (serverOnly: never via /bff).
      const own = authApi(options, accessToken).api;
      return toTokens(
        await guarded(timeoutMs, (signal) =>
          own.call(PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword, {
            body: { currentPassword, newPassword },
            signal,
          }),
        ),
      );
    },
  };

  if (options.devLogin) {
    provider.devLogin = async (identity) =>
      toTokens(
        await guarded(timeoutMs, (signal) =>
          api.call(AUTH_ROUTES.devLogin, { body: identity, signal }),
        ),
      );
  }
  return provider;
}

/** GET /auth/providers: what the sign-in page may offer, or null when the API failed. */
export async function fetchLoginProviders(
  options: ShotxAuthOptions,
): Promise<AuthProvidersResponse | null> {
  const { api, timeoutMs } = authApi(options);
  try {
    return await guarded(timeoutMs, (signal) => api.call(AUTH_ROUTES.providers, { signal }));
  } catch {
    return null;
  }
}
