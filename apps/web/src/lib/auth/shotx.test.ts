// @vitest-environment node
import {
  AUTH_ROUTES,
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  ErrorCode,
  opaqueTokenSchema,
} from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { BFF_KEY, FakeAuthApi } from '../../../test/fake-auth-api';
import { type AuthDeps, handleCallback, handleLogin, resolveSession } from './handlers';
import { AuthProviderError, type AuthTokens } from './provider';
import { cookieNames, decodeSession, encodeJsonCookie } from './session';
import {
  createShotxAuthProvider,
  fetchLoginProviders,
  RefreshCache,
  refreshReuseWindowMs,
} from './shotx';

const BASE = 'https://photos.example.com';
const API = 'http://api:4000';
const names = cookieNames(true);
/** loadAuthClientConfig defaults: the API's 10 s reuse grace, 15 s per call. */
const CLIENT = { refreshReuseGraceSeconds: 10, callTimeoutMs: 15_000 };

function setup(
  options: {
    devLogin?: boolean;
    clientIp?: string | null;
    refreshCache?: RefreshCache;
    client?: typeof CLIENT;
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  const api = new FakeAuthApi();
  api.devLogin = options.devLogin ?? false;
  const fetch = vi.fn<typeof globalThis.fetch>(
    options.fetch ??
      ((input, init) => api.fetch((input as string).replace(API, 'http://api'), init)),
  );
  const client = options.client ?? CLIENT;
  const provider = createShotxAuthProvider({
    apiInternalUrl: `${API}/`,
    client,
    context: {
      bffKey: BFF_KEY,
      clientIp: options.clientIp === undefined ? '203.0.113.7' : options.clientIp,
    },
    fetch,
    devLogin: options.devLogin ?? false,
    refreshCache:
      options.refreshCache ??
      new RefreshCache(refreshReuseWindowMs(client.refreshReuseGraceSeconds), () => api.now),
  });
  const deps: AuthDeps = {
    provider,
    publicBaseUrl: BASE,
    secureCookies: true,
    now: () => api.now,
  };
  return { api, fetch, provider, deps };
}

async function caught(promise: Promise<unknown>): Promise<AuthProviderError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthProviderError);
  return error as AuthProviderError;
}

