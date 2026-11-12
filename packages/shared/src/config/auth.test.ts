import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { viewerLoginAvailable } from '../api/auth';
import {
  apiIssuesTokens,
  AUTH_PROVIDER_NAMES,
  authProvidersOf,
  enabledOidcProviders,
  loadAuthClientConfig,
  loadAuthProviderConfig,
  loadBffAuthConfig,
  loadShotxAuthConfig,
  OIDC_PROVIDER_ENV,
  OIDC_TEMPLATE_PLACEHOLDER,
} from './auth';

const SECRET = 'x'.repeat(32);

function ed25519() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    privateDer: pkcs8.toString('base64'),
    publicPem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    publicDer: spki.toString('base64'),
  };
}

const users = ed25519();
const admins = ed25519();
const TOTP_KEY = Buffer.alloc(32, 7).toString('base64');

/** A complete AUTH_PROVIDER=shotx environment. */
const shotx = {
  AUTH_PROVIDER: 'shotx',
  APP_STAGE: 'prod',
  NODE_ENV: 'production',
  AUTH_USERS_SIGNING_KEY: users.privateDer,
  AUTH_ADMINS_SIGNING_KEY: admins.privateDer,
  LINE_LOGIN_CHANNEL_ID: '1234567890',
  LINE_LOGIN_CHANNEL_SECRET: 'line-channel-secret',
  GOOGLE_OAUTH_CLIENT_ID: '1234-abc.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'google-client-secret',
  ADMIN_TOTP_ENCRYPTION_KEY: TOTP_KEY,
};

const local = {
  AUTH_PROVIDER: 'local',
  APP_STAGE: 'local',
  NODE_ENV: 'development',
  AUTH_USERS_SIGNING_KEY: users.privateDer,
};

const without = (env: Record<string, string>, ...keys: string[]) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !keys.includes(k)));

describe('loadAuthProviderConfig', () => {
  it('defaults to cognito on any stage', () => {
    expect(loadAuthProviderConfig({ APP_STAGE: 'prod', NODE_ENV: 'production' })).toEqual({
      provider: 'cognito',
    });
  });

  it('allows shotx on any stage', () => {
    expect(
      loadAuthProviderConfig({ APP_STAGE: 'prod', NODE_ENV: 'production', AUTH_PROVIDER: 'shotx' }),
    ).toEqual({ provider: 'shotx' });
    expect(AUTH_PROVIDER_NAMES).toEqual(['cognito', 'shotx', 'local']);
    expect(apiIssuesTokens('shotx')).toBe(true);
    expect(apiIssuesTokens('local')).toBe(true);
    expect(apiIssuesTokens('cognito')).toBe(false);
  });

  it('allows local only on APP_STAGE=local outside production, with no secret', () => {
    expect(loadAuthProviderConfig({ APP_STAGE: 'local', AUTH_PROVIDER: 'local' })).toEqual({
      provider: 'local',
    });
    for (const env of [
      { APP_STAGE: 'staging' },
      { APP_STAGE: 'prd' },
      {},
      { APP_STAGE: 'local', NODE_ENV: 'production' },
    ]) {
      expect(() => loadAuthProviderConfig({ ...env, AUTH_PROVIDER: 'local' })).toThrow(
        /needs APP_STAGE=local/,
      );
    }
  });

  it('rejects unknown providers', () => {
    expect(() => loadAuthProviderConfig({ AUTH_PROVIDER: 'auth0' })).toThrow(/AUTH_PROVIDER/);
  });
});

