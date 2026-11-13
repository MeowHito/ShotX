// @vitest-environment node
import { ErrorCode } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { createCognitoAuthProvider } from './cognito';
import {
  type AuthDeps,
  handleActAs,
  handleCallback,
  handleDevLogin,
  handleLogin,
  handleLogout,
  resolveSession,
} from './handlers';
import { codeChallenge, createPkcePair } from './pkce';
import { type AuthProvider, AuthProviderError, type AuthTokens } from './provider';
import {
  cookieNames,
  decodePendingLogin,
  decodeSession,
  encodeJsonCookie,
  safeNextPath,
  type Session,
} from './session';

const BASE = 'https://photos.example.com';

function jwt(claims: Record<string, unknown>): string {
  return `h.${encodeJsonCookie(claims)}.s`;
}

const STATE = 's'.repeat(43);

function fakeProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  const tokens: AuthTokens = {
    accessToken: jwt({ sub: 'line:U1' }),
    refreshToken: 'refresh-1',
    expiresIn: 900,
    refreshExpiresIn: 86_400,
    user: { email: 'a@example.com', name: 'ช่างภาพ' },
  };
  return {
    startLogin: vi.fn(({ identityProvider }) =>
      Promise.resolve({
        authorizationUrl: `https://idp.example.com/authorize?state=${STATE}&idp=${identityProvider}`,
        state: STATE,
      }),
    ),
    completeLogin: vi.fn(() => Promise.resolve(tokens)),
    refresh: vi.fn(() =>
      Promise.resolve({ ...tokens, refreshToken: 'refresh-2', refreshExpiresIn: 80_000 }),
    ),
    revoke: vi.fn(() => Promise.resolve()),
    logoutUrl: (returnTo) => returnTo,
    ...overrides,
  };
}

function deps(provider = fakeProvider(), now = 1_000_000): AuthDeps {
  return { provider, publicBaseUrl: BASE, secureCookies: true, now: () => now };
}

/** Set-Cookie headers of a response as name -> value. */
function setCookies(response: Response): Map<string, string> {
  return new Map(
    response.headers.getSetCookie().map((c) => {
      const [pair = ''] = c.split(';');
      const eq = pair.indexOf('=');
      return [pair.slice(0, eq), decodeURIComponent(pair.slice(eq + 1))];
    }),
  );
}

/** The raw Set-Cookie header of one cookie. */
function rawCookie(response: Response, name: string): string {
  return response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? '';
}

const names = cookieNames(true);

const pendingCookie = (value: object) => `${names.login}=${encodeJsonCookie(value)}`;

