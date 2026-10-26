import { describe, expect, it } from 'vitest';
import { isIpAddress, isTrustedProxy, loadTrustedProxyConfig } from './proxy';

describe('loadTrustedProxyConfig', () => {
  it('defaults to trusting nobody', () => {
    expect(loadTrustedProxyConfig({})).toEqual({ addresses: [] });
    expect(loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: '' })).toEqual({ addresses: [] });
    expect(loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: '   ' })).toEqual({ addresses: [] });
    expect(loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: ' None ' })).toEqual({
      addresses: [],
    });
  });

  it('reads single IPv4 and IPv6 addresses, normalized', () => {
    expect(
      loadTrustedProxyConfig({
        TRUSTED_PROXY_ADDRESSES: ' 172.18.0.2 , fd00::2,::1, 10.0.0.7/32, ::ffff:192.168.0.9,,',
      }),
    ).toEqual({
      addresses: [
        '172.18.0.2/32',
        'fd00:0:0:0:0:0:0:2/128',
        '0:0:0:0:0:0:0:1/128',
        '10.0.0.7/32',
        '192.168.0.9/32',
      ],
    });
    expect(
      loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: '172.18.0.2,172.18.0.2/32' }).addresses,
    ).toEqual(['172.18.0.2/32']);
  });

  it('refuses ranges: the compose network would cover the web and admin containers', () => {
    for (const range of [
      '172.18.0.0/16',
      '172.18.0.2/31',
      '10.0.0.0/8',
      'fd00::/8',
      '2001:db8::/127',
      '::ffff:172.18.0.0/112',
      '0.0.0.0/0',
      '::/0',
      '172.18.0.2, 172.18.0.0/16',
    ]) {
      expect(() => loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: range }), range).toThrow(
        /must list single addresses/,
      );
    }
  });

  it('rejects a list of only separators', () => {
    for (const bad of [',', ' , ,']) {
      expect(() => loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: bad }), bad).toThrow(
        /must list at least one address, or none/,
      );
    }
  });

  it('rejects anything else without echoing it', () => {
    for (const bad of [
      'my-proxy-host',
      '172.18.0.256',
      '172.18.0.0/33',
      '010.0.0.1',
      'fd00::/129',
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      'fe80::1%eth0',
      '172.18.0.2/32/1',
      '172.18.0.2/x',
    ]) {
      try {
        loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: `10.0.0.1,${bad}` });
        expect.unreachable(bad);
      } catch (error) {
        expect(String(error), bad).toMatch(/TRUSTED_PROXY_ADDRESSES/);
        expect(String(error), bad).not.toContain(bad);
      }
    }
  });

  it('requires the setting with AUTH_PROVIDER=shotx outside APP_STAGE=local', () => {
    for (const env of [
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'prod', NODE_ENV: 'production' },
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'staging' },
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'local', NODE_ENV: 'production' },
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'prod', TRUSTED_PROXY_ADDRESSES: '' },
      // Blank or whitespace only is unset, not `none`.
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'prod', TRUSTED_PROXY_ADDRESSES: ' ' },
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'prod', TRUSTED_PROXY_ADDRESSES: '\t \n' },
    ]) {
      expect(() => loadTrustedProxyConfig(env)).toThrow(/TRUSTED_PROXY_ADDRESSES is required/);
    }
    const prod = { AUTH_PROVIDER: 'shotx', APP_STAGE: 'prod', NODE_ENV: 'production' };
    expect(loadTrustedProxyConfig({ ...prod, TRUSTED_PROXY_ADDRESSES: 'none' })).toEqual({
      addresses: [],
    });
    expect(loadTrustedProxyConfig({ ...prod, TRUSTED_PROXY_ADDRESSES: '172.18.0.2' })).toEqual({
      addresses: ['172.18.0.2/32'],
    });
    // Not required with cognito (AWS) or on APP_STAGE=local.
    expect(loadTrustedProxyConfig({ APP_STAGE: 'prod' })).toEqual({ addresses: [] });
    expect(loadTrustedProxyConfig({ AUTH_PROVIDER: 'shotx', APP_STAGE: 'local' })).toEqual({
      addresses: [],
    });
  });
});

describe('isTrustedProxy', () => {
  const config = loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: '172.18.0.2,2001:db8::2,::1' });

  it('matches only the listed proxy addresses', () => {
    for (const ok of ['172.18.0.2', '2001:db8::2', '2001:DB8:0:0:0:0:0:2', '::1']) {
      expect(isTrustedProxy(ok, config), ok).toBe(true);
    }
    // The web and admin containers on the same network are not the proxy.
    for (const no of ['172.18.0.3', '172.18.0.4', '2001:db8::3', '::2', '8.8.8.8']) {
      expect(isTrustedProxy(no, config), no).toBe(false);
    }
  });

  it('treats IPv4-mapped IPv6 peers as IPv4', () => {
    expect(isTrustedProxy('::ffff:172.18.0.2', config)).toBe(true);
    expect(isTrustedProxy('::FFFF:ac12:2', config)).toBe(true);
    expect(isTrustedProxy('::ffff:172.18.0.3', config)).toBe(false);
    const mapped = loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: '::ffff:172.18.0.2' });
    expect(isTrustedProxy('172.18.0.2', mapped)).toBe(true);
  });

  it('never trusts with an empty list or an unparsable peer', () => {
    expect(isTrustedProxy('172.18.0.2', { addresses: [] })).toBe(false);
    for (const bad of ['', 'localhost', '172.18.0', 'not-an-ip']) {
      expect(isTrustedProxy(bad, config)).toBe(false);
    }
  });

  it('allows a zone id and brackets on the peer', () => {
    const linkLocal = loadTrustedProxyConfig({ TRUSTED_PROXY_ADDRESSES: 'fe80::1' });
    expect(isTrustedProxy('fe80::1%eth0', linkLocal)).toBe(true);
    expect(isTrustedProxy('[::1]', config)).toBe(true);
  });
});

describe('isIpAddress', () => {
  it('accepts IPv4 and IPv6, rejects ranges and names', () => {
    expect(isIpAddress('203.0.113.10')).toBe(true);
    expect(isIpAddress('2001:db8::1')).toBe(true);
    expect(isIpAddress('::ffff:203.0.113.10')).toBe(true);
    expect(isIpAddress('203.0.113.0/24')).toBe(false);
    expect(isIpAddress('example.com')).toBe(false);
  });
});
