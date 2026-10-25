import { describe, expect, it } from 'vitest';
import { loadAwsConfig, loadMediaStorageConfig } from './aws';
import { loadCloudFrontSigningConfig } from './cloudfront';
import { COGNITO_ENV, loadCognitoConfig } from './cognito';
import { loadSentryConfig, loadWafCaptchaConfig } from './observability';
import { loadQueueVisibilityTimeouts } from './queues';
import { loadRedisConfig } from './redis';
import { loadAppConfig, loadInternalApiConfig, loadServerConfig } from './runtime';

/** The error a loader throws, as text. */
function errorOf(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the loader to throw');
}

describe('loadAppConfig', () => {
  const env = {
    APP_STAGE: 'local',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    ADMIN_BASE_URL: 'http://localhost:3001/',
  };

  it('reads the stage and normalizes the public origins', () => {
    expect(loadAppConfig(env)).toEqual({
      nodeEnv: 'development',
      stage: 'local',
      publicBaseUrl: 'http://localhost:3000',
      adminBaseUrl: 'http://localhost:3001',
    });
    expect(
      loadAppConfig({
        NODE_ENV: 'production',
        APP_STAGE: 'prod',
        PUBLIC_BASE_URL: 'https://Photos.Example.co.th',
        ADMIN_BASE_URL: 'https://admin.example.co.th',
      }),
    ).toEqual({
      nodeEnv: 'production',
      stage: 'prod',
      publicBaseUrl: 'https://photos.example.co.th',
      adminBaseUrl: 'https://admin.example.co.th',
    });
  });

  it.each([
    ['APP_STAGE', undefined],
    ['APP_STAGE', 'Prod'],
    ['APP_STAGE', 'a'],
    ['APP_STAGE', 'x'.repeat(17)],
    ['NODE_ENV', 'staging'],
    ['PUBLIC_BASE_URL', undefined],
    ['PUBLIC_BASE_URL', 'http://photos.example.co.th'],
    ['PUBLIC_BASE_URL', 'https://photos.example.co.th/studio'],
    ['PUBLIC_BASE_URL', 'https://photos.example.co.th/?a=1'],
    ['PUBLIC_BASE_URL', 'ftp://photos.example.co.th'],
    ['ADMIN_BASE_URL', 'admin.example.co.th'],
    ['ADMIN_BASE_URL', 'https://user:pw@admin.example.co.th'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadAppConfig({ ...env, [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadServerConfig', () => {
  it('uses the default port unless PORT is set', () => {
    expect(loadServerConfig({}, 4000)).toEqual({ port: 4000 });
    expect(loadServerConfig({ PORT: '3000' }, 4000)).toEqual({ port: 3000 });
    expect(loadServerConfig({ PORT: '' }, 4000)).toEqual({ port: 4000 });
  });

  it.each(['0', '65536', '80.5', 'http'])('rejects PORT=%j', (port) => {
    expect(() => loadServerConfig({ PORT: port }, 4000)).toThrow(/at PORT\b/);
  });
});

describe('loadInternalApiConfig', () => {
  it('accepts the internal ALB over plain http', () => {
    expect(
      loadInternalApiConfig({
        API_INTERNAL_URL: 'http://internal-shotx-prod-123.ap-southeast-1.elb.amazonaws.com/',
      }),
    ).toEqual({
      apiInternalUrl: 'http://internal-shotx-prod-123.ap-southeast-1.elb.amazonaws.com',
    });
  });

  it('requires an origin', () => {
    expect(() => loadInternalApiConfig({})).toThrow(/at API_INTERNAL_URL\b/);
    expect(() => loadInternalApiConfig({ API_INTERNAL_URL: 'http://alb/api' })).toThrow(
      /must be an origin without a path/,
    );
  });
});

describe('loadAwsConfig', () => {
  it('defaults to ap-southeast-1 and the real endpoints', () => {
    expect(loadAwsConfig({})).toEqual({ region: 'ap-southeast-1', endpointUrl: null });
    expect(loadAwsConfig({ AWS_ENDPOINT_URL: '' }).endpointUrl).toBeNull();
  });

  it('reads the LocalStack endpoint', () => {
    expect(loadAwsConfig({ AWS_ENDPOINT_URL: 'http://localhost:4566' })).toEqual({
      region: 'ap-southeast-1',
      endpointUrl: 'http://localhost:4566',
    });
  });

  it.each([
    ['AWS_REGION', 'Singapore'],
    ['AWS_ENDPOINT_URL', 'localhost:4566'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadAwsConfig({ [key]: value })).toThrow(new RegExp(`at ${key}\\b`));
  });
});

describe('loadMediaStorageConfig', () => {
  it('requires MEDIA_BUCKET and defaults to virtual-hosted requests', () => {
    expect(loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-prod-media' })).toEqual({
      bucket: 'shotx-prod-media',
      forcePathStyle: false,
    });
    expect(
      loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-local-media', S3_FORCE_PATH_STYLE: 'true' }),
    ).toEqual({ bucket: 'shotx-local-media', forcePathStyle: true });
    expect(() => loadMediaStorageConfig({})).toThrow(/at MEDIA_BUCKET\b/);
  });

  it.each([
    ['MEDIA_BUCKET', 'Shotx-Media'],
    ['MEDIA_BUCKET', 'ab'],
    ['MEDIA_BUCKET', 'shotx..media'],
    ['MEDIA_BUCKET', '-shotx'],
    ['MEDIA_BUCKET', 's3://shotx-media'],
    ['S3_FORCE_PATH_STYLE', 'maybe'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-media', [key]: value })).toThrow(
      new RegExp(`at ${key}\\b`),
    );
  });
});

describe('loadRedisConfig', () => {
  it('connects without AUTH locally', () => {
    expect(loadRedisConfig({ REDIS_URL: 'redis://localhost:6379' })).toEqual({
      url: 'redis://localhost:6379',
      tls: false,
      credentials: null,
    });
    // compose and .env.example leave the credentials empty.
    expect(
      loadRedisConfig({
        REDIS_URL: 'redis://localhost:6379',
        REDIS_USERNAME: '',
        REDIS_PASSWORD: '',
      }).credentials,
    ).toBeNull();
  });

  it('reads the RBAC user over TLS', () => {
    expect(
      loadRedisConfig({
        REDIS_URL: 'rediss://master.shotx-prod.abc123.apse1.cache.amazonaws.com:6379',
        REDIS_USERNAME: 'shotx-app',
        REDIS_PASSWORD: 'p@ss:w/rd',
      }),
    ).toEqual({
      url: 'rediss://master.shotx-prod.abc123.apse1.cache.amazonaws.com:6379',
      tls: true,
      credentials: { username: 'shotx-app', password: 'p@ss:w/rd' },
    });
  });

  it('requires the username and password together', () => {
    const url = 'rediss://cache:6379';
    expect(() => loadRedisConfig({ REDIS_URL: url, REDIS_USERNAME: 'u' })).toThrow(
      /REDIS_USERNAME and REDIS_PASSWORD must be set together/,
    );
    expect(() => loadRedisConfig({ REDIS_URL: url, REDIS_PASSWORD: 'p' })).toThrow(
      /REDIS_USERNAME and REDIS_PASSWORD must be set together/,
    );
  });

  it('refuses to send credentials without TLS', () => {
    expect(() =>
      loadRedisConfig({
        REDIS_URL: 'redis://cache:6379',
        REDIS_USERNAME: 'u',
        REDIS_PASSWORD: 'p',
      }),
    ).toThrow(/must use rediss:\/\//);
  });

  it.each([
    undefined,
    'localhost:6379',
    'http://localhost:6379',
    'redis://:secret@localhost:6379',
    'redis://localhost:6379?password=x',
    'redis://localhost:6379/db',
  ])('rejects REDIS_URL=%j', (url) => {
    expect(() => loadRedisConfig({ REDIS_URL: url })).toThrow(/at REDIS_URL\b/);
  });

  it('never prints the URL, username or password in errors', () => {
    const secrets = ['hunter2-password', 'svc-user-name', 'leaky-host'];
    const messages = [
      errorOf(() => loadRedisConfig({ REDIS_URL: `redis://u:${secrets[0]}@${secrets[2]}:6379` })),
      errorOf(() =>
        loadRedisConfig({ REDIS_URL: `rediss://${secrets[2]}`, REDIS_USERNAME: secrets[1] }),
      ),
      errorOf(() =>
        loadRedisConfig({ REDIS_URL: `rediss://${secrets[2]}`, REDIS_PASSWORD: secrets[0] }),
      ),
      errorOf(() =>
        loadRedisConfig({
          REDIS_URL: `redis://${secrets[2]}`,
          REDIS_USERNAME: secrets[1],
          REDIS_PASSWORD: secrets[0],
        }),
      ),
      errorOf(() => loadRedisConfig({ REDIS_URL: `not a url ${secrets[0]}` })),
    ];
    for (const message of messages) {
      expect(message).toMatch(/Invalid Redis configuration/);
      for (const value of secrets) expect(message).not.toContain(value);
    }
  });
});

describe('loadQueueVisibilityTimeouts', () => {
  const env = {
    MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '900',
    FACES_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '3600',
    ZIP_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '900',
    JOBS_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '3600',
  };

  it('reads the requested queues', () => {
    expect(loadQueueVisibilityTimeouts(env, ['media', 'faces', 'zip', 'jobs'])).toEqual({
      media: 900,
      faces: 3600,
      zip: 900,
      jobs: 3600,
    });
    expect(
      loadQueueVisibilityTimeouts({ ZIP_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '0' }, ['zip']),
    ).toEqual({
      zip: 0,
    });
  });

  it('requires every requested queue and the SQS range', () => {
    expect(() => loadQueueVisibilityTimeouts({}, ['faces'])).toThrow(
      /at FACES_QUEUE_VISIBILITY_TIMEOUT_SECONDS\b/,
    );
    for (const value of ['-1', '43201', '1.5']) {
      expect(() =>
        loadQueueVisibilityTimeouts({ MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS: value }, ['media']),
      ).toThrow(/at MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS\b/);
    }
    expect(
      loadQueueVisibilityTimeouts({ MEDIA_QUEUE_VISIBILITY_TIMEOUT_SECONDS: '43200' }, ['media']),
    ).toEqual({ media: 43_200 });
  });
});

// A syntactically valid PEM (not a real key).
const PEM_BODY =
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nVJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1G';
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----\n`;

describe('loadCloudFrontSigningConfig', () => {
  const env = {
    CLOUDFRONT_MEDIA_BASE_URL: 'https://photos.example.co.th/media/',
    CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F',
    CLOUDFRONT_PRIVATE_KEY: PEM,
  };

  it('reads the signing settings', () => {
    expect(loadCloudFrontSigningConfig(env)).toEqual({
      mediaBaseUrl: 'https://photos.example.co.th/media',
      keyPairId: 'K2JCJMDEHXQW5F',
      privateKey: PEM,
    });
  });

  it('accepts a one-line key with literal \\n and an RSA header', () => {
    const oneLine = PEM.replace(/\n/g, '\\n').replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY');
    expect(
      loadCloudFrontSigningConfig({ ...env, CLOUDFRONT_PRIVATE_KEY: oneLine }).privateKey,
    ).toBe(PEM.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY'));
  });

  it.each([
    ['CLOUDFRONT_MEDIA_BASE_URL', undefined],
    ['CLOUDFRONT_MEDIA_BASE_URL', 'http://photos.example.co.th/media'],
    ['CLOUDFRONT_MEDIA_BASE_URL', 'https://photos.example.co.th/media?x=1'],
    ['CLOUDFRONT_KEY_PAIR_ID', undefined],
    ['CLOUDFRONT_KEY_PAIR_ID', 'k2jc'],
    ['CLOUDFRONT_PRIVATE_KEY', undefined],
    ['CLOUDFRONT_PRIVATE_KEY', 'not a key'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadCloudFrontSigningConfig({ ...env, [key]: value })).toThrow(
      new RegExp(`at ${key}\\b`),
    );
  });

  it('never prints the private key in errors', () => {
    const broken = PEM.replace('-----END PRIVATE KEY-----', '-----END NOTHING-----');
    const message = errorOf(() =>
      loadCloudFrontSigningConfig({ ...env, CLOUDFRONT_PRIVATE_KEY: broken }),
    );
    expect(message).toMatch(/at CLOUDFRONT_PRIVATE_KEY\b/);
    expect(message).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7');
  });
});

describe('loadCognitoConfig', () => {
  const env = {
    COGNITO_USER_POOL_ID: 'ap-southeast-1_AbC123xyZ',
    COGNITO_WEB_CLIENT_ID: '1h57kf5cpq17m0eml12example',
    COGNITO_DOMAIN: 'https://shotx-prod.auth.ap-southeast-1.amazoncognito.com/',
    COGNITO_ADMIN_USER_POOL_ID: 'ap-southeast-1_Adm1nPool',
    COGNITO_ADMIN_CLIENT_ID: '5p2kq0exampleadminclient0',
    COGNITO_ADMIN_DOMAIN: 'https://shotx-prod-admin.auth.ap-southeast-1.amazoncognito.com',
  };

  it('reads only the requested pools and derives the issuer', () => {
    expect(loadCognitoConfig(env, ['users'])).toEqual({
      users: {
        userPoolId: 'ap-southeast-1_AbC123xyZ',
        clientId: '1h57kf5cpq17m0eml12example',
        domain: 'https://shotx-prod.auth.ap-southeast-1.amazoncognito.com',
        region: 'ap-southeast-1',
        issuer: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_AbC123xyZ',
      },
    });
    const both = loadCognitoConfig(env, ['users', 'admins']);
    expect(both.admins).toMatchObject({
      userPoolId: 'ap-southeast-1_Adm1nPool',
      issuer: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_Adm1nPool',
    });
    // web never needs the admin pool.
    expect(
      Object.keys(
        loadCognitoConfig(
          { ...env, COGNITO_ADMIN_USER_POOL_ID: undefined, COGNITO_ADMIN_CLIENT_ID: '' },
          ['users'],
        ),
      ),
    ).toEqual(['users']);
  });

  it('names the variables infra sets', () => {
    expect(
      Object.values(COGNITO_ENV)
        .flatMap((names) => Object.values(names))
        .sort(),
    ).toEqual(Object.keys(env).sort());
  });

  it.each([
    ['COGNITO_ADMIN_USER_POOL_ID', undefined],
    ['COGNITO_ADMIN_USER_POOL_ID', 'AbC123xyZ'],
    ['COGNITO_WEB_CLIENT_ID', 'Has-Dashes'],
    ['COGNITO_DOMAIN', 'http://shotx-prod.auth.ap-southeast-1.amazoncognito.com'],
    ['COGNITO_ADMIN_DOMAIN', 'https://admin.example.com/login'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadCognitoConfig({ ...env, [key]: value }, ['users', 'admins'])).toThrow(
      new RegExp(`at ${key}\\b`),
    );
  });
});

describe('loadSentryConfig', () => {
  it('is disabled when SENTRY_DSN is unset', () => {
    expect(loadSentryConfig({})).toEqual({ dsn: null });
    expect(loadSentryConfig({ SENTRY_DSN: '' })).toEqual({ dsn: null });
  });

  it('reads a DSN', () => {
    const dsn = 'https://examplePublicKey@o0.ingest.sentry.io/4505000000000000';
    expect(loadSentryConfig({ SENTRY_DSN: dsn })).toEqual({ dsn });
  });

  it('rejects malformed DSNs without printing them', () => {
    for (const dsn of [
      'https://o0.ingest.sentry.io/1',
      'https://key@o0.ingest.sentry.io/project',
      'key@o0.ingest.sentry.io/1',
    ]) {
      const message = errorOf(() => loadSentryConfig({ SENTRY_DSN: dsn }));
      expect(message).toMatch(/at SENTRY_DSN\b/);
      expect(message).not.toContain('o0.ingest.sentry.io');
    }
  });
});

describe('loadWafCaptchaConfig', () => {
  const env = {
    WAF_CAPTCHA_API_KEY: 'captcha-api-key-value',
    WAF_CAPTCHA_SCRIPT_URL: 'https://abc123.us-east-1.captcha-sdk.awswaf.com/abc123/jsapi.js',
  };

  it('is null until both are created after deploy', () => {
    expect(loadWafCaptchaConfig({})).toBeNull();
    expect(
      loadWafCaptchaConfig({ WAF_CAPTCHA_API_KEY: '', WAF_CAPTCHA_SCRIPT_URL: '' }),
    ).toBeNull();
    expect(loadWafCaptchaConfig(env)).toEqual({
      apiKey: 'captcha-api-key-value',
      scriptUrl: 'https://abc123.us-east-1.captcha-sdk.awswaf.com/abc123/jsapi.js',
    });
  });

  it('requires both together and never prints the key', () => {
    const message = errorOf(() =>
      loadWafCaptchaConfig({ WAF_CAPTCHA_API_KEY: env.WAF_CAPTCHA_API_KEY }),
    );
    expect(message).toMatch(/must be set together/);
    expect(message).not.toContain(env.WAF_CAPTCHA_API_KEY);
    expect(() =>
      loadWafCaptchaConfig({ ...env, WAF_CAPTCHA_SCRIPT_URL: 'http://captcha.example.com/x.js' }),
    ).toThrow(/at WAF_CAPTCHA_SCRIPT_URL\b/);
  });
});
