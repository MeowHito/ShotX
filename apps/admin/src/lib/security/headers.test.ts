import { describe, expect, it } from 'vitest';
import { buildCsp, ROBOTS_HEADER_VALUE, securityHeaders } from './headers';

describe('admin security headers', () => {
  const csp = buildCsp({ nonce: 'abc', isDev: false, https: true });

  it('allows only same-origin scripts with the nonce and nothing from other origins', () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("img-src 'self' data:");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/https?:\/\//);
  });

  it('allows eval and websockets only in development', () => {
    const dev = buildCsp({ nonce: 'n', isDev: true, https: false });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain('ws:');
    expect(dev).not.toContain('upgrade-insecure-requests');
  });

  it('is never indexed or framed', () => {
    const headers = securityHeaders(csp, true);
    expect(headers['X-Robots-Tag']).toBe(ROBOTS_HEADER_VALUE);
    expect(ROBOTS_HEADER_VALUE).toContain('noindex');
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Strict-Transport-Security']).toBeDefined();
    expect(securityHeaders(csp, false)['Strict-Transport-Security']).toBeUndefined();
  });
});
