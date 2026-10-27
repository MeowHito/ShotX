import { describe, expect, it } from 'vitest';
import { CAPTCHA_TOKEN_HEADER, captchaHeadersSchema, captchaTokenSchema } from '../api/share-page';
import { PUBLIC_SHARE_ROUTES } from '../api/routes';
import { CAPTCHA_ACTIONS } from '../domain';
import { ErrorCode, rateLimitedDetailsSchema } from '../errors';
import {
  CAPTCHA_DEFAULTS,
  captchaCspSources,
  loadCaptchaClientConfig,
  loadCaptchaConfig,
  TURNSTILE_ACTIONS,
  TURNSTILE_ORIGIN,
  TURNSTILE_SCRIPT_URL,
  TURNSTILE_SITEVERIFY_URL,
  TURNSTILE_TEST_SECRET_KEYS,
  TURNSTILE_TEST_SITE_KEYS,
  turnstileVerdict,
} from './captcha';

const SITE_KEY = '0x4AAAAAAABkMYinukE8nzYS';
const SECRET_KEY = '0x4AAAAAAABkMYinukE8nzYS_secretSECRETsecret';
const vps = {
  APP_STAGE: 'prod',
  NODE_ENV: 'production',
  AUTH_PROVIDER: 'shotx',
  PUBLIC_BASE_URL: 'https://photos.example.com',
  ADMIN_BASE_URL: 'https://admin.photos.example.com',
};
const local = {
  APP_STAGE: 'local',
  NODE_ENV: 'development',
  AUTH_PROVIDER: 'local',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  ADMIN_BASE_URL: 'http://localhost:3001',
};