describe('loadBffAuthConfig', () => {
  it('is optional with cognito and required otherwise', () => {
    expect(loadBffAuthConfig({ APP_STAGE: 'prod' })).toBeNull();
    // Optional with cognito: lets the BFFs pass the client IP on AWS too.
    expect(loadBffAuthConfig({ APP_STAGE: 'prod', AUTH_BFF_KEY: SECRET })).toEqual({ key: SECRET });
    expect(() => loadBffAuthConfig({ AUTH_BFF_KEY: 'short' })).toThrow(/at least 32/);
    expect(loadBffAuthConfig({ AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: SECRET })).toEqual({
      key: SECRET,
    });
    expect(() => loadBffAuthConfig({ AUTH_PROVIDER: 'shotx' })).toThrow(/AUTH_BFF_KEY is required/);
    expect(() => loadBffAuthConfig({ AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: 'short' })).toThrow(
      /at least 32/,
    );
  });

  it('refuses local outside APP_STAGE=local', () => {
    expect(
      loadBffAuthConfig({ AUTH_PROVIDER: 'local', APP_STAGE: 'local', AUTH_BFF_KEY: SECRET }),
    ).toEqual({ key: SECRET });
    expect(() =>
      loadBffAuthConfig({ AUTH_PROVIDER: 'local', APP_STAGE: 'prod', AUTH_BFF_KEY: SECRET }),
    ).toThrow(/needs APP_STAGE=local/);
  });

  it('never echoes the key', () => {
    const key = 'secret-bff-key-value';
    try {
      loadBffAuthConfig({ AUTH_PROVIDER: 'shotx', AUTH_BFF_KEY: key });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(key);
    }
  });
});

