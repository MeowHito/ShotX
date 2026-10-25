// @vitest-environment node
import { DRIVE_ROUTES, UPLOAD_ROUTES } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AuthProvider } from '../auth/provider';
import { cookieNames, encodeJsonCookie } from '../auth/session';
import { type BffDeps, handleBffRequest, matchRoute } from './handler';

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
});