describe('PKCE', () => {
  it('matches the RFC 7636 S256 test vector', async () => {
    await expect(codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).resolves.toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('creates a 43-character verifier with its challenge', async () => {
    const pair = await createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(await codeChallenge(pair.verifier));
  });
});

describe('Cognito provider (AUTH_PROVIDER=cognito)', () => {
  const cognito = {
    domain: 'https://shotx.auth.ap-southeast-1.amazoncognito.com',
    clientId: 'abc123',
  };

  it('starts with PKCE made in web, Thai UI and the Cognito identity provider name', async () => {
    const start = await createCognitoAuthProvider(cognito).startLogin({
      identityProvider: 'line',
      redirectUri: `${BASE}/auth/callback`,
    });
    const url = new URL(start.authorizationUrl);
    expect(url.origin + url.pathname).toBe(`${cognito.domain}/oauth2/authorize`);
    const params = Object.fromEntries(url.searchParams);
    expect(params).toEqual({
      response_type: 'code',
      client_id: 'abc123',
      redirect_uri: `${BASE}/auth/callback`,
      scope: 'openid email profile',
      state: start.state,
      code_challenge: await codeChallenge(start.codeVerifier ?? ''),
      code_challenge_method: 'S256',
      lang: 'th',
      identity_provider: 'LINE',
    });
    expect(start.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('exchanges the code with the verifier and without a client secret', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          access_token: 'at',
          id_token: 'it',
          refresh_token: 'rt',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      ),
    );
    const tokens = await createCognitoAuthProvider(cognito, fetch).completeLogin({
      code: 'c',
      state: 'st',
      codeVerifier: 'v',
      redirectUri: `${BASE}/auth/callback`,
    });
    expect(tokens).toEqual({
      accessToken: 'at',
      idToken: 'it',
      refreshToken: 'rt',
      expiresIn: 3600,
    });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${cognito.domain}/oauth2/token`);
    expect(Object.fromEntries(new URLSearchParams(init?.body as string))).toEqual({
      client_id: 'abc123',
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: `${BASE}/auth/callback`,
    });
  });

  it('refuses a callback without a verifier, and a failed token response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      createCognitoAuthProvider(cognito, fetch).completeLogin({
        code: 'c',
        state: 'st',
        redirectUri: `${BASE}/auth/callback`,
      }),
    ).rejects.toThrow('PKCE');
    expect(fetch).not.toHaveBeenCalled();
    const failing = createCognitoAuthProvider(cognito, () =>
      Promise.resolve(new Response('{}', { status: 400 })),
    );
    await expect(failing.refresh('rt')).rejects.toThrow('400');
  });

  it('keeps the Cognito flow end to end: the verifier travels in the pending-login cookie', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        Response.json({
          access_token: jwt({ sub: 'cognito-sub' }),
          id_token: jwt({ sub: 'cognito-sub', email: 'c@example.com', name: 'C' }),
          refresh_token: 'rt',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      ),
    );
    const d = { ...deps(createCognitoAuthProvider(cognito, fetch)), refreshTokenMaxAgeSeconds: 99 };
    const login = await handleLogin(new Request(`${BASE}/auth/login?provider=google`), d);
    const location = new URL(login.headers.get('location') ?? '');
    expect(location.searchParams.get('identity_provider')).toBe('Google');
    const pending = decodePendingLogin(setCookies(login).get(names.login));
    expect(pending?.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const callback = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=${location.searchParams.get('state')}`, {
        headers: { cookie: pendingCookie(pending ?? {}) },
      }),
      d,
    );
    expect(callback.headers.get('location')).toBe(`${BASE}/studio`);
    const body = new URLSearchParams(fetch.mock.calls[0]?.[1]?.body as string);
    expect(body.get('code_verifier')).toBe(pending?.verifier);
    expect(decodeSession(setCookies(callback).get(names.session))?.user).toEqual({
      sub: 'cognito-sub',
      email: 'c@example.com',
      name: 'C',
    });
    expect(rawCookie(callback, names.refresh)).toContain('Max-Age=99');
  });
});

