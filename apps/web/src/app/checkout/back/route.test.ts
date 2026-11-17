// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// ADR 0029: mPAY's card form comes back with a GET or a POST; both go to the return page.

vi.mock('@/lib/server/packages', () => ({
  packageOrderDeps: () => ({ auth: { publicBaseUrl: 'https://snap.example.test' } }),
}));

const { GET, POST } = await import('./route');

describe('/checkout/back', () => {
  it('answers 303 to /checkout/return for GET and POST, reading nothing', () => {
    for (const handler of [GET, POST]) {
      const response = handler(
        new Request('https://snap.example.test/checkout/back?status=SUCCESS', {
          method: handler === GET ? 'GET' : 'POST',
          ...(handler === POST ? { body: 'status=SUCCESS&order_id=x' } : {}),
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('https://snap.example.test/checkout/return');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});
