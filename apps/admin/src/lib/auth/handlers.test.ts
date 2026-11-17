import {
  type AdminChangePasswordBody,
  type AdminLoginBody,
  type AdminMfaBody,
  type AuthTokenResponse,
  ErrorCode,
} from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError } from '../api/errors';
import type { AdminAuthApi } from './admin-auth-api';
import {
  type AuthDeps,
  handleLoginStep,
  handleLogout,
  handleMfaStep,
  handlePasswordStep,
  resolveSession,
} from './handlers';
import { cookieNames, decodeSession, encodeJsonCookie } from './session';

const ORIGIN = 'https://admin.example.co.th';
const CHALLENGE_1 = 'c'.repeat(43);
const CHALLENGE_2 = 'd'.repeat(43);
const REFRESH = 'r'.repeat(43);
const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

function jwt(claims: Record<string, unknown>): string {
  return `e30.${encodeJsonCookie(claims)}.sig`;
}

function tokens(overrides: Partial<AuthTokenResponse> = {}): AuthTokenResponse {
  return {
    accessToken: jwt({ sub: `admin:${ADMIN_ID}`, amr: ['pwd', 'otp', 'mfa'] }),
    refreshToken: REFRESH,
    expiresIn: 900,
    refreshExpiresIn: 43_200,
    user: { email: 'owner@example.co.th', name: 'Owner' },
    ...overrides,
  };
}

function fakeApi(overrides: Partial<AdminAuthApi> = {}): AdminAuthApi {
  return {
    login: vi.fn((_: AdminLoginBody) =>
      Promise.resolve({ step: 'totp' as const, challengeId: CHALLENGE_1, expiresIn: 300 }),
    ),
    changePassword: vi.fn((_: AdminChangePasswordBody) =>
      Promise.resolve({ step: 'totp' as const, challengeId: CHALLENGE_2, expiresIn: 300 }),
    ),
    mfa: vi.fn((_: AdminMfaBody) => Promise.resolve(tokens())),
    refresh: vi.fn(() => Promise.resolve(tokens())),
    logout: vi.fn(() => Promise.resolve()),
    providers: vi.fn(() =>
      Promise.resolve({
        oidc: [],
        devLogin: false,
        adminLogin: true,
        adminMfaMode: 'off' as const,
        passwordReset: false,
      }),
    ),
    ...overrides,
  };
}