describe('login and callback', () => {
  it('starts at the provider and binds its state to the browser in an httpOnly cookie', async () => {
    const provider = fakeProvider();
    const response = await handleLogin(
      new Request(`${BASE}/auth/login?provider=line&next=/studio/folders/x`),
      deps(provider),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      `https://idp.example.com/authorize?state=${STATE}&idp=line`,
    );
    expect(provider.startLogin).toHaveBeenCalledWith({
      identityProvider: 'line',
      redirectUri: `${BASE}/auth/callback`,
    });
    expect(rawCookie(response, names.login)).toMatch(
      /^__Host-shotx_login=.*; Path=\/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/,
    );
    // API-issued tokens: no PKCE verifier in web, only the state and where to go.
    expect(decodePendingLogin(setCookies(response).get(names.login))).toEqual({
      state: STATE,
      next: '/studio/folders/x',
    });
  });

  it('offers only LINE and Google (no email sign-in, ADR 0008)', async () => {
    const provider = fakeProvider();
    for (const param of ['email', '', 'cognito']) {
      const response = await handleLogin(
        new Request(`${BASE}/auth/login?provider=${param}&next=/s/abc`),
        deps(provider),
      );
      expect(response.headers.get('location')).toBe(`${BASE}/login?error=failed&next=%2Fs%2Fabc`);
    }
    expect(provider.startLogin).not.toHaveBeenCalled();
  });

  it('sends API errors to the login page by code, keeping the next path', async () => {
    const provider = fakeProvider({
      startLogin: () =>
        Promise.reject(new AuthProviderError('no', 404, ErrorCode.AUTH_PROVIDER_UNAVAILABLE)),
    });
    const response = await handleLogin(
      new Request(`${BASE}/auth/login?provider=google&next=/s/tok`),
      deps(provider),
    );
    expect(response.headers.get('location')).toBe(
      `${BASE}/login?error=AUTH_PROVIDER_UNAVAILABLE&next=%2Fs%2Ftok`,
    );
    expect(response.headers.getSetCookie()).toEqual([]);
    const unknown = fakeProvider({
      startLogin: () => Promise.reject(new AuthProviderError('x', 400, ErrorCode.NOT_FOUND)),
    });
    const failed = await handleLogin(
      new Request(`${BASE}/auth/login?provider=line`),
      deps(unknown),
    );
    expect(failed.headers.get('location')).toBe(`${BASE}/login?error=failed`);
  });

  it('completes the flow: checks the state, finishes at the API and sets the session cookies', async () => {
    const provider = fakeProvider();
    const login = await handleLogin(
      new Request(`${BASE}/auth/login?provider=google&next=/studio/trash`),
      deps(provider),
    );
    const pending = setCookies(login).get(names.login) ?? '';

    const callback = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=${STATE}`, {
        headers: { cookie: `${names.login}=${encodeURIComponent(pending)}` },
      }),
      deps(provider),
    );
    expect(callback.headers.get('location')).toBe(`${BASE}/studio/trash`);
    expect(provider.completeLogin).toHaveBeenCalledWith({
      code: 'abc',
      state: STATE,
      codeVerifier: undefined,
      redirectUri: `${BASE}/auth/callback`,
    });
    const cookies = setCookies(callback);
    expect(cookies.get(names.login)).toBe('');
    expect(cookies.get(names.refresh)).toBe('refresh-1');
    const session = decodeSession(cookies.get(names.session));
    expect(session?.user).toEqual({ sub: 'line:U1', email: 'a@example.com', name: 'ช่างภาพ' });
    expect(session?.expiresAt).toBe(1_000_000 + 900 * 1000);
    // The cookies end with the sign-in's refresh family (refreshExpiresIn).
    expect(rawCookie(callback, names.refresh)).toContain('Max-Age=86400');
    expect(rawCookie(callback, names.session)).toContain('Max-Age=86400');
  });

  it('rejects a state mismatch, a missing pending login and a cancelled login', async () => {
    const provider = fakeProvider();
    const pending = pendingCookie({ state: STATE, next: '/s/tok' });
    const mismatch = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=${'o'.repeat(43)}`, {
        headers: { cookie: pending },
      }),
      deps(provider),
    );
    expect(mismatch.headers.get('location')).toBe(`${BASE}/login?error=failed&next=%2Fs%2Ftok`);
    const missing = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=${STATE}`),
      deps(provider),
    );
    expect(missing.headers.get('location')).toBe(`${BASE}/login?error=expired`);
    const cancelled = await handleCallback(
      new Request(`${BASE}/auth/callback?error=access_denied&state=${STATE}`, {
        headers: { cookie: pending },
      }),
      deps(provider),
    );
    expect(cancelled.headers.get('location')).toBe(`${BASE}/login?error=cancelled&next=%2Fs%2Ftok`);
    // The API was never asked: a login-CSRF code from another browser can't sign this one in.
    expect(provider.completeLogin).not.toHaveBeenCalled();
    for (const response of [mismatch, missing, cancelled]) {
      expect(setCookies(response).get(names.login)).toBe('');
      expect(setCookies(response).has(names.session)).toBe(false);
    }
  });

  it('maps a used or expired API state to its code', async () => {
    const provider = fakeProvider({
      completeLogin: () =>
        Promise.reject(new AuthProviderError('x', 400, ErrorCode.LOGIN_STATE_INVALID)),
    });
    const response = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=${STATE}`, {
        headers: { cookie: pendingCookie({ state: STATE, next: '/studio' }) },
      }),
      deps(provider),
    );
    expect(response.headers.get('location')).toBe(`${BASE}/login?error=LOGIN_STATE_INVALID`);
  });

  it('never redirects off-site after login', () => {
    expect(safeNextPath('/studio/folders/1')).toBe('/studio/folders/1');
    expect(safeNextPath('https://evil.example')).toBe('/studio');
    expect(safeNextPath('//evil.example')).toBe('/studio');
    expect(safeNextPath('/\\evil.example')).toBe('/studio');
    expect(safeNextPath(null)).toBe('/studio');
  });
});

