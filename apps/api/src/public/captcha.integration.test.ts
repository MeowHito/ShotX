import { FakeFaceProvider } from '@shotx/face/testing';
import {
  apiPath,
  CAPTCHA_TOKEN_HEADER,
  PUBLIC_SHARE_ROUTES as P,
  rateLimitedDetailsSchema,
} from '@shotx/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloudFrontOriginHeaders } from '../http/client';
import { openPglite, type TestDatabase } from '../testing/database';
import { eventPhoto, indexPhoto, selfie, testWorld } from '../testing/faces';
import { type Browser, TestApi, type TestResponse } from '../testing/harness';
import { FakeCaptchaVerifier, TurnstileVerifier } from './captcha';

// Turnstile after a FACE_SEARCH_RATE_* hit (ADR 0008 section 7). Face deletion needs no index, so
// most cases use it; one case checks face search's action.

const world = testWorld();
const VERSION = '2026-10-25';
const deletion = (token: string) => apiPath(P.faceDeletion, { token });
const search = (token: string) => apiPath(P.faceSearch, { token });
const consent = (token: string) => apiPath(P.giveConsent, { token });
const SECRET = '0x4AAAAAAAtest-secret-not-a-cloudflare-test-key';

function form(bytes: Buffer, type = 'image/jpeg'): FormData {
  const f = new FormData();
  f.append('selfie', new Blob([new Uint8Array(bytes)], { type }), 'selfie.jpg');
  return f;
}

