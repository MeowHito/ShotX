// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createCognitoAuthProvider } from './cognito';
import { parseCookies } from './cookies';
import {
  type AuthDeps,
  handleCallback,
  handleLogin,
  handleLogout,
  resolveSession,
} from './handlers';
import { codeChallenge, createPkcePair } from './pkce';
import type { AuthProvider, AuthTokens } from './provider';
import {
  cookieNames,
  decodeSession,
  encodeJsonCookie,
  safeNextPath,
  type Session,
} from './session';

const BASE = 'https://photos.example.com';

function jwt(claims: Record<string, unknown>): string {
  return `h.${encodeJsonCookie(claims)}.s`;
}

function fakeProvider(overrides: Partial<AuthProvider> = {}): AuthProvider {
  const tokens: AuthTokens = {
    accessToken: jwt({ sub: 'sub-1' }),
    idToken: jwt({ sub: 'sub-1', email: 'a@example.com', name: 'ช่างภาพ' }),
    refreshToken: 'refresh-1',
    expiresIn: 3600,
  };
  return {
    authorizationUrl: ({ state, codeChallenge, identityProvider }) =>
      `https://auth.example.com/authorize?state=${state}&cc=${codeChallenge}&idp=${identityProvider ?? ''}`,
    exchangeCode: vi.fn(() => Promise.resolve(tokens)),
    refresh: vi.fn(() =>
      Promise.resolve({ ...tokens, refreshToken: undefined, idToken: undefined }),
    ),
    revoke: vi.fn(() => Promise.resolve()),
    logoutUrl: (returnTo) =>
      `https://auth.example.com/logout?logout_uri=${encodeURIComponent(returnTo)}`,
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

const names = cookieNames(true);

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

describe('Cognito provider', () => {
  const cognito = {
    domain: 'https://shotx.auth.ap-southeast-1.amazoncognito.com',
    clientId: 'abc123',
  };

  it('builds the authorize URL with PKCE, Thai UI and the identity provider', () => {
    const url = new URL(
      createCognitoAuthProvider(cognito).authorizationUrl({
        state: 'st',
        codeChallenge: 'cc',
        redirectUri: `${BASE}/auth/callback`,
        identityProvider: 'LINE',
      }),
    );
    expect(url.origin + url.pathname).toBe(`${cognito.domain}/oauth2/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'abc123',
      redirect_uri: `${BASE}/auth/callback`,
      scope: 'openid email profile',
      state: 'st',
      code_challenge: 'cc',
      code_challenge_method: 'S256',
      lang: 'th',
      identity_provider: 'LINE',
    });
  });

  it('exchanges the code at the token endpoint without a client secret', async () => {
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
    const tokens = await createCognitoAuthProvider(cognito, fetch).exchangeCode({
      code: 'c',
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

  it('rejects a failed token response', async () => {
    const provider = createCognitoAuthProvider(cognito, () =>
      Promise.resolve(new Response('{}', { status: 400 })),
    );
    await expect(provider.refresh('rt')).rejects.toThrow('400');
  });
});

describe('login and callback', () => {
  it('redirects to the provider and stores PKCE state in an httpOnly cookie', async () => {
    const response = await handleLogin(
      new Request(`${BASE}/auth/login?provider=line&next=/studio/folders/x`),
      deps(),
    );
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('idp')).toBe('LINE');
    const raw = response.headers.getSetCookie()[0] ?? '';
    expect(raw).toMatch(/^__Host-shotx_pkce=.*HttpOnly; Secure; SameSite=Lax/);
  });

  it('completes the flow: exchanges the code and sets the session cookies', async () => {
    const provider = fakeProvider();
    const login = await handleLogin(
      new Request(`${BASE}/auth/login?provider=google&next=/studio/trash`),
      deps(provider),
    );
    const state = new URL(login.headers.get('location') ?? '').searchParams.get('state');
    const pkce = setCookies(login).get(names.pkce) ?? '';

    const callback = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=${state}`, {
        headers: { cookie: `${names.pkce}=${encodeURIComponent(pkce)}` },
      }),
      deps(provider),
    );
    expect(callback.headers.get('location')).toBe(`${BASE}/studio/trash`);
    const cookies = setCookies(callback);
    expect(cookies.get(names.pkce)).toBe('');
    expect(cookies.get(names.refresh)).toBe('refresh-1');
    const session = decodeSession(cookies.get(names.session));
    expect(session?.user).toEqual({ sub: 'sub-1', email: 'a@example.com', name: 'ช่างภาพ' });
    expect(session?.expiresAt).toBe(1_000_000 + 3600 * 1000);
    expect(provider.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'abc', redirectUri: `${BASE}/auth/callback` }),
    );
  });

  it('rejects a state mismatch, a missing PKCE cookie and a cancelled login', async () => {
    const pkce = encodeJsonCookie({
      verifier: 'v'.repeat(43),
      state: 's'.repeat(32),
      next: '/studio',
    });
    const mismatch = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=other`, {
        headers: { cookie: `${names.pkce}=${pkce}` },
      }),
      deps(),
    );
    expect(mismatch.headers.get('location')).toBe(`${BASE}/login?error=failed`);
    const missing = await handleCallback(
      new Request(`${BASE}/auth/callback?code=abc&state=x`),
      deps(),
    );
    expect(missing.headers.get('location')).toBe(`${BASE}/login?error=expired`);
    const cancelled = await handleCallback(
      new Request(`${BASE}/auth/callback?error=access_denied`),
      deps(),
    );
    expect(cancelled.headers.get('location')).toBe(`${BASE}/login?error=cancelled`);
  });

  it('never redirects off-site after login', () => {
    expect(safeNextPath('/studio/folders/1')).toBe('/studio/folders/1');
    expect(safeNextPath('https://evil.example')).toBe('/studio');
    expect(safeNextPath('//evil.example')).toBe('/studio');
    expect(safeNextPath('/\\evil.example')).toBe('/studio');
    expect(safeNextPath(null)).toBe('/studio');
  });
});

describe('sessions', () => {
  const session: Session = {
    accessToken: 'at',
    expiresAt: 1_000_000 + 10 * 60_000,
    user: { sub: 'sub-1', email: null, name: 'A' },
  };
  const cookie = (s: Session, refresh?: string) =>
    `${names.session}=${encodeJsonCookie(s)}${refresh ? `; ${names.refresh}=${refresh}` : ''}`;

  it('uses a valid session as is', async () => {
    await expect(resolveSession(cookie(session), deps())).resolves.toEqual({
      session,
      setCookies: [],
    });
  });

  it('refreshes a nearly expired session and keeps the user claims', async () => {
    const provider = fakeProvider();
    const expired = { ...session, expiresAt: 1_000_000 + 30_000 };
    const result = await resolveSession(cookie(expired, 'refresh-1'), deps(provider));
    expect(provider.refresh).toHaveBeenCalledWith('refresh-1');
    expect(result.session?.user).toEqual(session.user);
    expect(result.session?.accessToken).toBe(jwt({ sub: 'sub-1' }));
    expect(result.setCookies).toHaveLength(1);
  });

  it('clears the cookies when the refresh fails', async () => {
    const provider = fakeProvider({ refresh: () => Promise.reject(new Error('revoked')) });
    const result = await resolveSession(cookie({ ...session, expiresAt: 0 }, 'r'), deps(provider));
    expect(result.session).toBeNull();
    expect(result.setCookies.every((c) => c.includes('Max-Age=0'))).toBe(true);
  });

  it('logs out: revokes, clears cookies and ends the Hosted UI session (same origin only)', async () => {
    const provider = fakeProvider();
    const forged = await handleLogout(
      new Request(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { origin: 'https://evil.example' },
      }),
      deps(provider),
    );
    expect(forged.status).toBe(403);

    const response = await handleLogout(
      new Request(`${BASE}/auth/logout`, {
        method: 'POST',
        headers: { origin: BASE, cookie: cookie(session, 'refresh-1') },
      }),
      deps(provider),
    );
    expect(provider.revoke).toHaveBeenCalledWith('refresh-1');
    expect(response.headers.get('location')).toBe(
      `https://auth.example.com/logout?logout_uri=${encodeURIComponent(`${BASE}/`)}`,
    );
    expect(parseCookies(null).size).toBe(0);
    expect([...setCookies(response).values()]).toEqual(['', '']);
  });
});
