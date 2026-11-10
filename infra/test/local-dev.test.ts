import {
  AUTH_SIGNING_KEY_ENV,
  AWS_CLIENT_ENV,
  BULLMQ_QUEUE_ENV,
  loadAuthProviderConfig,
  loadBffAuthConfig,
  loadCaptchaClientConfig,
  loadCaptchaConfig,
  loadMediaStorageConfig,
  loadMediaUrlSignerConfig,
  loadQueueBackendConfig,
  loadRekognitionClientConfig,
  runsOffAws,
  loadShotxAuthConfig,
  loadTrustedProxyConfig,
  QUEUE_NAMES,
  QUEUE_URL_ENV,
  SCHEDULE_TIMEZONE_ENV,
  SCHEDULED_JOB_ENV,
  STORAGE_LIFECYCLE_ENV,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../lib/config';
import { rawConfig, synthPlatform } from './helpers';

type Json = Record<string, unknown>;

const at = (o: Json, ...path: string[]): Json => path.reduce((n, k) => n[k] as Json, o);
const withEdit = (edit: (c: Json) => void): Json => {
  const c = rawConfig();
  edit(c);
  return c;
};

const LOCAL_ONLY = {
  NODE_ENV: 'development',
  APP_STAGE: 'local',
  AUTH_PROVIDER: 'local',
  MEDIA_URL_SIGNER: 's3-presign',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
};

/**
 * ADR 0008 (VPS) settings the AWS stacks must not take from services.env: the queue backend and
 * the BullMQ/schedule settings (cdk.json `queues` and `schedules` are their AWS source), the
 * API-issued sign-in keys and secrets (AWS stays on Cognito, with no secret wiring for them) and
 * the trusted reverse proxy (on AWS the client address is CloudFront-Viewer-Address), plaintext
 * Redis credentials (ElastiCache is TLS only), non-AWS media storage (STORAGE_*, its signing token
 * and the R2 lifecycle settings) and static Rekognition/SES client keys (AWS uses task roles).
 */
const VPS_ONLY = [
  'QUEUE_BACKEND',
  ...Object.values(BULLMQ_QUEUE_ENV).flatMap((names) => Object.values(names)),
  SCHEDULE_TIMEZONE_ENV,
  ...Object.values(SCHEDULED_JOB_ENV).flatMap((names) => Object.values(names)),
  'AUTH_BFF_KEY',
  'AUTH_ADMIN_BFF_KEY',
  ...Object.values(AUTH_SIGNING_KEY_ENV).flatMap((names) => Object.values(names)),
  'ADMIN_TOTP_ENCRYPTION_KEY',
  'LINE_LOGIN_CHANNEL_ID',
  'LINE_LOGIN_CHANNEL_SECRET',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'TRUSTED_PROXY_ADDRESSES',
  'REDIS_ALLOW_PLAINTEXT_AUTH',
  'STORAGE_ENDPOINT_URL',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_ORIGINALS_CLASS',
  'STORAGE_SIGNING_ACCESS_KEY_ID',
  'STORAGE_SIGNING_SECRET_ACCESS_KEY',
  ...Object.values(STORAGE_LIFECYCLE_ENV),
  ...Object.values(AWS_CLIENT_ENV).flatMap((names) => Object.values(names)),
  'TURNSTILE_SITE_KEY',
  'TURNSTILE_SECRET_KEY',
  'TURNSTILE_VERIFY_TIMEOUT_MS',
  'CAPTCHA_GRANT_ATTEMPTS',
  'CAPTCHA_GRANT_TTL_SECONDS',
  'CAPTCHA_GRANTS_PER_IP',
  'CAPTCHA_GRANTS_PER_IP_WINDOW_SECONDS',
];

/** Stands in for a CloudFormation token; queue URLs get a URL so the SQS loader can parse them. */
const tokenSample = (name: string): string =>
  (Object.values(QUEUE_URL_ENV) as string[]).includes(name)
    ? `https://sqs.ap-southeast-1.amazonaws.com/000000000000/${name.toLowerCase()}`
    : 'token';

describe('local development stand-ins never reach a deployed stage', () => {
  it('reserves the stage name local', () => {
    const c = withEdit((x) => {
      x.stage = 'local';
    });
    expect(() => parseConfig(c)).toThrow(/reserved for local development/);
  });

  for (const group of ['common', 'web', 'admin', 'backend', 'api', 'worker']) {
    it(`refuses the runtime and local-only keys in services.env.${group}`, () => {
      for (const [key, value] of Object.entries(LOCAL_ONLY)) {
        const c = withEdit((x) => {
          at(x, 'services', 'env')[group] = { [key]: value };
        });
        expect(() => parseConfig(c), key).toThrow(new RegExp(`${group}: ${key} is set by infra`));
      }
    });
  }

  for (const group of ['common', 'web', 'admin', 'backend', 'api', 'worker']) {
    it(`refuses the queue backend and API-issued sign-in keys in services.env.${group}`, () => {
      const c = withEdit((x) => {
        at(x, 'services', 'env')[group] = Object.fromEntries(VPS_ONLY.map((k) => [k, 'x']));
      });
      let message = '';
      try {
        parseConfig(c);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      const refused = (key: string) => message.includes(`${group}: ${key} is set by infra`);
      expect(VPS_ONLY.filter((key) => !refused(key))).toEqual([]);
    });
  }

  it('accepts CAPTCHA_PROVIDER=waf only (turnstile and none are VPS-only)', () => {
    for (const group of ['common', 'web', 'api']) {
      for (const value of ['turnstile', 'none']) {
        const c = withEdit((x) => {
          at(x, 'services', 'env')[group] = { CAPTCHA_PROVIDER: value };
        });
        expect(() => parseConfig(c), `${group} ${value}`).toThrow(
          new RegExp(`${group}: CAPTCHA_PROVIDER must be waf on the AWS stacks`),
        );
      }
      const waf = withEdit((x) => {
        at(x, 'services', 'env')[group] = { CAPTCHA_PROVIDER: 'waf' };
      });
      expect(() => parseConfig(waf), group).not.toThrow();
    }
  });

  it('gives every container NODE_ENV=production and resolves to Cognito and CloudFront', () => {
    const s = synthPlatform();
    const app = s.template(s.platform.app);
    const definitions = Object.values(app.findResources('AWS::ECS::TaskDefinition'));
    expect(definitions.length).toBeGreaterThan(0);
    for (const td of definitions) {
      // Every container, so a sidecar can't carry local-only settings either.
      for (const container of (td.Properties as Json).ContainerDefinitions as Json[]) {
        const env = Object.fromEntries(
          ((container.Environment ?? []) as { Name: string; Value: unknown }[]).map((e) => [
            e.Name,
            typeof e.Value === 'string' ? e.Value : 'token',
          ]),
        );
        expect(env.NODE_ENV).toBe('production');
        for (const key of ['AUTH_PROVIDER', 'MEDIA_URL_SIGNER']) {
          expect(env[key], key).toBeUndefined();
        }
        expect(loadAuthProviderConfig(env)).toEqual({ provider: 'cognito' });
        expect(loadMediaUrlSignerConfig(env)).toEqual({ signer: 'cloudfront' });
      }
    }
  });

  it('keeps every container on Cognito, SQS, AWS S3 and no trusted proxy', () => {
    const s = synthPlatform();
    const app = s.template(s.platform.app);
    const definitions = Object.values(app.findResources('AWS::ECS::TaskDefinition'));
    const queuesSeen = new Set<string>();
    let storageSeen = 0;
    for (const td of definitions) {
      for (const container of (td.Properties as Json).ContainerDefinitions as Json[]) {
        const pairs = [
          ...((container.Environment ?? []) as { Name: string; Value: unknown }[]).map(
            (e) => [e.Name, typeof e.Value === 'string' ? e.Value : tokenSample(e.Name)] as const,
          ),
          ...((container.Secrets ?? []) as { Name: string }[]).map(
            (e) => [e.Name, 'secret'] as const,
          ),
        ];
        const env = Object.fromEntries(pairs);
        for (const key of VPS_ONLY) expect(env[key], key).toBeUndefined();
        // No bff routes and no API-issued tokens: the token issuer refuses to start.
        expect(loadBffAuthConfig(env)).toBeNull();
        // The WAF CAPTCHA, never Turnstile.
        expect(loadCaptchaConfig(env)).toEqual({ provider: 'waf' });
        expect(loadCaptchaClientConfig(env)).toEqual({ provider: 'waf' });
        // X-Forwarded-For is trusted from nobody.
        expect(loadTrustedProxyConfig(env)).toEqual({ addresses: [] });
        expect(() => loadShotxAuthConfig(env)).toThrow(/AUTH_PROVIDER must be shotx or local/);
        // The queues this container has URLs for, read the way api and worker read them.
        const queues = QUEUE_NAMES.filter((q) => env[QUEUE_URL_ENV[q]] !== undefined);
        const backend = loadQueueBackendConfig(env, queues);
        expect(backend.backend).toBe('sqs');
        for (const q of queues) queuesSeen.add(q);
        // On AWS: task-role credentials and regional endpoints for Rekognition.
        expect(runsOffAws(env)).toBe(false);
        expect(loadRekognitionClientConfig(env)).toEqual({
          region: 'ap-southeast-1',
          endpointUrl: null,
          credentials: null,
        });
        // Media on AWS S3 through the task role, originals in Intelligent-Tiering.
        if (env.MEDIA_BUCKET !== undefined) {
          const storage = loadMediaStorageConfig(env);
          expect(storage.client).toMatchObject({ explicit: false, credentials: null });
          expect(storage.client.endpointUrl).toBeNull();
          expect(storage.originalsStorageClass).toBe('INTELLIGENT_TIERING');
          storageSeen += 1;
        }
      }
    }
    expect(storageSeen).toBeGreaterThan(0);
    // api and worker between them send to and consume every queue.
    expect([...queuesSeen].sort()).toEqual([...QUEUE_NAMES].sort());
  });
});
