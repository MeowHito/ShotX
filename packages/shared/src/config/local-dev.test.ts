import { describe, expect, it } from 'vitest';
import { loadMediaUrlSignerConfig } from './local-dev';

describe('loadMediaUrlSignerConfig', () => {
  const keys = { AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test' };

  it('defaults to cloudfront', () => {
    expect(loadMediaUrlSignerConfig({ APP_STAGE: 'prod', ...keys })).toEqual({
      signer: 'cloudfront',
    });
  });

  it('allows s3-presign only on APP_STAGE=local, with credentials', () => {
    expect(
      loadMediaUrlSignerConfig({ APP_STAGE: 'local', MEDIA_URL_SIGNER: 's3-presign', ...keys }),
    ).toEqual({ signer: 's3-presign', accessKeyId: 'test', secretAccessKey: 'test' });
    expect(() =>
      loadMediaUrlSignerConfig({ APP_STAGE: 'staging', MEDIA_URL_SIGNER: 's3-presign', ...keys }),
    ).toThrow(/needs APP_STAGE=local/);
    expect(() =>
      loadMediaUrlSignerConfig({ APP_STAGE: 'local', MEDIA_URL_SIGNER: 's3-presign' }),
    ).toThrow(/are required/);
  });
});