describe('loadShotxAuthConfig', () => {
  it('reads a complete shotx environment with the defaults', () => {
    const config = loadShotxAuthConfig(shotx);
    expect(config).toMatchObject({
      provider: 'shotx',
      algorithm: 'EdDSA',
      accessTokenTtlSeconds: 900,
      loginStateTtlSeconds: 600,
      loginRateLimitPerIp: { limit: 30, windowSeconds: 600 },
      oidcHttpTimeoutMs: 10_000,
      refreshReuseGraceSeconds: 10,
      oidc: {
        line: { clientId: '1234567890', clientSecret: 'line-channel-secret' },
        google: {
          clientId: '1234-abc.apps.googleusercontent.com',
          clientSecret: 'google-client-secret',
        },
      },
      devLogin: null,
    });
    expect(config.pools.users).toEqual({
      issuer: 'urn:shotx:prod:auth:users',
      audience: 'shotx-web',
      refreshTokenTtlSeconds: 30 * 86_400,
      signing: { current: { kid: 'users-1', privateKeyPem: users.privatePem }, previous: null },
    });
    expect(config.pools.admins).toEqual({
      issuer: 'urn:shotx:prod:auth:admins',
      audience: 'shotx-admin',
      refreshTokenTtlSeconds: 12 * 3600,
      signing: { current: { kid: 'admins-1', privateKeyPem: admins.privatePem }, previous: null },
    });
    expect(config.admin).toMatchObject({
      totp: { periodSeconds: 30, digits: 6, window: 1 },
      challengeTtlSeconds: 300,
      passwordMinLength: 14,
      rateLimits: {
        perAccount: { limit: 5, windowSeconds: 900 },
        perIp: { limit: 20, windowSeconds: 900 },
      },
      lockout: { threshold: 10, seconds: 900 },
    });
    expect(config.admin?.totp?.encryptionKey).toEqual(new Uint8Array(32).fill(7));
  });

  it('accepts PEM keys, on one line with \\n too, and normalizes them', () => {
    const oneLine = admins.privatePem.trim().replace(/\n/g, '\\n');
    const config = loadShotxAuthConfig({
      ...shotx,
      AUTH_USERS_SIGNING_KEY: users.privatePem,
      AUTH_ADMINS_SIGNING_KEY: oneLine,
    });
    expect(config.pools.users.signing.current.privateKeyPem).toBe(users.privatePem);
    expect(config.pools.admins?.signing.current.privateKeyPem).toBe(admins.privatePem);
  });

  it('reads a previous public key per pool for rotation, with distinct key ids', () => {
    const old = ed25519();
    const config = loadShotxAuthConfig({
      ...shotx,
      AUTH_USERS_SIGNING_KEY_ID: 'users-2',
      AUTH_USERS_PREVIOUS_PUBLIC_KEY: old.publicDer,
      AUTH_USERS_PREVIOUS_KEY_ID: 'users-1',
    });
    expect(config.pools.users.signing).toEqual({
      current: { kid: 'users-2', privateKeyPem: users.privatePem },
      previous: { kid: 'users-1', publicKeyPem: old.publicPem },
    });
    expect(() =>
      loadShotxAuthConfig({ ...shotx, AUTH_USERS_PREVIOUS_PUBLIC_KEY: old.publicDer }),
    ).toThrow(/must be set together/);
    expect(() =>
      loadShotxAuthConfig({
        ...shotx,
        AUTH_USERS_PREVIOUS_PUBLIC_KEY: old.publicDer,
        AUTH_USERS_PREVIOUS_KEY_ID: 'users-1',
      }),
    ).toThrow(/key id must be different/);
    expect(() => loadShotxAuthConfig({ ...shotx, AUTH_ADMINS_SIGNING_KEY_ID: 'users-1' })).toThrow(
      /key id must be different/,
    );
  });

  it('requires a separate key per pool', () => {
    expect(() =>
      loadShotxAuthConfig({ ...shotx, AUTH_ADMINS_SIGNING_KEY: users.privatePem }),
    ).toThrow(/must be different keys/);
  });

  it('accepts only Ed25519 keys of the right kind, and never echoes them', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 })
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
    for (const bad of [rsa, ec, users.publicDer, users.publicPem, 'not a key', 'AAAA']) {
      try {
        loadShotxAuthConfig({ ...shotx, AUTH_USERS_SIGNING_KEY: bad });
        expect.unreachable();
      } catch (error) {
        expect(String(error)).toMatch(/must be an Ed25519 private key/);
        expect(String(error)).not.toContain(bad.slice(0, 40));
      }
    }
    expect(() =>
      loadShotxAuthConfig({
        ...shotx,
        AUTH_USERS_PREVIOUS_PUBLIC_KEY: users.privateDer,
        AUTH_USERS_PREVIOUS_KEY_ID: 'old',
      }),
    ).toThrow(/must be an Ed25519 public key/);
  });

  it('requires the signing keys and the admins pool with shotx', () => {
    for (const [key, message] of [
      ['AUTH_USERS_SIGNING_KEY', /AUTH_USERS_SIGNING_KEY is required/],
      ['AUTH_ADMINS_SIGNING_KEY', /AUTH_ADMINS_SIGNING_KEY is required/],
    ] as const) {
      expect(() => loadShotxAuthConfig(without(shotx, key)), key).toThrow(message);
    }
    // The TOTP key only with ADMIN_MFA_MODE=totp (ADR 0011 decision 4).
    expect(() =>
      loadShotxAuthConfig({
        ...without(shotx, 'ADMIN_TOTP_ENCRYPTION_KEY'),
        ADMIN_MFA_MODE: 'totp',
      }),
    ).toThrow(/ADMIN_TOTP_ENCRYPTION_KEY is required with ADMIN_MFA_MODE=totp/);
  });

  describe('ADMIN_MFA_MODE (ADR 0011 decision 4)', () => {
    it('defaults to off, needs no TOTP key, and keeps a key that is set for the CLI', () => {
      const off = loadShotxAuthConfig(without(shotx, 'ADMIN_TOTP_ENCRYPTION_KEY'));
      expect(off.admin?.mfaMode).toBe('off');
      expect(off.admin?.totp).toBeNull();
      expect(off.pools.admins).not.toBeNull();
      expect(authProvidersOf(off).adminMfaMode).toBe('off');
      const offWithKey = loadShotxAuthConfig(shotx);
      expect(offWithKey.admin?.mfaMode).toBe('off');
      expect(offWithKey.admin?.totp?.encryptionKey).toEqual(new Uint8Array(32).fill(7));
    });

    it('totp restores the TOTP settings', () => {
      const totp = loadShotxAuthConfig({ ...shotx, ADMIN_MFA_MODE: 'totp' });
      expect(totp.admin).toMatchObject({ mfaMode: 'totp', totp: { digits: 6, window: 1 } });
      expect(authProvidersOf(totp).adminMfaMode).toBe('totp');
    });

    it('refuses other values', () => {
      for (const ADMIN_MFA_MODE of ['on', 'TOTP', 'sms']) {
        expect(() => loadShotxAuthConfig({ ...shotx, ADMIN_MFA_MODE }), ADMIN_MFA_MODE).toThrow(
          /ADMIN_MFA_MODE/,
        );
      }
    });

    it('keeps the lockout, rate limits and password policy in both modes', () => {
      for (const mode of ['off', 'totp']) {
        expect(loadShotxAuthConfig({ ...shotx, ADMIN_MFA_MODE: mode }).admin).toMatchObject({
          passwordMinLength: 14,
          rateLimits: { perAccount: { limit: 5 }, perIp: { limit: 20 } },
          lockout: { threshold: 10, seconds: 900 },
        });
      }
    });
  });

  describe('LINE and Google are optional on every stage (launch decision 2026-11-11)', () => {
    const noOidc = without(
      shotx,
      'LINE_LOGIN_CHANNEL_ID',
      'LINE_LOGIN_CHANNEL_SECRET',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    );

    it('loads prod shotx with neither provider, and the providers list is empty', () => {
      const config = loadShotxAuthConfig(noOidc);
      expect(config.oidc).toEqual({ line: null, google: null });
      expect(enabledOidcProviders(config)).toEqual([]);
      expect(authProvidersOf(config)).toEqual({
        oidc: [],
        devLogin: false,
        adminLogin: true,
        adminMfaMode: 'off',
      });
      expect(viewerLoginAvailable(authProvidersOf(config))).toBe(false);
      // Empty values (`LINE_LOGIN_CHANNEL_ID=` in an env file) count as unset.
      const blank = {
        ...shotx,
        LINE_LOGIN_CHANNEL_ID: '',
        LINE_LOGIN_CHANNEL_SECRET: '',
        GOOGLE_OAUTH_CLIENT_ID: '',
        GOOGLE_OAUTH_CLIENT_SECRET: '',
      };
      expect(enabledOidcProviders(loadShotxAuthConfig(blank))).toEqual([]);
    });

    it('enables each provider on its own when both its id and secret are set', () => {
      const lineOnly = loadShotxAuthConfig(
        without(shotx, 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'),
      );
      expect(enabledOidcProviders(lineOnly)).toEqual(['line']);
      expect(lineOnly.oidc.line).toEqual({
        clientId: '1234567890',
        clientSecret: 'line-channel-secret',
      });
      expect(viewerLoginAvailable(authProvidersOf(lineOnly))).toBe(true);
      const googleOnly = loadShotxAuthConfig(
        without(shotx, 'LINE_LOGIN_CHANNEL_ID', 'LINE_LOGIN_CHANNEL_SECRET'),
      );
      expect(enabledOidcProviders(googleOnly)).toEqual(['google']);
      expect(enabledOidcProviders(loadShotxAuthConfig(shotx))).toEqual(['line', 'google']);
    });

    it('still refuses one half of a pair without the other', () => {
      for (const key of [
        'LINE_LOGIN_CHANNEL_ID',
        'LINE_LOGIN_CHANNEL_SECRET',
        'GOOGLE_OAUTH_CLIENT_ID',
        'GOOGLE_OAUTH_CLIENT_SECRET',
      ]) {
        expect(() => loadShotxAuthConfig(without(shotx, key)), key).toThrow(/must be set together/);
      }
    });

    it('refuses the deploy template placeholder in OIDC values outside APP_STAGE=local', () => {
      expect(OIDC_TEMPLATE_PLACEHOLDER).toBe('REPLACE_ME');
      for (const name of ['LINE_LOGIN_CHANNEL_SECRET', 'GOOGLE_OAUTH_CLIENT_SECRET']) {
        for (const stage of [{}, { APP_STAGE: 'staging', NODE_ENV: 'development' }]) {
          expect(() =>
            loadShotxAuthConfig({ ...shotx, ...stage, [name]: OIDC_TEMPLATE_PLACEHOLDER }),
          ).toThrow(new RegExp(`${name} is still the deploy template placeholder`));
        }
      }
      // The ids as deploy/env/api.env.example ships them fail their format.
      expect(() =>
        loadShotxAuthConfig({ ...shotx, LINE_LOGIN_CHANNEL_ID: OIDC_TEMPLATE_PLACEHOLDER }),
      ).toThrow(/LINE_LOGIN_CHANNEL_ID/);
      expect(() =>
        loadShotxAuthConfig({
          ...shotx,
          GOOGLE_OAUTH_CLIENT_ID: `${OIDC_TEMPLATE_PLACEHOLDER}.apps.googleusercontent.com`,
        }),
      ).toThrow(/GOOGLE_OAUTH_CLIENT_ID/);
      // Locally a placeholder is only a broken provider, as before.
      expect(
        loadShotxAuthConfig({
          ...local,
          LINE_LOGIN_CHANNEL_ID: '1234567890',
          LINE_LOGIN_CHANNEL_SECRET: OIDC_TEMPLATE_PLACEHOLDER,
        }).oidc.line,
      ).not.toBeNull();
    });

    it('keeps the variable names of each provider', () => {
      expect(OIDC_PROVIDER_ENV).toEqual({
        line: { clientId: 'LINE_LOGIN_CHANNEL_ID', clientSecret: 'LINE_LOGIN_CHANNEL_SECRET' },
        google: { clientId: 'GOOGLE_OAUTH_CLIENT_ID', clientSecret: 'GOOGLE_OAUTH_CLIENT_SECRET' },
      });
    });
  });

  it('throws with cognito', () => {
    expect(() => loadShotxAuthConfig({ ...shotx, AUTH_PROVIDER: 'cognito' })).toThrow(
      /must be shotx or local/,
    );
    expect(() => loadShotxAuthConfig(without(shotx, 'AUTH_PROVIDER'))).toThrow(
      /must be shotx or local/,
    );
  });

  it('local: dev login for the users pool only, optional providers and admins pool', () => {
    const config = loadShotxAuthConfig(local);
    expect(config).toMatchObject({
      provider: 'local',
      devLogin: { pool: 'users' },
      oidc: { line: null, google: null },
      admin: null,
      pools: { admins: null },
    });
    expect(config.pools.users.issuer).toBe('urn:shotx:local:auth:users');
    const withAdmins = loadShotxAuthConfig({
      ...local,
      AUTH_ADMINS_SIGNING_KEY: admins.privateDer,
      ADMIN_TOTP_ENCRYPTION_KEY: TOTP_KEY,
    });
    expect(withAdmins.pools.admins?.audience).toBe('shotx-admin');
    expect(withAdmins.admin).not.toBeNull();
    // The dev login never becomes an admins-pool provider.
    expect(withAdmins.devLogin).toEqual({ pool: 'users' });
    expect(() => loadShotxAuthConfig({ ...local, ADMIN_TOTP_ENCRYPTION_KEY: TOTP_KEY })).toThrow(
      /AUTH_ADMINS_SIGNING_KEY is required/,
    );
    // ADMIN_MFA_MODE=off (default): the admins pool needs no TOTP key; `totp` does.
    expect(
      loadShotxAuthConfig({ ...local, AUTH_ADMINS_SIGNING_KEY: admins.privateDer }).admin,
    ).toMatchObject({ mfaMode: 'off', totp: null });
    expect(() =>
      loadShotxAuthConfig({
        ...local,
        AUTH_ADMINS_SIGNING_KEY: admins.privateDer,
        ADMIN_MFA_MODE: 'totp',
      }),
    ).toThrow(/ADMIN_TOTP_ENCRYPTION_KEY is required/);
    expect(() => loadShotxAuthConfig(without(local, 'AUTH_USERS_SIGNING_KEY'))).toThrow(
      /AUTH_USERS_SIGNING_KEY is required/,
    );
  });

  it('refuses local (and so the dev login) outside APP_STAGE=local', () => {
    for (const env of [
      { APP_STAGE: 'prod' },
      { APP_STAGE: 'staging' },
      { APP_STAGE: 'local', NODE_ENV: 'production' },
    ]) {
      expect(() => loadShotxAuthConfig({ ...local, ...env })).toThrow(/needs APP_STAGE=local/);
    }
    expect(loadShotxAuthConfig(shotx).devLogin).toBeNull();
  });

  it('validates the TOTP key, digits and window', () => {
    for (const key of [Buffer.alloc(16).toString('base64'), 'not base64!', 'x'.repeat(44)]) {
      expect(() => loadShotxAuthConfig({ ...shotx, ADMIN_TOTP_ENCRYPTION_KEY: key })).toThrow(
        /must be 32 bytes, base64 encoded/,
      );
    }
    expect(loadShotxAuthConfig({ ...shotx, ADMIN_TOTP_DIGITS: '8' }).admin?.totp?.digits).toBe(8);
    expect(() => loadShotxAuthConfig({ ...shotx, ADMIN_TOTP_DIGITS: '7' })).toThrow(/6 or 8/);
    expect(() => loadShotxAuthConfig({ ...shotx, ADMIN_TOTP_WINDOW: '3' })).toThrow();
  });

  it('reads the OIDC timeout and the refresh reuse grace', () => {
    const config = loadShotxAuthConfig({
      ...shotx,
      AUTH_OIDC_HTTP_TIMEOUT_MS: '3000',
      AUTH_REFRESH_REUSE_GRACE_SECONDS: '0',
    });
    expect(config.oidcHttpTimeoutMs).toBe(3000);
    expect(config.refreshReuseGraceSeconds).toBe(0);
    expect(() => loadShotxAuthConfig({ ...shotx, AUTH_OIDC_HTTP_TIMEOUT_MS: '100' })).toThrow(
      /AUTH_OIDC_HTTP_TIMEOUT_MS/,
    );
    expect(() => loadShotxAuthConfig({ ...shotx, AUTH_REFRESH_REUSE_GRACE_SECONDS: '61' })).toThrow(
      /AUTH_REFRESH_REUSE_GRACE_SECONDS/,
    );
  });

  it('keeps refresh lifetimes longer than access tokens', () => {
    expect(() =>
      loadShotxAuthConfig({
        ...shotx,
        AUTH_ACCESS_TOKEN_TTL_SECONDS: '3600',
        AUTH_ADMINS_REFRESH_TOKEN_TTL_SECONDS: '1800',
      }),
    ).toThrow(/AUTH_ADMINS_REFRESH_TOKEN_TTL_SECONDS must be longer/);
  });

  it('never echoes secrets in errors', () => {
    const secretValue = 'super-secret-line-value';
    try {
      loadShotxAuthConfig({
        ...without(shotx, 'LINE_LOGIN_CHANNEL_ID'),
        LINE_LOGIN_CHANNEL_SECRET: secretValue,
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secretValue);
    }
  });
});

