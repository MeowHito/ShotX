// @vitest-environment node
import { BFF_CLIENT_IP_HEADER, BFF_KEY_HEADER } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import {
  clientIpFromHeaders,
  normalizeClientIp,
  SERVER_CALL_HEADERS,
  serverCallHeaders,
} from './client-ip';

const KEY = 'k'.repeat(40);

describe('client IP', () => {
  it('normalizes what the API accepts and rejects anything else', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeClientIp(' 2001:db8::1 ')).toBe('2001:db8::1');
    expect(normalizeClientIp('[2001:db8::1]')).toBe('2001:db8::1');
    expect(normalizeClientIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeClientIp('::ffff:198.51.100.4')).toBe('198.51.100.4');
    for (const bad of ['', 'unknown', '203.0.113.7:443', '999.1.1.1', '1.2.3.4\r\nx: y', '01.2.3.4']) {
      expect(normalizeClientIp(bad), bad).toBeNull();
    }
  });

  it('reads the proxy’s X-Forwarded-For on the VPS (last entry), nothing when absent', () => {
    const xff = (value: string) => new Headers({ 'x-forwarded-for': value });
    expect(clientIpFromHeaders(xff('203.0.113.7'), 'x-forwarded-for')).toBe('203.0.113.7');
    // Even a proxy that appended: the last hop is the proxy's own peer, never the client's claim.
    expect(clientIpFromHeaders(xff('6.6.6.6, 203.0.113.7'), 'x-forwarded-for')).toBe('203.0.113.7');
    expect(clientIpFromHeaders(xff('203.0.113.7, garbage'), 'x-forwarded-for')).toBeNull();
    expect(clientIpFromHeaders(new Headers(), 'x-forwarded-for')).toBeNull();
    // CloudFront's header is ignored on the VPS: a client could send it through the proxy.
    expect(
      clientIpFromHeaders(
        new Headers({ 'cloudfront-viewer-address': '6.6.6.6:1' }),
        'x-forwarded-for',
      ),
    ).toBeNull();
  });

  it('reads CloudFront-Viewer-Address (ip:port) on AWS, never X-Forwarded-For', () => {
    const cf = (value: string) =>
      new Headers({ 'cloudfront-viewer-address': value, 'x-forwarded-for': '6.6.6.6' });
    expect(clientIpFromHeaders(cf('203.0.113.10:51234'), 'cloudfront-viewer-address')).toBe(
      '203.0.113.10',
    );
    expect(clientIpFromHeaders(cf('2001:db8::5:443'), 'cloudfront-viewer-address')).toBe(
      '2001:db8::5',
    );
    expect(clientIpFromHeaders(cf('203.0.113.10'), 'cloudfront-viewer-address')).toBeNull();
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': '6.6.6.6' }), 'cloudfront-viewer-address'),
    ).toBeNull();
  });

  it('sends the BFF key and the address together, and nothing without a key', () => {
    expect(serverCallHeaders({ bffKey: KEY, clientIp: '203.0.113.7' })).toEqual({
      [BFF_KEY_HEADER]: KEY,
      [BFF_CLIENT_IP_HEADER]: '203.0.113.7',
    });
    expect(serverCallHeaders({ bffKey: KEY, clientIp: null })).toEqual({ [BFF_KEY_HEADER]: KEY });
    expect(serverCallHeaders({ bffKey: KEY, clientIp: 'x\r\nevil: 1' })).toEqual({
      [BFF_KEY_HEADER]: KEY,
    });
    expect(serverCallHeaders({ bffKey: null, clientIp: '203.0.113.7' })).toEqual({});
    expect(SERVER_CALL_HEADERS).toEqual(['x-shotx-bff-key', 'x-shotx-client-ip']);
  });
});
