import { describe, expect, it } from 'vitest';
import { loadAuthProviderConfig, loadMediaUrlSignerConfig } from './local-dev';

const SECRET = 'x'.repeat(32);

describe('loadAuthProviderConfig', () => {
  it('defaults to cognito on any stage', () => {
    expect(loadAuthProviderConfig({ APP_STAGE: 'prod', NODE_ENV: 'production' })).toEqual({
      provider: 'cognito',
    });
  });

  it('allows local only on APP_STAGE=local outside production', () => {
    expect(
      loadAuthProviderConfig({
        APP_STAGE: 'local',
        AUTH_PROVIDER: 'local',
        LOCAL_AUTH_SECRET: SECRET,
      }),
    ).toEqual({ provider: 'local', secret: SECRET });
    for (const env of [
      { APP_STAGE: 'staging' },
      { APP_STAGE: 'prd' },
      {},
      { APP_STAGE: 'local', NODE_ENV: 'production' },
    ]) {
      expect(() =>
        loadAuthProviderConfig({ ...env, AUTH_PROVIDER: 'local', LOCAL_AUTH_SECRET: SECRET }),
      ).toThrow(/needs APP_STAGE=local/);
    }
  });

  it('requires a secret of at least 32 characters', () => {
    expect(() => loadAuthProviderConfig({ APP_STAGE: 'local', AUTH_PROVIDER: 'local' })).toThrow(
      /LOCAL_AUTH_SECRET is required/,
    );
    expect(() =>
      loadAuthProviderConfig({
        APP_STAGE: 'local',
        AUTH_PROVIDER: 'local',
        LOCAL_AUTH_SECRET: 'short',
      }),
    ).toThrow(/at least 32/);
  });
});

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
