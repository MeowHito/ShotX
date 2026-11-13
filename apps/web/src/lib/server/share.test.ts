// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { clientBillingConfig, clientFaceConfig, clientShareConfig } from './config';
import { fetchShareMeta, shareOpenGraph } from './share';

const API = 'http://internal-alb';

function serverFetch(fake: FakeApi) {
  // The fake serves `/api/...`; strip the internal origin like the ALB would route it.
  return vi.fn<typeof fetch>((input, init) => fake.fetch((input as string).replace(API, ''), init));
}

describe('SSR share meta', () => {
  it('fetches the meta from the internal API with only the anon cookie', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const fetch = serverFetch(fake);
    const anonId = '3b241101-e2bb-4255-8caf-4136c566a962';
    const result = await fetchShareMeta(share.token, { apiInternalUrl: API, anonId, fetch });
    expect(result).toMatchObject({ kind: 'ok', meta: { details: { title: share.title } } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/api/s/${share.token}`);
    expect((init?.headers as Record<string, string>).cookie).toBe(`shotx_anon=${anonId}`);
    expect((init?.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the BFF key and the viewer\u2019s address, and nothing malformed', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const fetch = serverFetch(fake);
    const bffKey = 'k'.repeat(40);
    const call = (context?: { bffKey: string | null; clientIp: string | null }) =>
      fetchShareMeta(share.token, { apiInternalUrl: API, context, fetch });
    await call({ bffKey, clientIp: '203.0.113.10' });
    await call({ bffKey, clientIp: 'x\r\nevil' });
    await call({ bffKey: null, clientIp: '203.0.113.10' });
    await call();
    const sent = fetch.mock.calls.map(([, init]) => {
      const headers = init?.headers as Record<string, string>;
      return [headers['x-shotx-bff-key'], headers['x-shotx-client-ip']];
    });
    expect(sent).toEqual([
      [bffKey, '203.0.113.10'],
      [bffKey, undefined],
      [undefined, undefined],
      [undefined, undefined],
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init?.headers as Record<string, string>).not.toHaveProperty(
        'cloudfront-viewer-address',
      );
    }
  });

  it('never forwards a malformed anon cookie', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const fetch = serverFetch(fake);
    await fetchShareMeta(share.token, { apiInternalUrl: API, anonId: 'x; shotx_vs=evil', fetch });
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).cookie).toBeUndefined();
  });

  it('resolves a slug URL (ADR 0011), decoded once and canonical, and returns the token and path', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ title: 'งานวิ่ง กรุงเทพ 2026' });
    expect(share.slug).toBe('งานวิ่ง-กรุงเทพ-2026');
    const fetch = serverFetch(fake);
    // Next may hand the param over still percent-encoded, or decoded.
    for (const raw of [encodeURIComponent(share.slug ?? ''), share.slug ?? '']) {
      const result = await fetchShareMeta(raw, { apiInternalUrl: API, fetch });
      expect(result).toMatchObject({
        kind: 'ok',
        meta: {
          token: share.token,
          slug: share.slug,
          path: `/${encodeURIComponent(share.slug ?? '')}`,
        },
      });
    }
    // Encoded exactly once on the way to the API.
    expect(fetch.mock.calls[0]?.[0]).toBe(`${API}/api/s/${encodeURIComponent(share.slug ?? '')}`);
    const upper = await fetchShareMeta('Bangkok-Marathon-2026', { apiInternalUrl: API, fetch });
    expect(upper.kind).toBe('not_found');
    const en = fake.addPublicShare({ title: 'Bangkok Run' });
    await expect(
      fetchShareMeta('Bangkok-Run', { apiInternalUrl: API, fetch }),
    ).resolves.toMatchObject({ kind: 'ok', meta: { token: en.token } });
  });

  it('maps NOT_FOUND, malformed tokens and SHARE_EXPIRED reasons', async () => {
    const fake = new FakeApi();
    const fetch = serverFetch(fake);
    await expect(fetchShareMeta('A'.repeat(22), { apiInternalUrl: API, fetch })).resolves.toEqual({
      kind: 'not_found',
    });
    await expect(fetchShareMeta('../../admin', { apiInternalUrl: API, fetch })).resolves.toEqual({
      kind: 'not_found',
    });
    for (const reason of ['revoked', 'expired', 'unavailable'] as const) {
      const share = fake.addPublicShare({ expiredReason: reason });
      await expect(fetchShareMeta(share.token, { apiInternalUrl: API, fetch })).resolves.toEqual({
        kind: 'expired',
        reason,
      });
    }
  });

  it('uses the cover preview as OG image in gallery mode only', async () => {
    const fake = new FakeApi();
    const fetch = serverFetch(fake);
    const gallery = fake.addPublicShare();
    const faceOnly = fake.addPublicShare({ mode: 'face_only', faceSearchAvailable: true });
    const g = await fetchShareMeta(gallery.token, { apiInternalUrl: API, fetch });
    const f = await fetchShareMeta(faceOnly.token, { apiInternalUrl: API, fetch });
    if (g.kind !== 'ok' || f.kind !== 'ok') throw new Error('expected meta');
    expect(shareOpenGraph(g.meta, 'ShotX')).toEqual({
      title: gallery.title,
      images: [{ url: gallery.items[0]?.previewUrl, width: 6000, height: 4000 }],
    });
    expect(shareOpenGraph(f.meta, 'ShotX').images).toEqual([]);
    // Locked shares reveal no title.
    const locked = fake.addPublicShare({ password: 'secret' });
    const l = await fetchShareMeta(locked.token, { apiInternalUrl: API, fetch });
    if (l.kind !== 'ok') throw new Error('expected meta');
    expect(shareOpenGraph(l.meta, 'ShotX')).toEqual({ title: 'ShotX', images: [] });
  });
});

describe('client config', () => {
  it('defaults to self-hosted MediaPipe assets; selfie limits are not read from web env', () => {
    const config = clientFaceConfig({});
    expect(config.detector).toEqual({
      wasmBasePath: '/mediapipe/dist',
      modelPath: '/mediapipe/blaze_face_short_range.tflite',
    });
    // FACE_MAX_SELFIES, FACE_SELFIE_* come from share meta.
    expect(Object.keys(clientFaceConfig({ FACE_SELFIE_LONG_EDGE: '1024' })).sort()).toEqual([
      'cameraZoom',
      'captcha',
      'detector',
      'gate',
    ]);
    expect(clientFaceConfig({}).cameraZoom).toBe(1.4);
    expect(clientFaceConfig({ WEB_FACE_CAMERA_ZOOM: '1' }).cameraZoom).toBe(1);
    expect(() => clientFaceConfig({ WEB_FACE_CAMERA_ZOOM: '0.5' })).toThrow();
  });

  it('passes only the public Turnstile settings to the share page', () => {
    expect(clientFaceConfig({}).captcha).toEqual({ provider: 'waf' });
    const config = clientFaceConfig({
      CAPTCHA_PROVIDER: 'turnstile',
      TURNSTILE_SITE_KEY: '0x4AAAAAAABkMYinukE8nzYS',
      TURNSTILE_SECRET_KEY: '0x4AAAAAAABkMYinukE8nzYS_secret_value',
    });
    expect(config.captcha).toEqual({
      provider: 'turnstile',
      siteKey: '0x4AAAAAAABkMYinukE8nzYS',
      scriptUrl: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    });
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  it('rejects CDN or cross-origin asset locations', () => {
    for (const value of [
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm',
      '//cdn.example.com/wasm',
      'mediapipe/dist',
      '/mediapipe/../../etc',
    ]) {
      expect(() => clientFaceConfig({ FACE_DETECTOR_WASM_BASE_PATH: value }), value).toThrow();
    }
  });

  it('reads the download tunables (ZIP_MAX_FILES comes from share meta, not env)', () => {
    expect(clientShareConfig({ ZIP_MAX_FILES: '50', WEB_ZIP_POLL_INTERVAL_MS: '1500' })).toEqual({
      zipPollIntervalMs: 1500,
      zipPollTimeoutMs: 900_000,
      iosShareMaxFiles: 20,
      photoPrefetchConcurrency: 3,
      downloadGapMs: 400,
      livePollMs: 15_000,
    });
  });

  it('reads the billing poll interval', () => {
    expect(clientBillingConfig({})).toEqual({ paymentPollIntervalMs: 3000 });
    expect(clientBillingConfig({ WEB_BILLING_POLL_INTERVAL_MS: '1000' })).toEqual({
      paymentPollIntervalMs: 1000,
    });
    expect(() => clientBillingConfig({ WEB_BILLING_POLL_INTERVAL_MS: '10' })).toThrow();
  });
});