function deps(api: AdminAuthApi, secureCookies = true): AuthDeps {
  return { api, adminBaseUrl: ORIGIN, secureCookies, now: () => NOW };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const names = cookieNames(true);

describe('sign-in step handlers', () => {
  it('keeps the challenge in an httpOnly Strict cookie and never in the body', async () => {
    const api = fakeApi({
      login: vi.fn(() =>
        Promise.resolve({
          step: 'enrol_totp' as const,
          challengeId: CHALLENGE_1,
          expiresIn: 300,
          otpauthUri: 'otpauth://totp/ShotX:a?secret=JBSWY3DPEHPK3PXP',
        }),
      ),
    });
    const response = await handleLoginStep(
      post('/auth/login', { email: 'owner@example.co.th', password: 'pw' }),
      deps(api),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain(CHALLENGE_1);
    expect(JSON.parse(text)).toEqual({
      step: 'enrol_totp',
      otpauthUri: 'otpauth://totp/ShotX:a?secret=JBSWY3DPEHPK3PXP',
    });
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toBe(
      `${names.challenge}=${CHALLENGE_1}; Path=/; Max-Age=300; HttpOnly; Secure; SameSite=Strict`,
    );
    expect(api.login).toHaveBeenCalledWith({ email: 'owner@example.co.th', password: 'pw' });
  });

  it('refuses other origins and malformed bodies without calling the API', async () => {
    const api = fakeApi();
    const cross = await handleLoginStep(
      post('/auth/login', { email: 'a@b.co', password: 'x' }, { origin: 'https://evil.example' }),
      deps(api),
    );
    expect(cross.status).toBe(403);
    const bad = await handleLoginStep(post('/auth/login', { email: 'nope' }), deps(api));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(api.login).not.toHaveBeenCalled();
  });

  it('passes the API error code and details through (PASSWORD_TOO_WEAK, MFA_INVALID)', async () => {
    const api = fakeApi({
      changePassword: vi.fn(() =>
        Promise.reject(
          new ApiError(422, ErrorCode.PASSWORD_TOO_WEAK, 'weak', {
            reason: 'too_short',
            minLength: 14,
          }),
        ),
      ),
      mfa: vi.fn(() => Promise.reject(new ApiError(401, ErrorCode.MFA_INVALID, 'bad', undefined))),
    });
    const cookie = { cookie: `${names.challenge}=${CHALLENGE_1}` };
    const weak = await handlePasswordStep(
      post('/auth/password', { newPassword: 'short' }, cookie),
      deps(api),
    );
    expect(weak.status).toBe(422);
    expect(await weak.json()).toMatchObject({
      code: 'PASSWORD_TOO_WEAK',
      details: { reason: 'too_short', minLength: 14 },
    });
    // The challenge stays usable after a weak password or a wrong code.
    expect(weak.headers.getSetCookie()).toEqual([]);
    const wrong = await handleMfaStep(post('/auth/mfa', { code: '123456' }, cookie), deps(api));
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { code: string }).code).toBe('MFA_INVALID');
    expect(wrong.headers.getSetCookie()).toEqual([]);
    expect(api.changePassword).toHaveBeenCalledWith({
      challengeId: CHALLENGE_1,
      newPassword: 'short',
    });
  });

  it('answers LOGIN_STATE_INVALID without a challenge cookie and clears a dead one', async () => {
    const api = fakeApi({
      mfa: vi.fn(() =>
        Promise.reject(new ApiError(400, ErrorCode.LOGIN_STATE_INVALID, 'gone', undefined)),
      ),
    });
    const none = await handleMfaStep(post('/auth/mfa', { code: '123456' }), deps(api));
    expect(none.status).toBe(400);
    expect(api.mfa).not.toHaveBeenCalled();
    const dead = await handleMfaStep(
      post('/auth/mfa', { code: '123456' }, { cookie: `${names.challenge}=${CHALLENGE_1}` }),
      deps(api),
    );
    expect(((await dead.json()) as { code: string }).code).toBe('LOGIN_STATE_INVALID');
    expect(dead.headers.getSetCookie()[0]).toContain(`${names.challenge}=; Path=/; Max-Age=0`);
  });

  it('rotates the challenge on the password step', async () => {
    const api = fakeApi();
    const response = await handlePasswordStep(
      post(
        '/auth/password',
        { newPassword: 'a-new-long-password' },
        { cookie: `${names.challenge}=${CHALLENGE_1}` },
      ),
      deps(api),
    );
    expect(await response.json()).toEqual({ step: 'totp' });
    expect(response.headers.getSetCookie()[0]).toContain(`${names.challenge}=${CHALLENGE_2};`);
  });

  it('sets the session only after the code step, with no token in the body', async () => {
    const api = fakeApi();
    const response = await handleMfaStep(
      post('/auth/mfa', { code: '123456' }, { cookie: `${names.challenge}=${CHALLENGE_1}` }),
      deps(api),
    );
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ step: 'signed_in' });
    expect(text).not.toContain(REFRESH);
    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toContain(`${names.challenge}=; Path=/; Max-Age=0`);
    const session = cookies.find((c) => c.startsWith(`${names.session}=`));
    const refresh = cookies.find((c) => c.startsWith(`${names.refresh}=`));
    for (const c of [session, refresh]) {
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Secure');
      expect(c).toContain('SameSite=Strict');
      expect(c).toContain('Max-Age=43200');
    }
    expect(refresh).toContain(`=${REFRESH};`);
    const value = decodeURIComponent(session!.split(';')[0]!.split('=')[1]!);
    expect(decodeSession(value)).toMatchObject({
      expiresAt: NOW + 900_000,
      user: { id: ADMIN_ID, email: 'owner@example.co.th', name: 'Owner' },
    });
    expect(api.mfa).toHaveBeenCalledWith({ challengeId: CHALLENGE_1, code: '123456' });
  });

  it('only accepts 6 or 8 digit codes', async () => {
    const api = fakeApi();
    const cookie = { cookie: `${names.challenge}=${CHALLENGE_1}` };
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      const response = await handleMfaStep(post('/auth/mfa', { code }, cookie), deps(api));
      expect(response.status, code).toBe(400);
    }
    expect(api.mfa).not.toHaveBeenCalled();
  });

  it('uses plain cookie names without Secure on http localhost', async () => {
    const response = await handleLoginStep(
      new Request('http://localhost:3001/auth/login', {
        method: 'POST',
        headers: { origin: 'http://localhost:3001' },
        body: JSON.stringify({ email: 'a@b.co', password: 'x' }),
      }),
      { ...deps(fakeApi(), false), adminBaseUrl: 'http://localhost:3001' },
    );
    const [cookie] = response.headers.getSetCookie();
    expect(cookie).toMatch(/^shotx_admin_challenge=/);
    expect(cookie).not.toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });
});

