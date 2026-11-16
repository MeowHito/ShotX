import { BFF_CLIENT_IP_HEADER, BFF_KEY_HEADER } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { urlOf } from '../../../test/fetch';
import { createAdminAuthApi, RefreshCache, refreshReuseWindowMs } from './admin-auth-api';

const KEY = 'k'.repeat(40);
const TOKENS = {
  accessToken: 'a.b.c',
  refreshToken: 'n'.repeat(43),
  expiresIn: 900,
  refreshExpiresIn: 43_200,
  user: { email: 'a@b.co', name: null },
};

describe('admin sign-in API calls', () => {
  it('call the contract routes with the BFF key and the admins pool', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: urlOf(input), init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify(TOKENS), { headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;
    const api = createAdminAuthApi({
      apiInternalUrl: 'http://api:4000',
      client: { callTimeoutMs: 5000, refreshReuseGraceSeconds: 10 },
      context: { bffKey: KEY, clientIp: '198.51.100.4' },
      fetch: fetchImpl,
      refreshCache: new RefreshCache(0),
    });
    await api.refresh('o'.repeat(43));
    await api.mfa({ challengeId: 'c'.repeat(43), code: '123456' });
    expect(calls.map((c) => c.url)).toEqual([
      'http://api:4000/api/auth/refresh',
      'http://api:4000/api/auth/admin/mfa',
    ]);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      refreshToken: 'o'.repeat(43),
      pool: 'admins',
    });
    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers[BFF_KEY_HEADER]).toBe(KEY);
    expect(headers[BFF_CLIENT_IP_HEADER]).toBe('198.51.100.4');
  });
});

describe('providers', () => {
  it('reads the admin MFA mode with the admin BFF key', async () => {
    const answer = {
      oidc: [],
      devLogin: false,
      adminLogin: true,
      adminMfaMode: 'off',
      passwordReset: false,
    };
    const calls: string[] = [];
    const fetchImpl = vi.fn((input: RequestInfo | URL) => {
      calls.push(urlOf(input));
      return Promise.resolve(
        new Response(JSON.stringify(answer), { headers: { 'content-type': 'application/json' } }),
      );
    }) as unknown as typeof fetch;
    const api = createAdminAuthApi({
      apiInternalUrl: 'http://api:4000',
      client: { callTimeoutMs: 5000, refreshReuseGraceSeconds: 10 },
      context: { bffKey: KEY, clientIp: null },
      fetch: fetchImpl,
      refreshCache: new RefreshCache(0),
    });
    expect((await api.providers()).adminMfaMode).toBe('off');
    expect(calls).toEqual(['http://api:4000/api/auth/providers']);
  });
});

describe('RefreshCache', () => {
  it('shares one rotation between concurrent callers', async () => {
    const cache = new RefreshCache(9000);
    const rotate = vi.fn(() => Promise.resolve(TOKENS));
    const [a, b] = await Promise.all([cache.run('t', rotate), cache.run('t', rotate)]);
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it('stays inside the API grace', () => {
    expect(refreshReuseWindowMs(10)).toBe(9000);
    expect(refreshReuseWindowMs(0)).toBe(0);
  });
});
