// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { fetchPlans } from './billing';

const API = 'http://internal-alb';

describe('SSR plans (/pricing)', () => {
  it('reads GET /plans from the internal API and forwards the viewer address', async () => {
    const fake = new FakeApi();
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) =>
      fake.fetch((input as string).replace(API, ''), init),
    );
    const plans = await fetchPlans({
      apiInternalUrl: API,
      viewerAddress: '203.0.113.10:51234',
      fetch,
    });
    expect(plans?.plans.map((p) => p.code)).toEqual(['starter', 'standard', 'pro', 'studio']);
    expect(plans?.currency).toBe('THB');
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${API}/api/plans`);
    expect((init?.headers as Record<string, string>)['cloudfront-viewer-address']).toBe(
      '203.0.113.10:51234',
    );
  });

  it('returns null when the API fails (the page shows an error, never made-up prices)', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.reject(new Error('down')));
    await expect(fetchPlans({ apiInternalUrl: API, fetch })).resolves.toBeNull();
  });
});
