import { readFileSync } from 'node:fs';
import {
  type Env,
  loadApiLimitsConfig,
  loadAppConfig,
  loadAwsConfig,
  loadBillingConfig,
  loadCloudFrontSigningConfig,
  loadCognitoConfig,
  loadConsentConfig,
  loadCostConfig,
  loadDriveConfig,
  loadFaceConfig,
  loadFaceSearchUploadConfig,
  loadFeatureFlags,
  loadInternalApiConfig,
  loadMediaConfig,
  loadMediaStorageConfig,
  loadQueueUrls,
  loadQueueVisibilityTimeouts,
  loadRedisConfig,
  loadRetentionConfig,
  loadSentryConfig,
  loadServerConfig,
  loadShareConfig,
  loadUploadConfig,
  loadWafCaptchaConfig,
  loadWorkerSettings,
  QUEUE_NAMES,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceName } from '../lib/constants';
import { synthPlatform } from './helpers';

/**
 * Every environment variable infra sets on a service, and every one in .env.example, must be one
 * that a @shotx/shared loader reads (or a library such as node-postgres), and each service's
 * loaders must accept what the service gets. A misspelled or renamed variable fails here instead
 * of at container start.
 */

type Json = Record<string, unknown>;
type Loader = (env: Env) => unknown;

/** Read by libraries or tooling, not by a @shotx/shared loader. */
const THIRD_PARTY = new Set([
  // node-postgres (libpq variables) and the packages/db test setup.
  'PGHOST',
  'PGPORT',
  'PGDATABASE',
  'PGUSER',
  'PGPASSWORD',
  'PGSSLMODE',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  // Node.js and the AWS SDK credential chain (LocalStack).
  'NODE_EXTRA_CA_CERTS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  // docker compose.
  'LOCALSTACK_AUTH_TOKEN',
]);

/** Valid values for variables whose value on AWS is a CloudFormation token or a secret. */
const SAMPLES: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: '4000',
  PUBLIC_BASE_URL: 'https://photos.example.com',
  ADMIN_BASE_URL: 'https://admin.photos.example.com',
  API_INTERNAL_URL: 'http://internal-shotx-alb.ap-southeast-1.elb.amazonaws.com',
  MEDIA_BUCKET: 'shotx-prod-media',
  REDIS_URL: 'rediss://master.shotx.cache.amazonaws.com:6379',
  REDIS_USERNAME: 'shotx-app',
  REDIS_PASSWORD: 'secret-from-secrets-manager',
  MEDIA_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/shotx-prod-media',
  FACES_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/shotx-prod-faces',
  ZIP_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/shotx-prod-zip',
  JOBS_QUEUE_URL: 'https://sqs.ap-southeast-1.amazonaws.com/000000000000/shotx-prod-jobs',
  CLOUDFRONT_MEDIA_BASE_URL: 'https://photos.example.com/media',
  CLOUDFRONT_KEY_PAIR_ID: 'K2JCJMDEHXQW5F',
  CLOUDFRONT_PRIVATE_KEY:
    '-----BEGIN PRIVATE KEY-----\nMIIBVAIBADANBg==\n-----END PRIVATE KEY-----\n',
  COGNITO_USER_POOL_ID: 'ap-southeast-1_AbC123xyZ',
  COGNITO_WEB_CLIENT_ID: '1example23456789',
  COGNITO_DOMAIN: 'https://shotx-prod-auth.auth.ap-southeast-1.amazoncognito.com',
  COGNITO_ADMIN_USER_POOL_ID: 'ap-southeast-1_XyZ987abC',
  COGNITO_ADMIN_CLIENT_ID: '9example87654321',
  COGNITO_ADMIN_DOMAIN: 'https://shotx-prod-admin-auth.auth.ap-southeast-1.amazoncognito.com',
  SENTRY_DSN: 'https://publickey@o1.ingest.sentry.io/123',
  WAF_CAPTCHA_API_KEY: 'captcha-api-key',
  WAF_CAPTCHA_SCRIPT_URL: 'https://abc.ap-southeast-1.captcha-sdk.awswaf.com/abc/jsapi.js',
  PGHOST: 'shotx.cluster.ap-southeast-1.rds.amazonaws.com',
  PGPORT: '5432',
  PGDATABASE: 'shotx',
  PGUSER: 'shotx_admin',
  PGPASSWORD: 'secret-from-secrets-manager',
  IP_HASH_SECRET: 'generated-by-secrets-manager-64-characters-long-0123456789abcdef',
};

