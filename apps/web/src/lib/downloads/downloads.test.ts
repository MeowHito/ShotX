import { ME_ROUTES, PUBLIC_SHARE_ROUTES, type ZipJobView } from '@shotx/shared';
import { describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor } from '../../../test/render';
import { type ApiClient, createPublicApiClient } from '../api/client';
import { ApiError } from '../api/errors';
import { ClientError } from '../errors/messages';
import { createShareApi } from '../share/share-api';
import { createZipJob, fetchFilesForShare, pollZipJob } from './downloads';

const job = (status: ZipJobView['status']): ZipJobView => ({
  id: '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c',
  status,
  fileCount: 2,
  totalBytes: 2000,
  createdAt: '2026-10-25T05:00:00.000Z',
  download: null,
  availableUntil: null,
  errorCode: null,
});

const TOKEN = 'aB3dE5fG7hJ9kL1mN3pQ5r';

function stubApi(responses: ZipJobView[]): ApiClient {
  return { call: vi.fn(() => Promise.resolve(responses.shift())) } as unknown as ApiClient;
}

describe('zip polling', () => {
  const sleep = vi.fn(() => Promise.resolve());

  it('polls at the configured interval until ready', async () => {
    const ready = {
      ...job('ready'),
      download: {
        url: 'https://x/z.zip',
        fileName: 'a.zip',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    };
    const api = stubApi([job('running'), ready]);
    const updates: string[] = [];
    const result = await pollZipJob(api, TOKEN, job('queued'), {
      intervalMs: 2000,
      timeoutMs: 60_000,
      sleep,
      onUpdate: (j) => updates.push(j.status),
    });
    expect(result.download.url).toBe('https://x/z.zip');
    expect(updates).toEqual(['queued', 'running', 'ready']);
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    // Polled under the share's path (GET /s/:token/zip-jobs/:id).
    // eslint-disable-next-line @typescript-eslint/unbound-method -- a vi.fn, no `this`
    expect(api.call).toHaveBeenCalledWith(PUBLIC_SHARE_ROUTES.zipJob, {
      params: { token: TOKEN, id: job('queued').id },
      signal: undefined,
    });
    expect(PUBLIC_SHARE_ROUTES.zipJob.path).toBe('/s/:token/zip-jobs/:id');
  });

  it('fails on failed, expired and timeout with Thai-mapped client errors', async () => {
    await expect(
      pollZipJob(stubApi([job('failed')]), TOKEN, job('queued'), {
        intervalMs: 1,
        timeoutMs: 10,
        sleep,
      }),
    ).rejects.toEqual(new ClientError('client.zipFailed'));
    await expect(
      pollZipJob(stubApi([job('expired')]), TOKEN, job('queued'), {
        intervalMs: 1,
        timeoutMs: 10,
        sleep,
      }),
    ).rejects.toEqual(new ClientError('client.zipExpired'));
    let now = 0;
    await expect(
      pollZipJob(stubApi([job('running'), job('running')]), TOKEN, job('queued'), {
        intervalMs: 1,
        timeoutMs: 10,
        sleep: () => {
          now += 20;
          return Promise.resolve();
        },
        now: () => now,
      }),
    ).rejects.toEqual(new ClientError('client.zipTimeout'));
  });

  it('retries a lost create response with the same Idempotency-Key and gets the same job', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    fake.dropResponseOnce.add(PUBLIC_SHARE_ROUTES.downloads);
    const api = createPublicApiClient({ fetch: fake.fetch });
    const created = await createZipJob(
      api,
      share.token,
      share.items.slice(0, 2).map((i) => i.id),
      'key-1',
    );
    const calls = fake.callsTo(PUBLIC_SHARE_ROUTES.downloads);
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-1', 'key-1']);
    expect(fake.zipJobs.size).toBe(1);
    expect(fake.zipJobs.has(created.id)).toBe(true);
  });
});

describe('share API viewer recovery', () => {
  it('renews the viewer session (signed in) or drops the stale cookie (signed out), then retries once', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    let failures = 1;
    const flaky: typeof fetch = (input, init) => {
      if ((input as string).startsWith('/api/s/') && failures-- > 0) {
        return Promise.resolve(
          Response.json({ code: 'UNAUTHENTICATED', message: 'stale' }, { status: 401 }),
        );
      }
      return fake.fetch(input, init);
    };
    const signedIn = createShareApi({
      publicApi: createPublicApiClient({ fetch: flaky }),
      bffApi: apiClientFor(fake.fetch),
      signedIn: true,
    });
    await expect(
      signedIn.api.call(PUBLIC_SHARE_ROUTES.meta, { params: { token: share.token } }),
    ).resolves.toMatchObject({ token: share.token });
    expect(fake.callsTo(ME_ROUTES.createViewerSession)).toHaveLength(1);

    failures = 1;
    const signedOut = createShareApi({
      publicApi: createPublicApiClient({ fetch: flaky }),
      bffApi: apiClientFor(fake.fetch),
      signedIn: false,
    });
    await signedOut.api.call(PUBLIC_SHARE_ROUTES.meta, { params: { token: share.token } });
    expect(fake.callsTo(ME_ROUTES.deleteViewerSession)).toHaveLength(1);

    // A second UNAUTHENTICATED is not retried again.
    failures = 2;
    await expect(
      signedOut.api.call(PUBLIC_SHARE_ROUTES.meta, { params: { token: share.token } }),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('files for the iOS share sheet', () => {
  const R2 = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
  const fileIds = ['0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c', '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9d'];
  const api = {
    call: vi.fn((_route: unknown, options: { body: { fileIds: string[] } }) =>
      Promise.resolve({
        kind: 'file',
        file: {
          fileId: options.body.fileIds[0],
          url: `${R2}/shotx-prod-media/derived/p/${options.body.fileIds[0]}/web.jpg?X-Amz-Signature=abc`,
          fileName: `${options.body.fileIds[0]}.jpg`,
          expiresAt: '2026-10-25T05:10:00.000Z',
        },
      }),
    ),
  } as unknown as ApiClient;

  it('fetches cross-origin signed URLs as plain CORS GETs without credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('x', { headers: { 'content-type': 'image/jpeg' } })),
    );
    const progress = vi.fn();
    const files = await fetchFilesForShare(api, TOKEN, fileIds, progress, fetch);
    expect(files.map((f) => f.name)).toEqual(fileIds.map((id) => `${id}.jpg`));
    expect(files[0]?.type).toBe('image/jpeg');
    expect(progress).toHaveBeenLastCalledWith(2);
    for (const [url, init] of fetch.mock.calls) {
      expect((url as string).startsWith(`${R2}/`)).toBe(true);
      // No headers: a simple request, so the bucket needs no preflight rule for GET.
      expect(init).toEqual({ credentials: 'omit', mode: 'cors' });
    }
  });

  it('fails with a Thai save error when the storage refuses (e.g. CORS or expiry)', async () => {
    const refused = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response('', { status: 403 })),
    );
    await expect(fetchFilesForShare(api, TOKEN, fileIds, vi.fn(), refused)).rejects.toEqual(
      new ClientError('client.saveFailed'),
    );
  });
});