describe('development sign-in (AUTH_PROVIDER=local)', () => {
  const form = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    new Request(`${BASE}/auth/dev-login`, {
      method: 'POST',
      headers: { origin: BASE, ...headers },
      body: new URLSearchParams(fields),
    });

  const tokens: AuthTokens = {
    accessToken: jwt({ sub: 'local:x' }),
    refreshToken: 'r'.repeat(43),
    expiresIn: 900,
    refreshExpiresIn: 3600,
    user: { email: 'dev@shotx.test', name: 'Dev' },
  };

  it('is not there without the development provider', async () => {
    const response = await handleDevLogin(form({ email: 'a@b.co', name: 'A' }), deps());
    expect(response.status).toBe(404);
  });

  it('signs in with the posted identity and returns to next', async () => {
    const devLogin = vi.fn(() => Promise.resolve(tokens));
    const response = await handleDevLogin(
      form({ email: 'dev@shotx.test', name: ' Dev ', next: '/studio/shares' }),
      deps(fakeProvider({ devLogin })),
    );
    expect(devLogin).toHaveBeenCalledWith({ email: 'dev@shotx.test', name: 'Dev' });
    expect(response.headers.get('location')).toBe(`${BASE}/studio/shares`);
    expect(setCookies(response).get(names.refresh)).toBe('r'.repeat(43));
    expect(decodeSession(setCookies(response).get(names.session))?.user.email).toBe(
      'dev@shotx.test',
    );
    expect(rawCookie(response, names.refresh)).toContain('Max-Age=3600');
  });

  it('refuses another origin, a bad identity, and an off-site next', async () => {
    const devLogin = vi.fn(() => Promise.resolve(tokens));
    const provider = fakeProvider({ devLogin });
    const forged = await handleDevLogin(
      form({ email: 'a@b.co', name: 'A' }, { origin: 'https://evil.example' }),
      deps(provider),
    );
    expect(forged.status).toBe(403);
    const invalid = await handleDevLogin(form({ email: 'nope', name: 'A' }), deps(provider));
    expect(invalid.headers.get('location')).toBe(`${BASE}/login?error=invalid`);
    expect(devLogin).not.toHaveBeenCalled();
    const offsite = await handleDevLogin(
      form({ email: 'a@b.co', name: 'A', next: '//evil.example' }),
      deps(provider),
    );
    expect(offsite.headers.get('location')).toBe(`${BASE}/studio`);
  });
});