/** What each service loads at startup. */
const SERVICE_LOADERS: Record<ServiceName, Loader[]> = {
  web: [
    loadAppConfig,
    (e) => loadServerConfig(e, 3000),
    loadInternalApiConfig,
    (e) => loadCognitoConfig(e, ['users']),
    // Upload UI settings and the CSP connect-src bucket origin (MEDIA_BUCKET, AWS_REGION).
    loadAwsConfig,
    loadUploadConfig,
    loadMediaStorageConfig,
  ],
  admin: [
    loadAppConfig,
    (e) => loadServerConfig(e, 3000),
    loadInternalApiConfig,
    (e) => loadCognitoConfig(e, ['admins']),
  ],
  api: [
    loadAppConfig,
    (e) => loadServerConfig(e, 4000),
    loadAwsConfig,
    loadMediaStorageConfig,
    loadRedisConfig,
    (e) => loadQueueUrls(e, ['faces', 'zip']),
    (e) => loadCognitoConfig(e, ['users', 'admins']),
    loadCloudFrontSigningConfig,
    loadFaceConfig,
    loadFaceSearchUploadConfig,
    loadApiLimitsConfig,
    loadFeatureFlags,
    loadConsentConfig,
    loadShareConfig,
    loadUploadConfig,
    loadDriveConfig,
  ],
  worker: [
    loadAppConfig,
    loadAwsConfig,
    loadMediaStorageConfig,
    loadRedisConfig,
    (e) => loadQueueUrls(e, QUEUE_NAMES),
    (e) => loadQueueVisibilityTimeouts(e, QUEUE_NAMES),
    loadFaceConfig,
    loadWorkerSettings,
    loadFeatureFlags,
    loadShareConfig,
  ],
};

/** Every @shotx/shared loader, each with every input it can take. */
const ALL_LOADERS: Loader[] = [
  ...Object.values(SERVICE_LOADERS).flat(),
  loadSentryConfig,
  loadWafCaptchaConfig,
  loadCostConfig,
  loadUploadConfig,
  loadMediaConfig,
  loadShareConfig,
  loadRetentionConfig,
  loadBillingConfig,
  loadDriveConfig,
  loadApiLimitsConfig,
  loadWorkerSettings,
  loadFeatureFlags,
  loadConsentConfig,
];

const throws = (loader: Loader, env: Env) => {
  try {
    loader(env);
    return false;
  } catch {
    return true;
  }
};

/**
 * True when some loader reads `name`: on an env every loader accepts, an invalid value or
 * removing the variable makes one of them throw. (Optional variables with defaults reject an
 * invalid value; required ones also reject removal.)
 */
function readByLoaders(complete: Env, name: string): boolean {
  if (ALL_LOADERS.some((load) => throws(load, complete))) {
    throw new Error('the complete sample env must satisfy every loader');
  }
  const without = Object.fromEntries(Object.entries(complete).filter(([k]) => k !== name));
  return ALL_LOADERS.some(
    (load) =>
      throws(load, { ...complete, [name]: '\u0000 not a valid value' }) || throws(load, without),
  );
}

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const envExample: Record<string, string> = Object.fromEntries(
  read('.env.example')
    .split('\n')
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
);
/** .env.example's values where set, AWS-like samples otherwise (TLS Redis with credentials). */
const complete: Env = {
  ...Object.fromEntries(Object.entries(envExample).filter(([, v]) => v !== '')),
  ...SAMPLES,
};

const s = synthPlatform();
const app = s.template(s.platform.app);

function serviceEnv(service: ServiceName): { names: string[]; env: Record<string, string> } {
  const [td] = Object.values(
    app.findResources('AWS::ECS::TaskDefinition', {
      Properties: { Family: `shotx-prod-${service}` },
    }),
  );
  const c = (((td as Json).Properties as Json).ContainerDefinitions as Json[])[0] as Json;
  const pairs = [
    ...((c.Environment ?? []) as { Name: string; Value: unknown }[]).map(
      (e) => [e.Name, e.Value] as const,
    ),
    // Secrets: the value comes from Secrets Manager at runtime.
    ...((c.Secrets ?? []) as { Name: string }[]).map((e) => [e.Name, undefined] as const),
  ];
  const env: Record<string, string> = {};
  for (const [name, value] of pairs) {
    const resolved = typeof value === 'string' ? value : SAMPLES[name];
    if (resolved === undefined) throw new Error(`${service}: no sample value for token ${name}`);
    env[name] = resolved;
  }
  return { names: pairs.map(([name]) => name), env };
}

describe('environment variables infra sets', () => {
  for (const service of SERVICE_NAMES) {
    const { names, env } = serviceEnv(service);

    it(`${service}: every variable is read by a shared loader or a known library`, () => {
      const unread = names.filter((n) => !THIRD_PARTY.has(n) && !readByLoaders(complete, n));
      expect(unread).toEqual([]);
    });

    it(`${service}: its loaders accept what it gets`, () => {
      for (const load of SERVICE_LOADERS[service]) expect(() => load(env)).not.toThrow();
    });
  }

  it('detects a variable no loader reads', () => {
    expect(readByLoaders({ ...complete, MEDIA_BUKET: 'x' }, 'MEDIA_BUKET')).toBe(false);
    expect(readByLoaders(complete, 'MEDIA_BUCKET')).toBe(true);
  });
});

describe('.env.example', () => {
  it('lists only variables a shared loader, a library or docker compose reads', () => {
    const unread = Object.keys(envExample).filter(
      (n) => !THIRD_PARTY.has(n) && !readByLoaders(complete, n),
    );
    expect(unread).toEqual([]);
  });

  it('works for the worker against docker compose as it is', () => {
    const local = Object.fromEntries(Object.entries(envExample).filter(([, v]) => v !== ''));
    for (const load of SERVICE_LOADERS.worker) expect(() => load(local)).not.toThrow();
  });
});
