// @vitest-environment node
import { DRIVE_ROUTES, ME_ROUTES, UPLOAD_ROUTES } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../auth/provider';
import { cookieNames, encodeJsonCookie } from '../auth/session';
import {
  type BffDeps,
  forwardableSetCookies,
  handleBffRequest,
  matchRoute,
  unsafePathReason,
} from './handler';

const BASE = 'https://photos.example.com';
const ID = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';
const names = cookieNames(true);
const session = encodeJsonCookie({
  accessToken: 'access-token',
  expiresAt: Date.now() + 3_600_000,
  user: { sub: 's', email: null, name: null },
});

function deps(fetch: typeof globalThis.fetch): BffDeps {
  return {
    apiInternalUrl: 'http://internal-alb',
    fetch,
    auth: {
      provider: {} as AuthProvider,
      publicBaseUrl: BASE,
      secureCookies: true,
    },
  };
}

const upstream = () =>
  vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ ok: true }, { status: 201 })));

describe('BFF', () => {
  it('matches only contract routes', () => {
    expect(matchRoute('GET', '/drive/folders/root/children')).toBe(DRIVE_ROUTES.listChildren);
    expect(matchRoute('POST', `/uploads/${ID}/parts`)).toBe(UPLOAD_ROUTES.signParts);
    expect(matchRoute('GET', `/uploads/${ID}/parts`)).toBe(UPLOAD_ROUTES.listParts);
    expect(matchRoute('DELETE', `/uploads/${ID}`)).toBe(UPLOAD_ROUTES.abort);
    expect(matchRoute('GET', '/admin/metrics/revenue')).toBeNull();
    expect(matchRoute('PUT', '/drive/folders')).toBeNull();
  });

  it('forwards with the bearer token and never forwards cookies', async () => {
    const fetch = upstream();
    const response = await handleBffRequest(
      new Request(`${BASE}/bff/drive/folders`, {
        method: 'POST',
        headers: {
          origin: BASE,
          cookie: `${names.session}=${session}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ parentId: null, name: 'a' }),
      }),
      deps(fetch),
    );
    expect(response.status).toBe(201);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('http://internal-alb/api/drive/folders');
    expect(init?.headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer access-token',
      'content-type': 'application/json',
    });
    expect(init?.body).toBe('{"parentId":null,"name":"a"}');
  });

  it('keeps the query string', async () => {
    const fetch = upstream();
    await handleBffRequest(
      new Request(`${BASE}/bff/drive/folders/root/children?cursor=abc`, {
        headers: { cookie: `${names.session}=${session}` },
      }),
      deps(fetch),
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      'http://internal-alb/api/drive/folders/root/children?cursor=abc',
    );
  });

  it('answers UNAUTHENTICATED without a session', async () => {
    const fetch = upstream();
    const response = await handleBffRequest(new Request(`${BASE}/bff/drive/usage`), deps(fetch));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses cross-origin writes and unknown routes', async () => {
    const fetch = upstream();
    const crossOrigin = await handleBffRequest(
      new Request(`${BASE}/bff/drive/items/trash`, {
        method: 'POST',
        headers: { origin: 'https://evil.example', cookie: `${names.session}=${session}` },
        body: '{}',
      }),
      deps(fetch),
    );
    expect(crossOrigin.status).toBe(403);
    const unknown = await handleBffRequest(
      new Request(`${BASE}/bff/admin/system`, {
        headers: { cookie: `${names.session}=${session}` },
      }),
      deps(fetch),
    );
    expect(unknown.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes 204 through', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const response = await handleBffRequest(
      new Request(`${BASE}/bff/uploads/${ID}`, {
        method: 'DELETE',
        headers: { origin: BASE, cookie: `${names.session}=${session}` },
      }),
      deps(fetch),
    );
    expect(response.status).toBe(204);
  });

  describe('path safety (dot segments and encoded separators)', () => {
    it('rejects dot segments and encoded dots, slashes, backslashes and percents', () => {
      for (const path of [
        '/drive/..',
        '/drive/folders/./children',
        '/drive/folders/../../admin/system',
        '/drive/folders/%2e%2e/children',
        '/drive/folders/%2E/children',
        '/drive/folders/.%2e/children',
        '/drive/folders/a%2fb/children',
        '/drive/folders/..%2Fadmin/children',
        '/drive/folders/a%5Cb/children',
        '/drive/folders/%252e%252e/children',
        '/drive/folders/a\\b/children',
        '/drive//usage',
        '/drive/usage/',
        'drive/usage',
      ]) {
        expect(unsafePathReason(path), path).not.toBeNull();
      }
      expect(unsafePathReason('/drive/folders/root/children')).toBeNull();
      expect(unsafePathReason(`/drive/folders/${ID}/face-index`)).toBeNull();
      expect(unsafePathReason('/me/viewer-session')).toBeNull();
    });

    it('answers 404 before matching or forwarding a request with an unsafe path', async () => {
      const fetch = upstream();
      for (const path of [
        `/bff/drive/folders/..%2F..%2Fadmin/children`,
        `/bff/drive/folders/%2e%2e/children`,
        `/bff/uploads/${ID}%2F..%2F..%2Fdrive%2Ftrash`,
        `/bff/drive/folders/%252e%252e/children`,
        `/bff/drive/folders/root%2fchildren/children`,
      ]) {
        const response = await handleBffRequest(
          new Request(`${BASE}${path}`, { headers: { cookie: `${names.session}=${session}` } }),
          deps(fetch),
        );
        expect(response.status, path).toBe(404);
        await expect(response.json()).resolves.toMatchObject({ code: 'NOT_FOUND' });
      }
      expect(fetch).not.toHaveBeenCalled();
    });

    it('checks the raw URL even when the runtime does not normalize it', async () => {
      const fetch = upstream();
      // A Request normalizes `..` away; a raw URL string as some runtimes pass it does not.
      const request = new Request(`${BASE}/bff/drive/usage`, {
        headers: { cookie: `${names.session}=${session}` },
      });
      Object.defineProperty(request, 'url', { value: `${BASE}/bff/drive/folders/../usage` });
      const response = await handleBffRequest(request, deps(fetch));
      expect(response.status).toBe(404);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  it('does not forward public routes (the browser calls them at /api directly)', async () => {
    const fetch = upstream();
    const token = 'A'.repeat(22);
    for (const [method, path] of [
      ['GET', `/bff/s/${token}`],
      ['GET', `/bff/s/${token}/items`],
      ['DELETE', '/bff/me/viewer-session'],
    ] as const) {
      const response = await handleBffRequest(
        new Request(`${BASE}${path}`, {
          method,
          headers: { origin: BASE, cookie: `${names.session}=${session}` },
        }),
        deps(fetch),
      );
      expect(response.status, path).toBe(404);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes the viewer-session cookie (Path=/api) through from POST /me/viewer-session only', async () => {
    const upstreamHeaders = () => {
      const headers = new Headers();
      headers.append('set-cookie', 'shotx_vs=abc; Path=/api; Max-Age=43200; HttpOnly; Secure');
      headers.append('set-cookie', 'other=1; Path=/');
      headers.append('set-cookie', 'shotx_vs=evil; Path=/');
      return headers;
    };
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 204, headers: upstreamHeaders() })),
    );
    const response = await handleBffRequest(
      new Request(`${BASE}/bff/me/viewer-session`, {
        method: 'POST',
        headers: { origin: BASE, cookie: `${names.session}=${session}` },
      }),
      deps(fetch),
    );
    expect(response.status).toBe(204);
    expect(fetch.mock.calls[0]?.[0]).toBe('http://internal-alb/api/me/viewer-session');
    expect(response.headers.getSetCookie()).toEqual([
      'shotx_vs=abc; Path=/api; Max-Age=43200; HttpOnly; Secure',
    ]);
    // Any other route drops upstream cookies.
    expect(forwardableSetCookies(DRIVE_ROUTES.usage, upstreamHeaders())).toEqual([]);
    expect(forwardableSetCookies(ME_ROUTES.createViewerSession, upstreamHeaders())).toHaveLength(1);
  });
});
