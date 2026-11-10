import { describe, expect, it } from 'vitest';
import { groupSecret, parseOtpauthUri } from './totp';

describe('otpauth URIs', () => {
  it('reads the secret, account, issuer and parameters', () => {
    const parts = parseOtpauthUri(
      'otpauth://totp/ShotX:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ShotX&algorithm=SHA1&digits=6&period=30',
    );
    expect(parts).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'ShotX',
      account: 'admin@example.com',
      digits: 6,
      periodSeconds: 30,
      algorithm: 'SHA1',
    });
  });

  it('falls back to the label issuer and defaults', () => {
    const parts = parseOtpauthUri('otpauth://totp/ShotX%20Admin:a%40b.co?secret=jbswy3dpehpk3pxp');
    expect(parts?.issuer).toBe('ShotX Admin');
    expect(parts?.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(parts?.digits).toBe(6);
  });

  it('refuses anything that is not a TOTP URI with a base32 secret', () => {
    expect(parseOtpauthUri('https://example.com/?secret=JBSW')).toBeNull();
    expect(parseOtpauthUri('otpauth://hotp/x?secret=JBSWY3DP')).toBeNull();
    expect(parseOtpauthUri('otpauth://totp/x?secret=not-base32!')).toBeNull();
    expect(parseOtpauthUri('otpauth://totp/x')).toBeNull();
    expect(parseOtpauthUri('nonsense')).toBeNull();
  });

  it('groups the secret for typing', () => {
    expect(groupSecret('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });
});
