// @vitest-environment node
import {
  AUTH_ROUTES,
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  ErrorCode,
  PASSWORD_CHANGE_CLAIM,
  PHOTOGRAPHER_ACCOUNT_ROUTES,
} from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { BFF_KEY, FakeAuthApi } from '../../../test/fake-auth-api';
import type { AuthDeps } from './handlers';
import { handleChangePassword, handlePasswordSignIn } from './password';
import { afterPasswordChangePath, changePasswordPageHref } from './password-client';
import { cookieNames, decodeSession, jwtClaims } from './session';
import { createShotxAuthProvider, RefreshCache } from './shotx';

const BASE = 'https://photos.example.com';
const names = cookieNames(true);
const EMAIL = 'somchai@example.com';
const TEMPORARY = 'Temp-4821-xq';
const CHOSEN = 'my-own-Secret-77';

function setup() {
  const api = new FakeAuthApi();
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) =>
    api.fetch((input as string).replace('http://api:4000', 'http://api'), init),
  );
  const provider = createShotxAuthProvider({
    apiInternalUrl: 'http://api:4000',
    client: { refreshReuseGraceSeconds: 10, callTimeoutMs: 15_000 },
    context: { bffKey: BFF_KEY, clientIp: '203.0.113.7' },
    fetch,
    devLogin: false,
    refreshCache: new RefreshCache(0, () => api.now),
  });
  const deps: AuthDeps = { provider, publicBaseUrl: BASE, secureCookies: true, now: () => api.now };
  return { api, fetch, provider, deps };
}

/** Set-Cookie headers of a response as name -> { value, raw }. */
function cookiesOf(response: Response): Map<string, { value: string; raw: string }> {
  return new Map(
    response.headers.getSetCookie().map((raw) => {
      const [pair = ''] = raw.split(';');
      const eq = pair.indexOf('=');
      return [pair.slice(0, eq), { value: decodeURIComponent(pair.slice(eq + 1)), raw }];
    }),
  );
}

function cookieHeader(response: Response): string {
  return [...cookiesOf(response)]
    .filter(([, c]) => !c.raw.includes('Max-Age=0'))
    .map(([name, c]) => `${name}=${encodeURIComponent(c.value)}`)
    .join('; ');
}

function signInRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/auth/sign-in`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function changeRequest(body: unknown, cookie: string, headers: Record<string, string> = {}) {
  return new Request(`${BASE}/auth/password`, {
    method: 'POST',
    headers: { origin: BASE, 'content-type': 'application/json', cookie, ...headers },
    body: JSON.stringify(body),
  });
}

describe('photographer sign-in (POST /auth/sign-in)', () => {
  it('signs in with the BFF key and the client IP and stores the tokens in httpOnly cookies only', async () => {
    const { api, deps } = setup();
    api.addPhotographer({ email: EMAIL, password: CHOSEN, name: 'สมชาย', mustChange: false });
    const response = await handlePasswordSignIn(
      signInRequest({ email: 'SomChai@example.com', password: CHOSEN, next: '/studio/shares' }),
      deps,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ step: 'signed_in', redirectTo: '/studio/shares' });

    const call = api.calls.find((c) => c.route === AUTH_ROUTES.photographerSignIn);
    expect(call?.body).toEqual({ email: 'SomChai@example.com', password: CHOSEN });
    expect(call?.headers[BFF_KEY_HEADER]).toBe(BFF_KEY);
    expect(call?.headers[BFF_CLIENT_IP_HEADER]).toBe('203.0.113.7');

    const cookies = cookiesOf(response);
    const session = decodeSession(cookies.get(names.session)?.value);
    expect(session?.user).toMatchObject({ email: EMAIL, name: 'สมชาย' });
    expect(session?.user.sub).toMatch(/^password:/);
    expect(cookies.get(names.refresh)?.raw).toContain('HttpOnly');
    expect(cookies.get(names.refresh)?.raw).toContain(`Max-Age=${api.refreshTtlSeconds}`);
    expect(api.refreshTokenWorks(cookies.get(names.refresh)?.value ?? '')).toBe(true);
    // The browser gets the step only: no token in the body.
    expect(Object.keys(body).sort()).toEqual(['redirectTo', 'step']);
  });

  it('a temporary password: a restricted, short session and the change page next', async () => {
    const { api, deps } = setup();
    api.addPhotographer({ email: EMAIL, password: TEMPORARY });
    const response = await handlePasswordSignIn(
      signInRequest({ email: EMAIL, password: TEMPORARY, next: '/studio/trash' }),
      deps,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      step: 'change_password',
      redirectTo: '/change-password?next=%2Fstudio%2Ftrash',
    });
    const cookies = cookiesOf(response);
    expect(cookies.get(names.refresh)?.raw).toContain(`Max-Age=${api.restrictedTtlSeconds}`);
    const session = decodeSession(cookies.get(names.session)?.value);
    expect(jwtClaims(session?.accessToken)[PASSWORD_CHANGE_CLAIM]).toBe(true);
  });

  it('answers the API codes with their status and sets no cookie', async () => {
    const { api, deps } = setup();
    api.addPhotographer({ email: EMAIL, password: CHOSEN, mustChange: false });
    api.addPhotographer({ email: 'off@example.com', password: CHOSEN, disabled: true });

    const wrong = await handlePasswordSignIn(signInRequest({ email: EMAIL, password: 'x' }), deps);
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });
    expect(wrong.headers.getSetCookie()).toEqual([]);

    const unknown = await handlePasswordSignIn(
      signInRequest({ email: 'nobody@example.com', password: CHOSEN }),
      deps,
    );
    await expect(unknown.json()).resolves.toMatchObject({ code: ErrorCode.INVALID_CREDENTIALS });

    const disabled = await handlePasswordSignIn(
      signInRequest({ email: 'off@example.com', password: CHOSEN }),
      deps,
    );
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({ code: ErrorCode.ACCOUNT_DISABLED });
    expect(disabled.headers.getSetCookie()).toEqual([]);
  });

  it('passes the lockout through as RATE_LIMITED with its details', async () => {
    const { api, deps } = setup();
    api.addPhotographer({ email: EMAIL, password: CHOSEN, mustChange: false });
    for (let i = 0; i < api.lockoutThreshold; i++) {
      await handlePasswordSignIn(signInRequest({ email: EMAIL, password: 'nope' }), deps);
    }
    const locked = await handlePasswordSignIn(
      signInRequest({ email: EMAIL, password: CHOSEN }),
      deps,
    );
    expect(locked.status).toBe(429);
    await expect(locked.json()).resolves.toEqual({
      code: ErrorCode.RATE_LIMITED,
      message: ErrorCode.RATE_LIMITED,
      details: { retryAfterSeconds: api.lockoutSeconds, captcha: null },
    });
  });

  it('refuses cross-origin posts, bad bodies and Cognito, without calling the API', async () => {
    const { api, deps } = setup();
    const crossOrigin = await handlePasswordSignIn(
      signInRequest({ email: EMAIL, password: CHOSEN }, { origin: 'https://evil.example' }),
      deps,
    );
    expect(crossOrigin.status).toBe(403);
    const invalid = await handlePasswordSignIn(
      signInRequest({ email: 'not-an-email', password: CHOSEN }),
      deps,
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
    const extra = await handlePasswordSignIn(
      signInRequest({ email: EMAIL, password: CHOSEN, role: 'admin' }),
      deps,
    );
    expect(extra.status).toBe(400);
    const cognito = await handlePasswordSignIn(signInRequest({ email: EMAIL, password: CHOSEN }), {
      ...deps,
      provider: { ...deps.provider, passwordSignIn: undefined },
    });
    expect(cognito.status).toBe(404);
    expect(api.calls).toEqual([]);
  });

  it('never redirects off-site and ends a previous session in this browser', async () => {
    const { api, deps } = setup();
    api.addPhotographer({ email: EMAIL, password: CHOSEN, mustChange: false });
    const line = api.signIn('line:U1', { email: null, name: 'LINE' });
    const response = await handlePasswordSignIn(
      signInRequest(
        { email: EMAIL, password: CHOSEN, next: '//evil.example/x' },
        { cookie: `${names.refresh}=${line.refreshToken}` },
      ),
      deps,
    );
    await expect(response.json()).resolves.toMatchObject({ redirectTo: '/studio' });
    expect(api.refreshTokenWorks(line.refreshToken)).toBe(false);
  });
});

describe('password change (POST /auth/password)', () => {
  async function restrictedSession() {
    const env = setup();
    env.api.addPhotographer({ email: EMAIL, password: TEMPORARY });
    const signIn = await handlePasswordSignIn(
      signInRequest({ email: EMAIL, password: TEMPORARY }),
      env.deps,
    );
    return { ...env, cookie: cookieHeader(signIn), signIn };
  }

  it('changes with the session’s own token and replaces the cookies with the new session', async () => {
    const { api, deps, cookie, signIn } = await restrictedSession();
    const oldRefresh = cookiesOf(signIn).get(names.refresh)?.value ?? '';
    const oldAccess = decodeSession(cookiesOf(signIn).get(names.session)?.value)?.accessToken;

    const response = await handleChangePassword(
      changeRequest({ currentPassword: TEMPORARY, newPassword: CHOSEN }, cookie),
      deps,
    );
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');

    const call = api.calls.find((c) => c.route === PHOTOGRAPHER_ACCOUNT_ROUTES.changePassword);
    expect(call?.headers.authorization).toBe(`Bearer ${oldAccess}`);
    expect(call?.body).toEqual({ currentPassword: TEMPORARY, newPassword: CHOSEN });

    const cookies = cookiesOf(response);
    const newRefresh = cookies.get(names.refresh)?.value ?? '';
    expect(newRefresh).not.toBe(oldRefresh);
    expect(cookies.get(names.refresh)?.raw).toContain(`Max-Age=${api.refreshTtlSeconds}`);
    expect(api.refreshTokenWorks(newRefresh)).toBe(true);
    // Every other session of the account (the restricted one too) is gone.
    expect(api.refreshTokenWorks(oldRefresh)).toBe(false);
    const session = decodeSession(cookies.get(names.session)?.value);
    expect(jwtClaims(session?.accessToken)[PASSWORD_CHANGE_CLAIM]).toBeUndefined();
    expect(session?.user.email).toBe(EMAIL);

    // The new password signs in normally now.
    const again = await handlePasswordSignIn(
      signInRequest({ email: EMAIL, password: CHOSEN }),
      deps,
    );
    await expect(again.json()).resolves.toMatchObject({ step: 'signed_in' });
  });

  it('passes PASSWORD_INCORRECT and PASSWORD_TOO_WEAK (with details) through, keeping the session', async () => {
    const { deps, cookie } = await restrictedSession();
    const wrong = await handleChangePassword(
      changeRequest({ currentPassword: 'not-it', newPassword: CHOSEN }, cookie),
      deps,
    );
    expect(wrong.status).toBe(403);
    await expect(wrong.json()).resolves.toMatchObject({ code: ErrorCode.PASSWORD_INCORRECT });
    expect(wrong.headers.getSetCookie()).toEqual([]);

    const weak = await handleChangePassword(
      changeRequest({ currentPassword: TEMPORARY, newPassword: 'short' }, cookie),
      deps,
    );
    expect(weak.status).toBe(422);
    await expect(weak.json()).resolves.toMatchObject({
      code: ErrorCode.PASSWORD_TOO_WEAK,
      details: { reason: 'too_short', minLength: 10 },
    });
    const same = await handleChangePassword(
      changeRequest({ currentPassword: TEMPORARY, newPassword: TEMPORARY }, cookie),
      deps,
    );
    await expect(same.json()).resolves.toMatchObject({
      details: { reason: 'same_as_current' },
    });
  });

  it('refreshes an expired access token first and keeps the rotated cookies on an error', async () => {
    const { api, deps, cookie } = await restrictedSession();
    api.now += 20 * 60_000; // the access token (15 min) is gone, the family (30 min) isn't
    const response = await handleChangePassword(
      changeRequest({ currentPassword: 'not-it', newPassword: CHOSEN }, cookie),
      deps,
    );
    expect(response.status).toBe(403);
    const rotated = cookiesOf(response).get(names.refresh)?.value ?? '';
    expect(api.refreshTokenWorks(rotated)).toBe(true);
  });

  it('answers UNAUTHENTICATED without a session, and refuses cross-origin posts and bad bodies', async () => {
    const { api, deps, cookie } = await restrictedSession();
    const calls = api.calls.length;
    const none = await handleChangePassword(
      changeRequest({ currentPassword: TEMPORARY, newPassword: CHOSEN }, ''),
      deps,
    );
    expect(none.status).toBe(401);
    await expect(none.json()).resolves.toMatchObject({ code: ErrorCode.UNAUTHENTICATED });
    const crossOrigin = await handleChangePassword(
      changeRequest({ currentPassword: TEMPORARY, newPassword: CHOSEN }, cookie, {
        origin: 'https://evil.example',
      }),
      deps,
    );
    expect(crossOrigin.status).toBe(403);
    const invalid = await handleChangePassword(
      changeRequest({ currentPassword: TEMPORARY }, cookie),
      deps,
    );
    expect(invalid.status).toBe(400);
    expect(api.calls.length).toBe(calls);
  });

  it('clears the cookies when the account was disabled meanwhile', async () => {
    const { api, deps, cookie } = await restrictedSession();
    for (const account of api.accounts.values()) account.disabled = true;
    const response = await handleChangePassword(
      changeRequest({ currentPassword: TEMPORARY, newPassword: CHOSEN }, cookie),
      deps,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: ErrorCode.ACCOUNT_DISABLED });
    const cleared = cookiesOf(response);
    expect(cleared.get(names.session)?.raw).toContain('Max-Age=0');
    expect(cleared.get(names.refresh)?.raw).toContain('Max-Age=0');
  });

  it('works for a voluntary change from a normal session too', async () => {
    const { api, deps } = setup();
    api.addPhotographer({ email: EMAIL, password: CHOSEN, mustChange: false });
    const signIn = await handlePasswordSignIn(
      signInRequest({ email: EMAIL, password: CHOSEN }),
      deps,
    );
    const response = await handleChangePassword(
      changeRequest(
        { currentPassword: CHOSEN, newPassword: 'another-Phrase-91' },
        cookieHeader(signIn),
      ),
      deps,
    );
    expect(response.status).toBe(204);
  });
});

describe('change page paths', () => {
  it('returns to next, never to itself or off-site', () => {
    expect(changePasswordPageHref('/studio/shares')).toBe(
      '/change-password?next=%2Fstudio%2Fshares',
    );
    expect(afterPasswordChangePath('/change-password?next=%2Fstudio')).toBe('/studio');
    expect(afterPasswordChangePath('/change-password')).toBe('/studio');
    expect(afterPasswordChangePath('https://evil.example')).toBe('/studio');
    expect(afterPasswordChangePath('/studio/folders/x')).toBe('/studio/folders/x');
  });
});