describe('sessions', () => {
  const session: Session = {
    accessToken: 'at',
    expiresAt: 1_000_000 + 10 * 60_000,
    user: { sub: 'line:U1', email: null, name: 'A' },
  };
  const cookie = (s: Session, refresh?: string) =>
    `${names.session}=${encodeJsonCookie(s)}${refresh ? `; ${names.refresh}=${refresh}` : ''}`;

  it('uses a valid session as is', async () => {
    await expect(resolveSession(cookie(session), deps())).resolves.toEqual({
      session,
      setCookies: [],
    });
  });

  it('refreshes a nearly expired session, stores the rotated token and the user the API reports', async () => {
    const provider = fakeProvider();
    const expired = { ...session, expiresAt: 1_000_000 + 30_000 };
    const result = await resolveSession(cookie(expired, 'refresh-1'), deps(provider));
    expect(provider.refresh).toHaveBeenCalledWith('refresh-1');
    expect(result.session?.user).toEqual({
      sub: 'line:U1',
      email: 'a@example.com',
      name: 'ช่างภาพ',
    });
    expect(result.setCookies).toHaveLength(2);
    expect(result.setCookies[1]).toMatch(/^__Host-shotx_refresh=refresh-2; .*Max-Age=80000/);
  });

  it('keeps the previous user claims when a Cognito refresh has no ID token', async () => {
    const provider = fakeProvider({
      refresh: () => Promise.resolve({ accessToken: jwt({ sub: 'line:U1' }), expiresIn: 60 }),
    });
    const result = await resolveSession(
      cookie({ ...session, expiresAt: 0 }, 'refresh-1'),
      deps(provider),
    );
    expect(result.session?.user).toEqual(session.user);
    expect(result.setCookies).toHaveLength(1);
  });

  it('clears the cookies when the refresh is refused', async () => {
    for (const code of [ErrorCode.REFRESH_TOKEN_INVALID, ErrorCode.REFRESH_TOKEN_REUSED]) {
      const provider = fakeProvider({
        refresh: () => Promise.reject(new AuthProviderError('refused', 401, code)),
      });
      const result = await resolveSession(
        cookie({ ...session, expiresAt: 0 }, 'r'),
        deps(provider),
      );
      expect(result.session).toBeNull();
      expect(result.unavailable).toBeUndefined();
      expect(result.setCookies).toHaveLength(2);
      expect(result.setCookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
    }
  });

  it('keeps the cookies when the provider is unreachable, so a later request can retry', async () => {
    for (const error of [new AuthProviderError('down'), new AuthProviderError('5xx', 503)]) {
      const provider = fakeProvider({ refresh: () => Promise.reject(error) });
      const result = await resolveSession(
        cookie({ ...session, expiresAt: 0 }, 'r'),
        deps(provider),
      );
      expect(result).toEqual({ session: null, setCookies: [], unavailable: true });
    }
  });

  it('logs out: revokes, clears cookies and goes home (same origin only)', async () => {
    const provider = fakeProvider();
    const forged = await handleLogout(
      new Request(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
      deps(provider),
    );
    expect(forged.status).toBe(403);
    expect(provider.revoke).not.toHaveBeenCalled();

    const response = await handleLogout(
      new Request(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { origin: BASE, cookie: cookie(session, 'refresh-1') },
      }),
      deps(provider),
    );
    expect(provider.revoke).toHaveBeenCalledWith('refresh-1');
    expect(response.headers.get('location')).toBe(`${BASE}/`);
    expect([...setCookies(response).values()]).toEqual(['', '', '']);
    // The API's viewer-session cookie is scoped to /api; it is expired with the same path.
    expect(response.headers.getSetCookie()).toContain(
      'shotx_vs=; Path=/api; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('logs out of the Cognito Hosted UI too with AUTH_PROVIDER=cognito', async () => {
    const provider = createCognitoAuthProvider(
      { domain: 'https://auth.example.com', clientId: 'c' },
      () => Promise.resolve(new Response(null)),
    );
    const response = await handleLogout(
      new Request(`${BASE}/auth/logout`, { method: 'POST', headers: { origin: BASE } }),
      deps(provider),
    );
    expect(response.headers.get('location')).toBe(
      `https://auth.example.com/logout?client_id=c&logout_uri=${encodeURIComponent(`${BASE}/`)}`,
    );
  });
});

describe('act as a photographer (ADR 0018)', () => {
  const code = 'c'.repeat(43);
  const tokens: AuthTokens = {
    accessToken: jwt({ sub: 'password:p1' }),
    refreshToken: 'a'.repeat(43),
    expiresIn: 900,
    refreshExpiresIn: 3600,
    user: { email: 'studio@example.com', name: 'Studio' },
  };
  const get = (query: string, cookie?: string) =>
    new Request(`${BASE}/auth/act-as${query}`, cookie ? { headers: { cookie } } : undefined);

  it('exchanges the code once, ends the previous session, and opens the studio', async () => {
    const actAs = vi.fn(() => Promise.resolve(tokens));
    const provider = fakeProvider({ actAs });
    const response = await handleActAs(
      get(`?code=${code}`, `${names.refresh}=old-refresh`),
      deps(provider),
    );
    expect(actAs).toHaveBeenCalledWith(code);
    expect(provider.revoke).toHaveBeenCalledWith('old-refresh');
    expect(response.headers.get('location')).toBe(`${BASE}/studio`);
    expect(setCookies(response).get(names.refresh)).toBe('a'.repeat(43));
    expect(rawCookie(response, names.refresh)).toContain('Max-Age=3600');
  });

  it('sends a missing, malformed, used or expired code to the sign-in page', async () => {
    const actAs = vi.fn(() => Promise.reject(new AuthProviderError('UNAUTHENTICATED', 401)));
    for (const query of ['', '?code=short', `?code=${code}`]) {
      const response = await handleActAs(get(query), deps(fakeProvider({ actAs })));
      expect(response.headers.get('location'), query).toBe(`${BASE}/login?error=expired`);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(actAs).toHaveBeenCalledTimes(1);
    expect((await handleActAs(get(`?code=${code}`), deps())).status).toBe(404);
  });
});