describe('API-issued tokens (AUTH_PROVIDER=shotx)', () => {
  it('starts LINE sign-in at the API with the BFF key and the client IP', async () => {
    const { api, fetch, provider } = setup();
    const start = await provider.startLogin({
      identityProvider: 'line',
      redirectUri: `${BASE}/auth/callback`,
    });
    expect(start.authorizationUrl).toMatch(/^https:\/\/access\.line\.me\/oauth2\/v2\.1\/authorize/);
    expect(opaqueTokenSchema.safeParse(start.state).success).toBe(true);
    expect(start.codeVerifier).toBeUndefined();
    expect(fetch.mock.calls[0]?.[0]).toBe(`${API}/api/auth/oidc/line/start`);
    expect(api.calls[0]).toMatchObject({
      route: AUTH_ROUTES.oidcStart,
      body: { redirectUri: `${BASE}/auth/callback` },
      headers: { [BFF_KEY_HEADER]: BFF_KEY, [BFF_CLIENT_IP_HEADER]: '203.0.113.7' },
    });
  });

  it('sends no client IP header when web doesn’t know the address', async () => {
    const { api, provider } = setup({ clientIp: null });
    await provider.startLogin({ identityProvider: 'google', redirectUri: `${BASE}/auth/callback` });
    expect(api.calls[0]?.headers[BFF_KEY_HEADER]).toBe(BFF_KEY);
    expect(api.clientIps()).toEqual([undefined]);
  });

  it('reports an unconfigured provider by its code', async () => {
    const { api, provider } = setup();
    api.oidc = ['google'];
    const error = await caught(
      provider.startLogin({ identityProvider: 'line', redirectUri: `${BASE}/auth/callback` }),
    );
    expect(error.code).toBe(ErrorCode.AUTH_PROVIDER_UNAVAILABLE);
    expect(error.transient).toBe(false);
  });

  it('runs the whole sign-in through the handlers, binding the state to the browser', async () => {
    const { api, deps } = setup();
    const login = await handleLogin(
      new Request(`${BASE}/auth/login?provider=line&next=/studio/shares`),
      deps,
    );
    const authorize = new URL(login.headers.get('location') ?? '');
    const state = authorize.searchParams.get('state') ?? '';
    const pending = login.headers.getSetCookie()[0]?.split(';')[0] ?? '';

    // Another browser's (or an attacker's) callback with the same state has no cookie.
    const other = await handleCallback(
      new Request(`${BASE}/auth/callback?code=${api.goodCode}&state=${state}`),
      deps,
    );
    expect(other.headers.get('location')).toBe(`${BASE}/login?error=expired`);

    const callback = await handleCallback(
      new Request(`${BASE}/auth/callback?code=${api.goodCode}&state=${state}`, {
        headers: { cookie: pending },
      }),
      deps,
    );
    expect(callback.headers.get('location')).toBe(`${BASE}/studio/shares`);
    const sent = api.calls.find((c) => c.route === AUTH_ROUTES.oidcCallback);
    expect(sent?.body).toEqual({ state, code: api.goodCode });
    const cookies = callback.headers.getSetCookie();
    const refresh = cookies.find((c) => c.startsWith(`${names.refresh}=`)) ?? '';
    expect(refresh).toContain(`Max-Age=${api.refreshTtlSeconds}`);
    const session = cookies.find((c) => c.startsWith(`${names.session}=`)) ?? '';
    const decoded = decodeSession(decodeURIComponent(session.split(';')[0]?.split('=')[1] ?? ''));
    expect(decoded?.user).toEqual({ sub: 'line:U123', email: null, name: 'ช่างภาพ LINE' });

    // The state is one-time at the API: replaying the callback fails.
    const replay = await handleCallback(
      new Request(`${BASE}/auth/callback?code=${api.goodCode}&state=${state}`, {
        headers: { cookie: pending },
      }),
      deps,
    );
    expect(replay.headers.get('location')).toBe(
      `${BASE}/login?error=LOGIN_STATE_INVALID&next=%2Fstudio%2Fshares`,
    );
  });

  it('turns a refused code into IDENTITY_PROVIDER_ERROR on the login page', async () => {
    const { deps } = setup();
    const login = await handleLogin(new Request(`${BASE}/auth/login?provider=google`), deps);
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const callback = await handleCallback(
      new Request(`${BASE}/auth/callback?code=wrong&state=${state}`, {
        headers: { cookie: login.headers.getSetCookie()[0]?.split(';')[0] ?? '' },
      }),
      deps,
    );
    expect(callback.headers.get('location')).toBe(`${BASE}/login?error=IDENTITY_PROVIDER_ERROR`);
  });

  it('rotates refresh tokens in the users pool; the family expiry never extends', async () => {
    const { api, provider } = setup();
    const first = api.signIn('google:G1', { email: 'g@example.com', name: 'G' });
    api.now += 3_600_000;
    const tokens = await provider.refresh(first.refreshToken);
    expect(api.calls.at(-1)?.body).toEqual({ refreshToken: first.refreshToken, pool: 'users' });
    expect(tokens.refreshToken).not.toBe(first.refreshToken);
    expect(tokens.refreshExpiresIn).toBe(first.refreshExpiresIn - 3600);
    expect(tokens.user).toEqual({ email: 'g@example.com', name: 'G' });
  });

  it('keeps the reuse window strictly inside the API\u2019s grace, and off with grace 0', () => {
    expect(refreshReuseWindowMs(10)).toBe(9_000);
    expect(refreshReuseWindowMs(60)).toBe(59_000);
    expect(refreshReuseWindowMs(1)).toBe(0);
    expect(refreshReuseWindowMs(0)).toBe(0);
  });

  it('refreshes once for concurrent requests that carry the same refresh token', async () => {
    const { api, fetch, provider } = setup();
    const first = api.signIn('line:U1', { email: null, name: 'U' });
    const results = await Promise.all([
      provider.refresh(first.refreshToken),
      provider.refresh(first.refreshToken),
      provider.refresh(first.refreshToken),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.refreshToken)).size).toBe(1);

    // A request still carrying the old cookie a few seconds later gets the same rotation,
    // with lifetimes shortened by the time that passed.
    api.now += 5_000;
    const late = await provider.refresh(first.refreshToken);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(late.refreshToken).toBe(results[0]?.refreshToken);
    expect(late.expiresIn).toBe((results[0]?.expiresIn ?? 0) - 5);

    // At 9 s (grace 10 s minus the margin) web stops reusing: the old token goes to the API
    // again, which decides (this fake has no grace, so it sees a reuse).
    api.now += 4_000;
    const reused = await caught(provider.refresh(first.refreshToken));
    expect(reused.code).toBe(ErrorCode.REFRESH_TOKEN_REUSED);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('counts the window from when the refresh was sent, not when it answered', async () => {
    let clock = 0;
    const cache = new RefreshCache(9_000, () => clock);
    const token = 'r'.repeat(43);
    let finish: (tokens: AuthTokens) => void = () => undefined;
    const pending = cache.run(
      token,
      () => new Promise<AuthTokens>((resolve) => (finish = resolve)),
    );
    clock = 8_000; // a slow API: 8 s to answer
    finish({ accessToken: 'a', expiresIn: 900 });
    await pending;
    const second = vi.fn(() => Promise.resolve<AuthTokens>({ accessToken: 'b', expiresIn: 900 }));
    clock = 8_500;
    await expect(cache.run(token, second)).resolves.toMatchObject({ accessToken: 'a' });
    expect(second).not.toHaveBeenCalled();
    // 9 s after it was sent (only 1 s after it answered) the window is over.
    clock = 9_000;
    await expect(cache.run(token, second)).resolves.toMatchObject({ accessToken: 'b' });
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('with grace 0 shares only an in-flight refresh, never a settled one', async () => {
    const client = { ...CLIENT, refreshReuseGraceSeconds: 0 };
    const { api, fetch, provider } = setup({ client });
    const first = api.signIn('line:U1', { email: null, name: 'U' });
    const both = await Promise.all([
      provider.refresh(first.refreshToken),
      provider.refresh(first.refreshToken),
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(both[0]?.refreshToken).toBe(both[1]?.refreshToken);
    const again = await caught(provider.refresh(first.refreshToken));
    expect(again.code).toBe(ErrorCode.REFRESH_TOKEN_REUSED);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after AUTH_CLIENT_TIMEOUT_MS and reports it as transient', async () => {
    const hang: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const { provider } = setup({ client: { ...CLIENT, callTimeoutMs: 20 }, fetch: hang });
    const error = await caught(
      provider.startLogin({ identityProvider: 'line', redirectUri: `${BASE}/auth/callback` }),
    );
    expect(error.transient).toBe(true);
  });

  it('never caches a failed refresh', async () => {
    const { api, fetch, provider } = setup();
    const first = api.signIn('line:U1', { email: null, name: 'U' });
    api.outage = 503;
    const down = await caught(provider.refresh(first.refreshToken));
    expect(down.transient).toBe(true);
    api.outage = null;
    await expect(provider.refresh(first.refreshToken)).resolves.toMatchObject({
      expiresIn: 900,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('clears a malformed (pre-migration) refresh token without calling the API', async () => {
    const { fetch, deps } = setup();
    const cookie = `${names.session}=${encodeJsonCookie({
      accessToken: 'old',
      expiresAt: 0,
      user: { sub: 'x', email: null, name: null },
    })}; ${names.refresh}=body.mac-of-a-web-minted-token`;
    const result = await resolveSession(cookie, deps);
    expect(result.session).toBeNull();
    expect(result.setCookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps the session cookies when the API is unreachable', async () => {
    const { api, deps } = setup();
    const first = api.signIn('line:U1', { email: null, name: 'U' });
    api.outage = 502;
    const result = await resolveSession(`${names.refresh}=${first.refreshToken}`, deps);
    expect(result).toEqual({ session: null, setCookies: [], unavailable: true });
  });

  it('revokes the family on logout, best effort', async () => {
    const { api, provider } = setup();
    const first = api.signIn('line:U1', { email: null, name: 'U' });
    await provider.revoke(first.refreshToken);
    expect(api.calls.at(-1)).toMatchObject({
      route: AUTH_ROUTES.logout,
      body: { refreshToken: first.refreshToken },
    });
    const refused = await caught(provider.refresh(first.refreshToken));
    expect(refused.code).toBe(ErrorCode.REFRESH_TOKEN_INVALID);
    api.outage = 500;
    await expect(provider.revoke(first.refreshToken)).resolves.toBeUndefined();
    await expect(provider.revoke('not-a-token')).resolves.toBeUndefined();
    expect(provider.logoutUrl(`${BASE}/`)).toBe(`${BASE}/`);
  });

  it('offers the development sign-in only with AUTH_PROVIDER=local', async () => {
    expect(setup().provider.devLogin).toBeUndefined();
    const { api, provider } = setup({ devLogin: true });
    const tokens = await provider.devLogin?.({ email: 'dev@shotx.test', name: 'Dev' });
    expect(tokens?.user).toEqual({ email: 'dev@shotx.test', name: 'Dev' });
    expect(api.calls[0]).toMatchObject({
      route: AUTH_ROUTES.devLogin,
      body: { email: 'dev@shotx.test', name: 'Dev' },
      headers: { [BFF_KEY_HEADER]: BFF_KEY },
    });
  });

  it('reads GET /auth/providers for the login page, null when the API fails', async () => {
    const api = new FakeAuthApi();
    api.oidc = ['google'];
    api.devLogin = true;
    const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
      api.fetch((input as string).replace(API, 'http://api'), init);
    const context = { bffKey: BFF_KEY, clientIp: '2001:db8::1' };
    await expect(
      fetchLoginProviders({ apiInternalUrl: API, client: CLIENT, context, fetch }),
    ).resolves.toEqual({
      oidc: ['google'],
      devLogin: true,
      adminLogin: false,
    });
    expect(api.clientIps()).toEqual(['2001:db8::1']);
    await expect(
      fetchLoginProviders({
        apiInternalUrl: API,
        client: CLIENT,
        context: { ...context, bffKey: 'wrong' },
        fetch,
      }),
    ).resolves.toBeNull();
  });
});