describe('published .env.example secrets (review M2)', () => {
  const example = Object.fromEntries(
    readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const published = {
    AUTH_USERS_SIGNING_KEY: example.AUTH_USERS_SIGNING_KEY ?? '',
    AUTH_ADMINS_SIGNING_KEY: example.AUTH_ADMINS_SIGNING_KEY ?? '',
    ADMIN_TOTP_ENCRYPTION_KEY: example.ADMIN_TOTP_ENCRYPTION_KEY ?? '',
  };
  const examplePublic = (name: 'AUTH_USERS_SIGNING_KEY' | 'AUTH_ADMINS_SIGNING_KEY') =>
    createPublicKey(
      createPrivateKey({
        key: Buffer.from(published[name], 'base64'),
        format: 'der',
        type: 'pkcs8',
      }),
    )
      .export({ format: 'der', type: 'spki' })
      .toString('base64');

  it('are all present in .env.example', () => {
    for (const value of [...Object.values(published), example.AUTH_BFF_KEY]) {
      expect(value?.length).toBeGreaterThan(30);
    }
  });

  it('work on APP_STAGE=local', () => {
    expect(loadShotxAuthConfig({ ...local, ...published }).admin).not.toBeNull();
    expect(
      loadShotxAuthConfig({ ...shotx, APP_STAGE: 'local', NODE_ENV: 'development', ...published })
        .provider,
    ).toBe('shotx');
    expect(
      loadBffAuthConfig({ ...local, AUTH_BFF_KEY: example.AUTH_BFF_KEY ?? '' })?.key,
    ).toBeDefined();
  });

  it('are refused on any other stage, without printing them', () => {
    const cases: [string, string, Record<string, string>][] = [
      ['AUTH_USERS_SIGNING_KEY', published.AUTH_USERS_SIGNING_KEY, {}],
      ['AUTH_ADMINS_SIGNING_KEY', published.AUTH_ADMINS_SIGNING_KEY, {}],
      ['ADMIN_TOTP_ENCRYPTION_KEY', published.ADMIN_TOTP_ENCRYPTION_KEY, {}],
      // The same key as PEM is the same key.
      [
        'AUTH_USERS_SIGNING_KEY',
        `-----BEGIN PRIVATE KEY-----\\n${published.AUTH_USERS_SIGNING_KEY}\\n-----END PRIVATE KEY-----`,
        {},
      ],
      // A published key is not a safe previous key either.
      [
        'AUTH_USERS_PREVIOUS_PUBLIC_KEY',
        examplePublic('AUTH_USERS_SIGNING_KEY'),
        { AUTH_USERS_PREVIOUS_KEY_ID: 'old' },
      ],
    ];
    // Also on prod without LINE/Google (launch decision 2026-11-11): optional OIDC relaxes nothing.
    const noOidc = without(
      shotx,
      'LINE_LOGIN_CHANNEL_ID',
      'LINE_LOGIN_CHANNEL_SECRET',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
    );
    for (const [name, value, extra] of cases) {
      for (const env of [
        { ...shotx, ...extra, [name]: value },
        { ...shotx, APP_STAGE: 'staging', NODE_ENV: 'development', ...extra, [name]: value },
        { ...noOidc, ...extra, [name]: value },
      ]) {
        try {
          loadShotxAuthConfig(env);
          expect.unreachable(name);
        } catch (error) {
          expect(String(error), name).toContain(
            `${name} is the published .env.example placeholder`,
          );
          expect(String(error)).not.toContain(value.slice(10, 40));
        }
      }
    }
    for (const env of [
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'prod' },
      { APP_STAGE: 'prod' },
      { AUTH_PROVIDER: 'shotx', APP_STAGE: 'local', NODE_ENV: 'production' },
    ]) {
      expect(() => loadBffAuthConfig({ ...env, AUTH_BFF_KEY: example.AUTH_BFF_KEY })).toThrow(
        /AUTH_BFF_KEY is the published .env.example placeholder/,
      );
    }
  });
});