describe('loadCaptchaConfig (api)', () => {
  it('defaults to waf, so the AWS stacks are unchanged', () => {
    expect(loadCaptchaConfig({})).toEqual({ provider: 'waf' });
    expect(loadCaptchaClientConfig({})).toEqual({ provider: 'waf' });
  });

  it('reads Turnstile with the secret, the expected hostname and the grant', () => {
    expect(
      loadCaptchaConfig({
        ...vps,
        CAPTCHA_PROVIDER: 'turnstile',
        TURNSTILE_SECRET_KEY: SECRET_KEY,
      }),
    ).toEqual({
      provider: 'turnstile',
      secretKey: SECRET_KEY,
      verifyUrl: TURNSTILE_SITEVERIFY_URL,
      verifyTimeoutMs: CAPTCHA_DEFAULTS.verifyTimeoutMs,
      expectedHostname: 'photos.example.com',
      testKey: false,
      grant: {
        attempts: 5,
        ttlSeconds: 600,
        perIp: 10,
        perIpWindowSeconds: 3600,
      },
    });
    const tuned = loadCaptchaConfig({
      ...vps,
      CAPTCHA_PROVIDER: 'turnstile',
      TURNSTILE_SECRET_KEY: SECRET_KEY,
      TURNSTILE_VERIFY_TIMEOUT_MS: '2000',
      CAPTCHA_GRANT_ATTEMPTS: '3',
      CAPTCHA_GRANT_TTL_SECONDS: '300',
      CAPTCHA_GRANTS_PER_IP: '2',
      CAPTCHA_GRANTS_PER_IP_WINDOW_SECONDS: '600',
    });
    expect(tuned).toMatchObject({
      verifyTimeoutMs: 2000,
      grant: { attempts: 3, ttlSeconds: 300, perIp: 2, perIpWindowSeconds: 600 },
    });
  });

  it('requires the secret with turnstile and validates every setting', () => {
    expect(() => loadCaptchaConfig({ ...vps, CAPTCHA_PROVIDER: 'turnstile' })).toThrow(
      /TURNSTILE_SECRET_KEY is required/,
    );
    for (const [key, value] of [
      ['CAPTCHA_PROVIDER', 'recaptcha'],
      ['TURNSTILE_SECRET_KEY', 'not a key'],
      ['TURNSTILE_VERIFY_TIMEOUT_MS', '100'],
      ['CAPTCHA_GRANT_ATTEMPTS', '0'],
      ['CAPTCHA_GRANT_TTL_SECONDS', '10'],
      ['CAPTCHA_GRANTS_PER_IP', 'many'],
    ] as const) {
      expect(
        () =>
          loadCaptchaConfig({
            ...vps,
            CAPTCHA_PROVIDER: 'turnstile',
            TURNSTILE_SECRET_KEY: SECRET_KEY,
            [key]: value,
          }),
        key,
      ).toThrow(new RegExp(key));
    }
  });

  it('refuses waf and none off AWS outside local', () => {
    expect(() => loadCaptchaConfig(vps)).toThrow(/CAPTCHA_PROVIDER=waf off AWS/);
    expect(() =>
      loadCaptchaClientConfig({
        ...vps,
        STORAGE_ENDPOINT_URL: 'https://a.r2.cloudflarestorage.com',
        AUTH_PROVIDER: 'cognito',
      }),
    ).toThrow(/CAPTCHA_PROVIDER=waf off AWS/);
    expect(() => loadCaptchaConfig({ ...vps, CAPTCHA_PROVIDER: 'none' })).toThrow(
      /CAPTCHA_PROVIDER=none off AWS/,
    );
    // Any VPS stage name, not only prod.
    expect(() =>
      loadCaptchaConfig({ ...vps, APP_STAGE: 'staging', CAPTCHA_PROVIDER: 'none' }),
    ).toThrow(/CAPTCHA_PROVIDER=none off AWS/);
    // Test runs may switch the challenge off.
    expect(
      loadCaptchaConfig({ ...vps, APP_STAGE: 'test', NODE_ENV: 'test', CAPTCHA_PROVIDER: 'none' }),
    ).toEqual({ provider: 'none' });
    // Locally anything goes, including the default.
    expect(loadCaptchaConfig(local)).toEqual({ provider: 'waf' });
  });

  it("allows Cloudflare's test keys only on APP_STAGE=local", () => {
    for (const secret of TURNSTILE_TEST_SECRET_KEYS) {
      expect(
        loadCaptchaConfig({
          ...local,
          CAPTCHA_PROVIDER: 'turnstile',
          TURNSTILE_SECRET_KEY: secret,
        }),
      ).toMatchObject({ testKey: true, expectedHostname: 'localhost' });
      expect(() =>
        loadCaptchaConfig({ ...vps, CAPTCHA_PROVIDER: 'turnstile', TURNSTILE_SECRET_KEY: secret }),
      ).toThrow(/published Cloudflare test key/);
      expect(() =>
        loadCaptchaConfig({
          ...local,
          NODE_ENV: 'production',
          CAPTCHA_PROVIDER: 'turnstile',
          TURNSTILE_SECRET_KEY: secret,
        }),
      ).toThrow(/published Cloudflare test key/);
    }
    for (const site of TURNSTILE_TEST_SITE_KEYS) {
      expect(
        loadCaptchaClientConfig({
          ...local,
          CAPTCHA_PROVIDER: 'turnstile',
          TURNSTILE_SITE_KEY: site,
        }),
      ).toMatchObject({ siteKey: site });
      expect(() =>
        loadCaptchaClientConfig({
          ...vps,
          CAPTCHA_PROVIDER: 'turnstile',
          TURNSTILE_SITE_KEY: site,
        }),
      ).toThrow(/published Cloudflare test key/);
    }
  });
});

describe('loadCaptchaClientConfig (web) and the CSP', () => {
  it('exposes only the public site key and the script URL', () => {
    const config = loadCaptchaClientConfig({
      ...vps,
      CAPTCHA_PROVIDER: 'turnstile',
      TURNSTILE_SITE_KEY: SITE_KEY,
      TURNSTILE_SECRET_KEY: SECRET_KEY,
    });
    expect(config).toEqual({
      provider: 'turnstile',
      siteKey: SITE_KEY,
      scriptUrl: TURNSTILE_SCRIPT_URL,
    });
    expect(JSON.stringify(config)).not.toContain('secret');
    expect(() => loadCaptchaClientConfig({ ...vps, CAPTCHA_PROVIDER: 'turnstile' })).toThrow(
      /TURNSTILE_SITE_KEY is required/,
    );
  });

  it('adds challenges.cloudflare.com to script-src and frame-src with turnstile only', () => {
    expect(
      captchaCspSources({
        provider: 'turnstile',
        siteKey: SITE_KEY,
        scriptUrl: TURNSTILE_SCRIPT_URL,
      }),
    ).toEqual({
      scriptSrc: ['https://challenges.cloudflare.com'],
      frameSrc: ['https://challenges.cloudflare.com'],
      connectSrc: [],
    });
    for (const provider of ['waf', 'none'] as const) {
      expect(captchaCspSources({ provider })).toEqual({
        scriptSrc: [],
        frameSrc: [],
        connectSrc: [],
      });
    }
    expect(new URL(TURNSTILE_SCRIPT_URL).origin).toBe(TURNSTILE_ORIGIN);
    expect(new URL(TURNSTILE_SITEVERIFY_URL).origin).toBe(TURNSTILE_ORIGIN);
  });
});

