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

  it('forwards the CloudFront-Viewer-Address it received, and nothing malformed', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const fetch = serverFetch(fake);
    const viewerAddress = '203.0.113.10:51234';
    await fetchShareMeta(share.token, { apiInternalUrl: API, viewerAddress, fetch });
    await fetchShareMeta(share.token, { apiInternalUrl: API, viewerAddress: 'x\r\nevil', fetch });
    await fetchShareMeta(share.token, { apiInternalUrl: API, fetch });
    const sent = fetch.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>)['cloudfront-viewer-address'],
    );
    expect(sent).toEqual([viewerAddress, undefined, undefined]);
  });

  it('never forwards a malformed anon cookie', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const fetch = serverFetch(fake);
    await fetchShareMeta(share.token, { apiInternalUrl: API, anonId: 'x; shotx_vs=evil', fetch });
    expect((fetch.mock.calls[0]?.[1]?.headers as Record<string, string>).cookie).toBeUndefined();
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
      'detector',
      'gate',
    ]);
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
