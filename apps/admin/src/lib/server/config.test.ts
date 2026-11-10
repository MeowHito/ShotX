import { describe, expect, it } from 'vitest';
import { loadAdminConfig, loadAdminUiConfig } from './config';

describe('admin UI config', () => {
  it('reads both pools’ minimum lengths with the shared policy loaders', () => {
    expect(loadAdminUiConfig({})).toEqual({
      passwords: { generatedLength: 20, minLength: { admin: 14, photographer: 10 } },
    });
    expect(
      loadAdminUiConfig({
        ADMIN_GENERATED_PASSWORD_LENGTH: '32',
        ADMIN_PASSWORD_MIN_LENGTH: '24',
        PHOTOGRAPHER_PASSWORD_MIN_LENGTH: '12',
      }).passwords,
    ).toEqual({ generatedLength: 32, minLength: { admin: 24, photographer: 12 } });
  });

  it('refuses a generated length below either minimum', () => {
    expect(() =>
      loadAdminUiConfig({ ADMIN_GENERATED_PASSWORD_LENGTH: '20', ADMIN_PASSWORD_MIN_LENGTH: '24' }),
    ).toThrow(/at least 24/);
    expect(() =>
      loadAdminUiConfig({
        ADMIN_GENERATED_PASSWORD_LENGTH: '20',
        PHOTOGRAPHER_PASSWORD_MIN_LENGTH: '30',
      }),
    ).toThrow(/at least 30/);
    expect(() => loadAdminUiConfig({ ADMIN_GENERATED_PASSWORD_LENGTH: '15' })).toThrow();
  });
});

describe('admin config', () => {
  const ADMIN_KEY = 'a'.repeat(40);
  const base = {
    APP_STAGE: 'staging',
    PUBLIC_BASE_URL: 'https://photos.example.test',
    ADMIN_BASE_URL: 'https://admin.example.test',
    API_INTERNAL_URL: 'http://api:4000',
    AUTH_PROVIDER: 'shotx',
  };

  it('uses the admin app’s own key, AUTH_ADMIN_BFF_KEY', () => {
    const config = loadAdminConfig({ ...base, AUTH_ADMIN_BFF_KEY: ADMIN_KEY });
    expect(config.bffKey).toBe(ADMIN_KEY);
    expect(config.secureCookies).toBe(true);
  });

  it('never reads the web key AUTH_BFF_KEY', () => {
    expect(() => loadAdminConfig({ ...base, AUTH_BFF_KEY: 'w'.repeat(40) })).toThrow(
      /AUTH_ADMIN_BFF_KEY/,
    );
    const config = loadAdminConfig({
      ...base,
      AUTH_BFF_KEY: 'w'.repeat(40),
      AUTH_ADMIN_BFF_KEY: ADMIN_KEY,
    });
    expect(config.bffKey).toBe(ADMIN_KEY);
  });

  it('refuses a short key and Cognito sign-in', () => {
    expect(() => loadAdminConfig({ ...base, AUTH_ADMIN_BFF_KEY: 'short' })).toThrow(
      /AUTH_ADMIN_BFF_KEY/,
    );
    expect(() =>
      loadAdminConfig({ ...base, AUTH_PROVIDER: 'cognito', AUTH_ADMIN_BFF_KEY: ADMIN_KEY }),
    ).toThrow(/AUTH_PROVIDER=shotx or local/);
  });
});