describe('sign-in without TOTP (ADMIN_MFA_MODE=off)', () => {
  function expectSession(response: Response) {
    const cookies = response.headers.getSetCookie();
    expect(cookies[0]).toContain(`${names.challenge}=; Path=/; Max-Age=0`);
    const session = cookies.find((c) => c.startsWith(`${names.session}=`));
    const refresh = cookies.find((c) => c.startsWith(`${names.refresh}=`));
    for (const c of [session, refresh]) {
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Secure');
      expect(c).toContain('SameSite=Strict');
      expect(c).toContain('Max-Age=43200');
    }
    expect(refresh).toContain(`=${REFRESH};`);
    const value = decodeURIComponent(session!.split(';')[0]!.split('=')[1]!);
    expect(decodeSession(value)).toMatchObject({ user: { id: ADMIN_ID } });
  }

  it('stores the tokens from the password step and never sends them to the browser', async () => {
    const api = fakeApi({
      login: vi.fn(() =>
        Promise.resolve({
          ...tokens({ accessToken: jwt({ sub: `admin:${ADMIN_ID}`, amr: ['pwd'] }) }),
          step: 'signed_in' as const,
        }),
      ),
    });
    const response = await handleLoginStep(
      post('/auth/login', { email: 'owner@example.test', password: 'pw' }),
      deps(api),
    );
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ step: 'signed_in' });
    expect(text).not.toContain(REFRESH);
    expect(text).not.toContain('accessToken');
    expectSession(response);
  });

  it('signs in right after a forced password change', async () => {
    const api = fakeApi({
      changePassword: vi.fn(() => Promise.resolve({ ...tokens(), step: 'signed_in' as const })),
    });
    const response = await handlePasswordStep(
      post(
        '/auth/password',
        { newPassword: 'a-new-long-password' },
        { cookie: `${names.challenge}=${CHALLENGE_1}` },
      ),
      deps(api),
    );
    expect(await response.json()).toEqual({ step: 'signed_in' });
    expectSession(response);
    expect(api.mfa).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  it('revokes the refresh token and clears every admin cookie', async () => {
    const api = fakeApi();
    const response = await handleLogout(
      new Request(`${ORIGIN}/auth/logout`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: `${names.refresh}=${REFRESH}` },
      }),
      deps(api),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
    expect(api.logout).toHaveBeenCalledWith(REFRESH);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(3);
    for (const c of cookies) expect(c).toContain('Max-Age=0');
  });

  it('accepts the sign-out form, sent with Origin: null under no-referrer', async () => {
    const response = await handleLogout(
      new Request(`${ORIGIN}/auth/logout`, {
        method: 'POST',
        headers: { origin: 'null', 'sec-fetch-site': 'same-origin' },
      }),
      deps(fakeApi()),
    );
    expect(response.status).toBe(303);
  });

  it('refuses Origin: null from anywhere but the admin app', async () => {
    for (const site of ['cross-site', 'same-site', 'none', null]) {
      const headers: Record<string, string> = { origin: 'null' };
      if (site !== null) headers['sec-fetch-site'] = site;
      const response = await handleLogout(
        new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers }),
        deps(fakeApi()),
      );
      expect(response.status).toBe(403);
    }
  });

  it('refuses a cross-site logout', async () => {
    const response = await handleLogout(
      new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { origin: 'https://x.y' } }),
      deps(fakeApi()),
    );
    expect(response.status).toBe(403);
  });
});

describe('resolveSession', () => {
  const sessionCookie = (expiresAt: number) =>
    `${names.session}=${encodeJsonCookie({
      accessToken: 'at',
      expiresAt,
      user: { id: ADMIN_ID, email: 'a@b.co', name: null },
    })}`;

  it('uses a fresh session as is', async () => {
    const api = fakeApi();
    const result = await resolveSession(sessionCookie(NOW + 600_000), deps(api));
    expect(result.session?.accessToken).toBe('at');
    expect(api.refresh).not.toHaveBeenCalled();
  });

  it('refreshes a nearly expired session with the admins refresh token', async () => {
    const api = fakeApi();
    const result = await resolveSession(
      `${sessionCookie(NOW + 30_000)}; ${names.refresh}=${REFRESH}`,
      deps(api),
    );
    expect(api.refresh).toHaveBeenCalledWith(REFRESH);
    expect(result.session?.user.id).toBe(ADMIN_ID);
    expect(result.setCookies).toHaveLength(2);
  });

  it('clears the cookies when the refresh is refused, keeps them when the API is down', async () => {
    const refused = fakeApi({
      refresh: vi.fn(() =>
        Promise.reject(new ApiError(401, ErrorCode.REFRESH_TOKEN_REUSED, 'x', undefined)),
      ),
    });
    const cleared = await resolveSession(`${names.refresh}=${REFRESH}`, deps(refused));
    expect(cleared.session).toBeNull();
    expect(cleared.setCookies).toHaveLength(2);

    const down = fakeApi({ refresh: vi.fn(() => Promise.reject(new NetworkError('down'))) });
    const kept = await resolveSession(`${names.refresh}=${REFRESH}`, deps(down));
    expect(kept).toEqual({ session: null, setCookies: [], unavailable: true });
  });
});
