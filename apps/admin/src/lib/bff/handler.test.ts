import { type AuthTokenResponse, BFF_CLIENT_IP_HEADER, BFF_KEY_HEADER } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { urlOf } from '../../../test/fetch';
import type { AdminAuthApi } from '../auth/admin-auth-api';
import type { AuthDeps } from '../auth/handlers';
import { cookieNames, encodeJsonCookie } from '../auth/session';
import { clientIpFromHeaders } from './client-ip';
import { FORWARDED_ROUTES, handleBffRequest, matchRoute, unsafePathReason } from './handler';

const ORIGIN = 'https://admin.example.co.th';
const NOW = 1_800_000_000_000;
const KEY = 'k'.repeat(40);
const USER_ID = '22222222-2222-4222-8222-222222222222';
const names = cookieNames(true);
const session = `${names.session}=${encodeJsonCookie({
  accessToken: 'access-1',
  expiresAt: NOW + 600_000,
  user: { id: null, email: 'a@b.co', name: null },
})}`;

function setup(upstream: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: urlOf(input), init: init ?? {} });
    return Promise.resolve(upstream(urlOf(input), init ?? {}));
  }) as unknown as typeof fetch;
  const api: AdminAuthApi = {
    login: vi.fn(),
    changePassword: vi.fn(),
    mfa: vi.fn(),
    refresh: vi.fn((): Promise<AuthTokenResponse> => Promise.reject(new Error('no'))),
    logout: vi.fn(),
  };
  const auth: AuthDeps = { api, adminBaseUrl: ORIGIN, secureCookies: true, now: () => NOW };
  const run = (path: string, init: RequestInit = {}) =>
    handleBffRequest(new Request(`${ORIGIN}${path}`, init), {
      auth,
      apiInternalUrl: 'http://api:4000/',
      context: { bffKey: KEY, clientIp: '203.0.113.7' },
      fetch: fetchImpl,
    });
  return { calls, run };
}

const ok = () =>
  new Response(JSON.stringify({ items: [], nextCursor: null }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('admin BFF', () => {
  it('forwards only the admin routes, never sign-in or other modules', () => {
    expect(FORWARDED_ROUTES.length).toBeGreaterThanOrEqual(7);
    expect(FORWARDED_ROUTES.every((r) => r.auth === 'admin' && r.path.startsWith('/admin/'))).toBe(
      true,
    );
    expect(matchRoute('GET', '/admin/users')).not.toBeNull();
    expect(matchRoute('POST', `/admin/users/${USER_ID}/reset-password`)).not.toBeNull();
    for (const [method, path] of [
      ['POST', '/auth/admin/login'],
      ['POST', '/auth/admin/mfa'],
      ['POST', '/auth/refresh'],
      ['GET', '/drive/folders/root/children'],
      ['GET', '/me'],
      ['POST', '/billing/checkout'],
      ['DELETE', '/admin/users'],
    ] as const) {
      expect(matchRoute(method, path), path).toBeNull();
    }
  });

  it('adds the bearer token, BFF key and client IP, and passes the answer through', async () => {
    const { calls, run } = setup(ok);
    const response = await run('/bff/admin/users?q=a%40b&role=admin', {
      headers: { cookie: session, [BFF_KEY_HEADER]: 'forged', authorization: 'Bearer forged' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api:4000/api/admin/users?q=a%40b&role=admin');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer access-1');
    expect(headers[BFF_KEY_HEADER]).toBe(KEY);
    expect(headers[BFF_CLIENT_IP_HEADER]).toBe('203.0.113.7');
  });

  it('refuses sign-in routes, unknown routes and traversal', async () => {
    const { calls, run } = setup(ok);
    for (const path of [
      '/bff/auth/admin/login',
      '/bff/auth/refresh',
      '/bff/drive/trash',
      '/bff/admin/../auth/refresh',
      '/bff/admin/users/%2e%2e',
      '/bff/admin//users',
    ]) {
      const response = await run(path, {
        method: path.includes('auth') ? 'POST' : 'GET',
        headers: { cookie: session, origin: ORIGIN },
      });
      expect(response.status, path).toBe(404);
    }
    expect(calls).toHaveLength(0);
    expect(unsafePathReason('/admin/users/..')).toBe('dot segment');
  });

  it('refuses cross-origin mutations and requests without a session', async () => {
    const { calls, run } = setup(ok);
    const cross = await run(`/bff/admin/users/${USER_ID}`, {
      method: 'PATCH',
      headers: { cookie: session, origin: 'https://evil.example' },
      body: JSON.stringify({ status: 'disabled' }),
    });
    expect(cross.status).toBe(403);
    const anonymous = await run('/bff/admin/users');
    expect(anonymous.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('forwards a well-formed Idempotency-Key to the cash-payment route only', async () => {
    const { calls, run } = setup(ok);
    await run('/bff/admin/cash-payments', {
      method: 'POST',
      headers: { cookie: session, origin: ORIGIN, 'idempotency-key': 'key-1' },
      body: '{}',
    });
    await run('/bff/admin/users', {
      method: 'POST',
      headers: { cookie: session, origin: ORIGIN, 'idempotency-key': 'key-2' },
      body: '{}',
    });
    expect((calls[0]!.init.headers as Record<string, string>)['idempotency-key']).toBe('key-1');
    expect((calls[1]!.init.headers as Record<string, string>)['idempotency-key']).toBeUndefined();
  });

  it('clears the session when the API says it is over (disabled admin, no MFA)', async () => {
    for (const code of ['ACCOUNT_DISABLED', 'MFA_REQUIRED', 'UNAUTHENTICATED']) {
      const { run } = setup(
        () =>
          new Response(JSON.stringify({ code, message: code }), {
            status: code === 'ACCOUNT_DISABLED' ? 403 : 401,
            headers: { 'content-type': 'application/json' },
          }),
      );
      const response = await run('/bff/admin/users', { headers: { cookie: session } });
      const cookies = response.headers.getSetCookie();
      expect(cookies, code).toHaveLength(2);
      for (const c of cookies) expect(c).toContain('Max-Age=0');
    }
    const { run } = setup(
      () => new Response(JSON.stringify({ code: 'LAST_ADMIN', message: 'x' }), { status: 409 }),
    );
    const response = await run(`/bff/admin/users/${USER_ID}`, {
      method: 'PATCH',
      headers: { cookie: session, origin: ORIGIN },
      body: '{"status":"disabled"}',
    });
    expect(response.status).toBe(409);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe('client IP', () => {
  it('takes the last X-Forwarded-For entry, normalized', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '1.1.1.1, 203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '::ffff:10.0.0.1' }))).toBe(
      '10.0.0.1',
    );
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': 'garbage' }))).toBeNull();
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });
});