describe('cross-pool previous keys (review 10)', () => {
  it("refuses a previous key that is the other pool's current key", () => {
    expect(() =>
      loadShotxAuthConfig({
        ...shotx,
        AUTH_USERS_PREVIOUS_PUBLIC_KEY: admins.publicDer,
        AUTH_USERS_PREVIOUS_KEY_ID: 'old-users',
      }),
    ).toThrow(/AUTH_USERS_PREVIOUS_PUBLIC_KEY must not be the other pool's current signing key/);
    expect(() =>
      loadShotxAuthConfig({
        ...shotx,
        AUTH_ADMINS_PREVIOUS_PUBLIC_KEY: users.publicPem,
        AUTH_ADMINS_PREVIOUS_KEY_ID: 'old-admins',
      }),
    ).toThrow(/AUTH_ADMINS_PREVIOUS_PUBLIC_KEY must not be the other pool's current signing key/);
  });
});

describe('admin TOTP enrolment lifetime', () => {
  it('defaults to 7 days and is bounded', () => {
    expect(loadShotxAuthConfig(shotx).admin?.totpEnrolmentTtlSeconds).toBe(7 * 86_400);
    expect(
      loadShotxAuthConfig({ ...shotx, ADMIN_TOTP_ENROLMENT_TTL_SECONDS: '86400' }).admin
        ?.totpEnrolmentTtlSeconds,
    ).toBe(86_400);
    expect(() => loadShotxAuthConfig({ ...shotx, ADMIN_TOTP_ENROLMENT_TTL_SECONDS: '60' })).toThrow(
      /ADMIN_TOTP_ENROLMENT_TTL_SECONDS/,
    );
  });
});

describe('loadAuthClientConfig', () => {
  it('reads the grace (same key as the API) and the call timeout, no keys needed', () => {
    expect(loadAuthClientConfig({})).toEqual({
      refreshReuseGraceSeconds: 10,
      callTimeoutMs: 15_000,
    });
    const env = { ...shotx, AUTH_REFRESH_REUSE_GRACE_SECONDS: '3', AUTH_CLIENT_TIMEOUT_MS: '5000' };
    expect(loadAuthClientConfig(env)).toEqual({ refreshReuseGraceSeconds: 3, callTimeoutMs: 5000 });
    expect(loadShotxAuthConfig(env).refreshReuseGraceSeconds).toBe(3);
    expect(() => loadAuthClientConfig({ AUTH_CLIENT_TIMEOUT_MS: '10' })).toThrow(
      /AUTH_CLIENT_TIMEOUT_MS/,
    );
    expect(() => loadAuthClientConfig({ AUTH_REFRESH_REUSE_GRACE_SECONDS: '61' })).toThrow(
      /AUTH_REFRESH_REUSE_GRACE_SECONDS/,
    );
  });
});
