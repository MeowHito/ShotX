import { DRIVE_ROUTES, UPLOAD_ROUTES } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildUrl, createApiClient } from './client';
import { ApiError, ContractError, NetworkError } from './errors';

const usage = {
  usedBytes: 1,
  reservedBytes: 0,
  quotaBytes: 10,
  availableBytes: 9,
  trashBytes: 0,
  subscription: null,
  uploadsBlockedBy: null,
};

function respond(status: number, body?: unknown) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

describe('api client', () => {
  it('builds paths from the shared routes and skips empty query values', async () => {
    const fetch = respond(200, { folder: null, ancestors: [], items: [], nextCursor: null });
    const api = createApiClient({ baseUrl: '/bff', fetch });
    await api.call(DRIVE_ROUTES.listChildren, {
      params: { id: 'root' },
      query: { cursor: 'abc', sort: undefined },
    });
    expect(fetch).toHaveBeenCalledWith(
      '/bff/drive/folders/root/children?cursor=abc',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
    expect(buildUrl('/bff', '/x', { a: 1, b: null })).toBe('/bff/x?a=1');
  });

  it('sends JSON bodies and parses responses with the route schema', async () => {
    const fetch = respond(200, usage);
    const api = createApiClient({ baseUrl: '/bff', fetch });
    await expect(api.call(DRIVE_ROUTES.usage)).resolves.toEqual(usage);

    const post = respond(200, { items: [] });
    await createApiClient({ baseUrl: '/bff', fetch: post }).call(DRIVE_ROUTES.restoreItems, {
      body: { items: [{ kind: 'file', id: '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c' }] },
    });
    const init = post.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      items: [{ kind: 'file', id: '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c' }],
    });
  });

  it('returns undefined for 204', async () => {
    const api = createApiClient({ baseUrl: '/bff', fetch: respond(204) });
    await expect(
      api.call(UPLOAD_ROUTES.abort, { params: { id: '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c' } }),
    ).resolves.toBeUndefined();
  });

  it('throws ApiError with code and details', async () => {
    const api = createApiClient({
      baseUrl: '/bff',
      fetch: respond(409, {
        code: 'NAME_TAKEN',
        message: 'taken',
        details: { kind: 'folder', name: 'a' },
      }),
    });
    const error = await api.call(DRIVE_ROUTES.usage).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'NAME_TAKEN',
      details: { kind: 'folder', name: 'a' },
    });
  });

  it('throws ContractError for bodies outside the contract', async () => {
    await expect(
      createApiClient({ baseUrl: '/bff', fetch: respond(200, { nope: true }) }).call(
        DRIVE_ROUTES.usage,
      ),
    ).rejects.toBeInstanceOf(ContractError);
    await expect(
      createApiClient({ baseUrl: '/bff', fetch: respond(500, '<html>') }).call(DRIVE_ROUTES.usage),
    ).rejects.toBeInstanceOf(ContractError);
  });

  it('throws NetworkError when fetch fails', async () => {
    const api = createApiClient({
      baseUrl: '/bff',
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(api.call(DRIVE_ROUTES.usage)).rejects.toBeInstanceOf(NetworkError);
  });
});