describe('Turnstile after a face-search rate-limit hit (CAPTCHA_PROVIDER=turnstile)', () => {
  let database: TestDatabase;
  let api: TestApi;
  const verifier = new FakeCaptchaVerifier();
  const provider = new FakeFaceProvider(world);

  beforeAll(async () => {
    database = await openPglite();
    api = await TestApi.start(database.db, {
      faceProvider: provider,
      captchaVerifier: verifier,
      env: {
        FACE_SEARCH_ENABLED: 'true',
        FACE_SEARCH_RATE_PER_VIEWER: '1',
        FACE_SEARCH_RATE_PER_IP: '100',
        CAPTCHA_PROVIDER: 'turnstile',
        TURNSTILE_SECRET_KEY: SECRET,
        CAPTCHA_GRANT_ATTEMPTS: '2',
        CAPTCHA_GRANT_TTL_SECONDS: '120',
        CAPTCHA_GRANTS_PER_IP: '3',
        CAPTCHA_GRANTS_PER_IP_WINDOW_SECONDS: '3600',
      },
    });
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  let ip = 1;
  /** A browser with its own client address (CloudFront-Viewer-Address on the AWS-style config). */
  async function viewer(share: { token: string }, address = `203.0.113.${ip++}`) {
    const b = api.browser();
    Object.assign(b.headers, cloudFrontOriginHeaders(`${address}:443`));
    for (const purpose of ['face_search', 'face_deletion'] as const) {
      const res = await b.request('POST', consent(share.token), {
        body: { purpose, policyVersion: VERSION, accepted: true },
      });
      expect(res.status).toBe(200);
    }
    return { b, address };
  }

  async function share() {
    const owner = await api.photographer();
    const folder = await api.folder(owner.id);
    return api.share(owner.id, { folderId: folder.id });
  }

  const del = async (b: Browser, token: string, captcha?: string): Promise<TestResponse> =>
    b.request('POST', deletion(token), {
      form: form(await selfie(world, 'alice')),
      ...(captcha === undefined ? {} : { headers: { [CAPTCHA_TOKEN_HEADER]: captcha } }),
    });

  const details = (res: TestResponse) => {
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ code: 'RATE_LIMITED' });
    const d = rateLimitedDetailsSchema.parse((res.body as { details: unknown }).details);
    expect(String(d.retryAfterSeconds)).toBe(res.headers.get('retry-after'));
    return d;
  };

  it('ignores a token under the limit; over it asks for a challenge', async () => {
    const s = await share();
    const { b } = await viewer(s);
    const calls = verifier.calls.length;
    expect((await del(b, s.token, 'ignored-token')).status).toBe(202);
    expect(verifier.calls.length).toBe(calls);
    const d = details(await del(b, s.token));
    expect(d.captcha).toEqual({ provider: 'turnstile', action: 'face_deletion', rejected: null });
    expect(d.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('rejects invalid, expired and unavailable tokens (fail closed, no grant)', async () => {
    const s = await share();
    const { b } = await viewer(s);
    expect((await del(b, s.token)).status).toBe(202);
    for (const reason of ['invalid', 'expired', 'unavailable'] as const) {
      verifier.rejectWith = reason;
      const d = details(await del(b, s.token, `bad-${reason}`));
      expect(d.captcha).toEqual({
        provider: 'turnstile',
        action: 'face_deletion',
        rejected: reason,
      });
    }
    verifier.rejectWith = 'invalid';
    // A malformed header is invalid without a siteverify call.
    const calls = verifier.calls.length;
    const d = details(await del(b, s.token, 'has space'));
    expect(d.captcha?.rejected).toBe('invalid');
    expect(verifier.calls.length).toBe(calls);
    // Still limited without a token: nothing was granted.
    expect(details(await del(b, s.token)).captcha?.rejected).toBeNull();
  });

  it('grants CAPTCHA_GRANT_ATTEMPTS for the share, viewer and IP after a passed token', async () => {
    const s = await share();
    const { b, address } = await viewer(s);
    expect((await del(b, s.token)).status).toBe(202);
    details(await del(b, s.token));
    verifier.valid.add('good-1');
    expect((await del(b, s.token, 'good-1')).status).toBe(202); // attempt 1 of 2
    expect(verifier.calls.at(-1)).toEqual({
      token: 'good-1',
      remoteIp: address,
      action: 'face_deletion',
    });
    expect((await del(b, s.token)).status).toBe(202); // attempt 2, no token needed
    expect(details(await del(b, s.token)).captcha?.rejected).toBeNull(); // used up
    // The grant is bound to this viewer: another browser on the same IP is still limited.
    const other = await viewer(s, address);
    expect((await del(other.b, s.token)).status).toBe(202);
    expect(details(await del(other.b, s.token)).captcha).not.toBeNull();
    // Grants live in Redis under the api prefix with a TTL, keyed by hashes only.
    const grants = api.store.keys().filter((k) => k.startsWith('captcha-grant:'));
    expect(grants.length).toBeGreaterThan(0);
    for (const key of grants) {
      expect(key).toMatch(/^captcha-grant:[0-9a-f]{64}$/);
      expect(api.store.ttlSeconds(key)).toBeLessThanOrEqual(120);
    }
  });

  it('expires an unused grant after CAPTCHA_GRANT_TTL_SECONDS', async () => {
    const s = await share();
    const { b } = await viewer(s);
    expect((await del(b, s.token)).status).toBe(202);
    verifier.valid.add('good-2');
    expect((await del(b, s.token, 'good-2')).status).toBe(202);
    api.clock.advance(121_000);
    // The viewer window (10 min) is still full; the grant is gone.
    expect(details(await del(b, s.token)).captcha?.rejected).toBeNull();
  });

  it('caps grants per client IP (then captcha: null, no siteverify)', async () => {
    const address = '203.0.113.250';
    for (let i = 0; i < 3; i++) {
      const s = await share();
      const { b } = await viewer(s, address);
      expect((await del(b, s.token)).status).toBe(202);
      verifier.valid.add(`cap-${i}`);
      expect((await del(b, s.token, `cap-${i}`)).status).toBe(202);
    }
    const s = await share();
    const { b } = await viewer(s, address);
    expect((await del(b, s.token)).status).toBe(202);
    const calls = verifier.calls.length;
    verifier.valid.add('cap-x');
    const d = details(await del(b, s.token, 'cap-x'));
    expect(d.captcha).toBeNull();
    expect(verifier.calls.length).toBe(calls);
    verifier.valid.delete('cap-x');
  });

  it('never reads the selfies of a rejected request', async () => {
    const s = await share();
    const { b } = await viewer(s);
    expect((await del(b, s.token)).status).toBe(202);
    const before = provider.calls.searchFacesByImage;
    // A body that would fail validation if read (not an image): the answer is still 429.
    const res = await b.request('POST', deletion(s.token), {
      form: form(Buffer.from('not a picture'), 'text/plain'),
      headers: { [CAPTCHA_TOKEN_HEADER]: 'bad-token' },
    });
    expect(details(res).captcha?.rejected).toBe('invalid');
    expect(provider.calls.searchFacesByImage).toBe(before);
  });

  it('uses the face_search action on face search', async () => {
    const owner = await api.photographer();
    const folder = await api.folder(owner.id, { faceIndex: true });
    const file = await api.file(owner.id, folder.id);
    await indexPhoto(
      api.db,
      provider,
      owner.id,
      file.id,
      await eventPhoto(world, [{ personId: 'alice', size: 220 }]),
    );
    const s = await api.share(owner.id, { folderId: folder.id });
    const { b } = await viewer(s);
    const scan = () =>
      b.request('POST', search(s.token), { form: form(Buffer.alloc(0), 'image/jpeg') });
    // The first scan passes the limits (its empty selfie is then refused by validation).
    expect((await scan()).status).not.toBe(429);
    expect(details(await scan()).captcha).toEqual({
      provider: 'turnstile',
      action: 'face_search',
      rejected: null,
    });
  });
});

describe('RATE_LIMITED details with CAPTCHA_PROVIDER=waf (AWS stacks)', () => {
  let database: TestDatabase;
  let api: TestApi;

  beforeAll(async () => {
    database = await openPglite();
    api = await TestApi.start(database.db, { env: { FACE_SEARCH_RATE_PER_VIEWER: '1' } });
  }, 120_000);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('answers captcha: null and never verifies a token', async () => {
    const owner = await api.photographer();
    const folder = await api.folder(owner.id);
    const s = await api.share(owner.id, { folderId: folder.id });
    const b = api.browser();
    await b.request('POST', consent(s.token), {
      body: { purpose: 'face_deletion', policyVersion: VERSION, accepted: true },
    });
    const del = async () =>
      b.request('POST', deletion(s.token), {
        form: form(await selfie(world, 'alice')),
        headers: { [CAPTCHA_TOKEN_HEADER]: 'some-token' },
      });
    expect((await del()).status).toBe(202);
    const res = await del();
    expect(res.status).toBe(429);
    const d = rateLimitedDetailsSchema.parse((res.body as { details: unknown }).details);
    expect(d.captcha).toBeNull();
  });
});

describe('TurnstileVerifier (siteverify)', () => {
  const config = {
    provider: 'turnstile' as const,
    secretKey: SECRET,
    verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    verifyTimeoutMs: 1000,
    expectedHostname: 'photos.example.com',
    testKey: false,
    grant: { attempts: 5, ttlSeconds: 600, perIp: 10, perIpWindowSeconds: 3600 },
  };
  const ok = { success: true, hostname: 'photos.example.com', action: 'face_search' };

  function fake(answers: (Response | Error)[]) {
    const calls: { url: string; form: URLSearchParams; signal: boolean }[] = [];
    const fetch = (url: string, init: RequestInit) => {
      calls.push({
        url,
        form: new URLSearchParams(typeof init.body === 'string' ? init.body : ''),
        signal: init.signal instanceof AbortSignal,
      });
      const next = answers.shift() ?? new Error('no more answers');
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    };
    return { calls, fetch };
  }

  it('posts secret, token, remoteip and an idempotency key with a timeout', async () => {
    const { calls, fetch } = fake([Response.json(ok)]);
    const v = new TurnstileVerifier(config, fetch);
    await expect(
      v.verify({ token: 'tok', remoteIp: '203.0.113.9', action: 'face_search' }),
    ).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(config.verifyUrl);
    expect(Object.fromEntries(calls[0]?.form ?? [])).toMatchObject({
      secret: SECRET,
      response: 'tok',
      remoteip: '203.0.113.9',
    });
    expect(calls[0]?.form.get('idempotency_key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.signal).toBe(true);
  });

  it('retries a network error once with the same idempotency key, then fails closed', async () => {
    const retried = fake([new TypeError('fetch failed'), Response.json(ok)]);
    await expect(
      new TurnstileVerifier(config, retried.fetch).verify({
        token: 't',
        remoteIp: '203.0.113.9',
        action: 'face_search',
      }),
    ).resolves.toEqual({ ok: true });
    expect(retried.calls).toHaveLength(2);
    expect(retried.calls[1]?.form.get('idempotency_key')).toBe(
      retried.calls[0]?.form.get('idempotency_key'),
    );
    const down = fake([new TypeError('fetch failed'), new TypeError('fetch failed')]);
    await expect(
      new TurnstileVerifier(config, down.fetch).verify({
        token: 't',
        remoteIp: '203.0.113.9',
        action: 'face_search',
      }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(down.calls).toHaveLength(2);
    // An HTTP error is an answer: no retry.
    const http = fake([new Response('oops', { status: 500 })]);
    await expect(
      new TurnstileVerifier(config, http.fetch).verify({
        token: 't',
        remoteIp: '203.0.113.9',
        action: 'face_search',
      }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
    expect(http.calls).toHaveLength(1);
  });

  it('checks hostname and action, and maps error codes', async () => {
    const verify = (body: unknown, action: 'face_search' | 'face_deletion' = 'face_search') =>
      new TurnstileVerifier(config, fake([Response.json(body)]).fetch).verify({
        token: 't',
        remoteIp: '203.0.113.9',
        action,
      });
    await expect(verify({ ...ok, hostname: 'evil.example' })).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    });
    await expect(verify(ok, 'face_deletion')).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(
      verify({ success: false, 'error-codes': ['timeout-or-duplicate'] }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
    await expect(
      verify({ success: false, 'error-codes': ['invalid-input-secret'] }),
    ).resolves.toEqual({ ok: false, reason: 'unavailable' });
  });
});