describe('turnstileVerdict', () => {
  const expected = { hostname: 'photos.example.com', action: TURNSTILE_ACTIONS.faceSearch };
  const ok = {
    success: true,
    hostname: 'photos.example.com',
    action: 'face_search',
    challenge_ts: '2026-10-27T05:00:00Z',
  };

  it('passes a successful token for the right hostname and action', () => {
    expect(turnstileVerdict(ok, expected)).toEqual({ ok: true });
    expect(turnstileVerdict({ ...ok, hostname: 'PHOTOS.example.com' }, expected)).toEqual({
      ok: true,
    });
  });

  it('refuses another hostname or action as invalid', () => {
    expect(turnstileVerdict({ ...ok, hostname: 'evil.example.com' }, expected)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(turnstileVerdict({ ...ok, action: 'face_deletion' }, expected)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(turnstileVerdict({ success: true }, expected)).toEqual({ ok: false, reason: 'invalid' });
    // Test secrets (local only) answer without our hostname and action.
    expect(
      turnstileVerdict({ success: true, hostname: 'example.com' }, { ...expected, testKey: true }),
    ).toEqual({ ok: true });
  });

  it('maps siteverify error codes to a reject reason', () => {
    const fail = (codes: string[]) =>
      turnstileVerdict({ success: false, 'error-codes': codes }, expected);
    expect(fail(['timeout-or-duplicate'])).toEqual({ ok: false, reason: 'expired' });
    expect(fail(['invalid-input-response'])).toEqual({ ok: false, reason: 'invalid' });
    expect(fail([])).toEqual({ ok: false, reason: 'invalid' });
    for (const code of [
      'invalid-input-secret',
      'missing-input-secret',
      'internal-error',
      'bad-request',
    ]) {
      expect(fail([code]), code).toEqual({ ok: false, reason: 'unavailable' });
    }
  });

  it('fails closed when siteverify could not be reached or answered nonsense', () => {
    expect(turnstileVerdict(null, expected)).toEqual({ ok: false, reason: 'unavailable' });
    expect(turnstileVerdict('<html>', expected)).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('API contract', () => {
  it('face search and face deletion accept the optional captcha header', () => {
    for (const route of [PUBLIC_SHARE_ROUTES.faceSearch, PUBLIC_SHARE_ROUTES.faceDeletion]) {
      expect(route.headers).toBe(captchaHeadersSchema);
      expect(route.errors).toContain(ErrorCode.RATE_LIMITED);
    }
    expect(CAPTCHA_TOKEN_HEADER).toBe(CAPTCHA_TOKEN_HEADER.toLowerCase());
    expect(captchaHeadersSchema.parse({})).toEqual({});
    expect(captchaHeadersSchema.parse({ [CAPTCHA_TOKEN_HEADER]: 'XXXX.DUMMY.TOKEN.XXXX' })).toEqual(
      {
        [CAPTCHA_TOKEN_HEADER]: 'XXXX.DUMMY.TOKEN.XXXX',
      },
    );
    for (const bad of ['', 'has space', 'x'.repeat(2049), 'ไทย']) {
      expect(captchaTokenSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('RATE_LIMITED details say whether a challenge helps and why a token was refused', () => {
    const challenge = {
      retryAfterSeconds: 120,
      captcha: { provider: 'turnstile', action: 'face_search', rejected: null },
    };
    expect(rateLimitedDetailsSchema.parse(challenge)).toEqual(challenge);
    expect(
      rateLimitedDetailsSchema.parse({
        ...challenge,
        captcha: { ...challenge.captcha, rejected: 'expired' },
      }),
    ).toMatchObject({ captcha: { rejected: 'expired' } });
    expect(rateLimitedDetailsSchema.parse({ retryAfterSeconds: 60, captcha: null })).toEqual({
      retryAfterSeconds: 60,
      captcha: null,
    });
    expect(
      rateLimitedDetailsSchema.safeParse({
        retryAfterSeconds: 1,
        captcha: { ...challenge.captcha, provider: 'waf' },
      }).success,
    ).toBe(false);
    expect(Object.values(TURNSTILE_ACTIONS).sort()).toEqual([...CAPTCHA_ACTIONS].sort());
  });
});
