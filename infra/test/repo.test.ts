import { existsSync, readdirSync, readFileSync } from 'node:fs';
import {
  type Env,
  LATEST_CONSENT_POLICY_VERSION,
  loadApiLimitsConfig,
  loadBillingConfig,
  loadDriveConfig,
  loadEmailConfig,
  loadFaceConfig,
  loadFeatureFlags,
  loadPaymentGatewayConfig,
  loadRetentionConfig,
  loadShareConfig,
  loadSharePasswordHashConfig,
  loadUploadConfig,
  loadWorkerSettings,
  PAYMENT_GATEWAY_SECRET_ENV,
  PAYMENT_GATEWAY_SECRET_NAMES,
  QUEUE_NAMES,
  QUEUE_VISIBILITY_TIMEOUT_ENV,
  SCHEDULED_JOB_TYPES,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { describeFacesWorstCase, faceSearchLimits, parseConfig } from '../lib/config';
import { facesJobWorstCase, minOrphanGraceMs } from '../lib/face-limits';
import { rawConfig } from './helpers';

/** Repository wiring infra owns outside infra/: CI services and Turborepo env pass-through. */
const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('CI', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = (name: string) => {
    const start = ci.indexOf(`\n  ${name}:`);
    expect(start, name).toBeGreaterThan(0);
    const next = ci.slice(start + 1).search(/\n {2}[a-z][a-z0-9_-]*:\n/);
    return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
  };
  const checks = job('checks');

  it('installs ffmpeg before the tests, so the worker video tests run', () => {
    const install = checks.indexOf('apt-get install -y --no-install-recommends ffmpeg');
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(checks.indexOf('pnpm turbo run lint typecheck test'));
  });

  describe('image builds', () => {
    const images = job('images');
    const config = parseConfig(rawConfig());

    it('lints and builds the api, worker, web and admin Dockerfiles', () => {
      expect(images).toMatch(/app: \[api, worker, web, admin\]/);
      for (const app of ['api', 'worker', 'web', 'admin']) {
        expect(existsSync(new URL(`../../apps/${app}/Dockerfile`, import.meta.url)), app).toBe(
          true,
        );
      }
      expect(images).toContain(
        'docker buildx build --check -f apps/${{ matrix.app }}/Dockerfile .',
      );
      expect(images).toContain('file: apps/${{ matrix.app }}/Dockerfile');
    });

    it('builds for the ECS CPU architecture under QEMU and never pushes', () => {
      const platform = { ARM64: 'linux/arm64', X86_64: 'linux/amd64' }[
        config.services.cpuArchitecture
      ];
      expect(images).toContain(`platforms: ${platform}`);
      expect(images).toMatch(/docker\/setup-qemu-action@[0-9a-f]{40}/);
      expect(images).toMatch(/docker\/build-push-action@[0-9a-f]{40}/);
      expect(images).toMatch(/push: false/);
      expect(images).not.toMatch(/push: true|docker\/login-action|--push/);
      expect(images).toMatch(/timeout-minutes: \d+/);
    });
  });

  it('runs PostgreSQL 18 for the packages/db integration tests', () => {
    // pgvector's image of PostgreSQL 18 (migration 0010, ADR 0009).
    expect(checks).toMatch(/^\s{6}postgres:\n\s{8}image: pgvector\/pgvector:[0-9.]+-pg18$/m);
    expect(checks).toMatch(/--health-cmd "pg_isready/);
    expect(checks).toMatch(
      /^\s{6}TEST_DATABASE_URL: postgres:\/\/shotx:shotx@localhost:5432\/shotx_test$/m,
    );
    expect(checks).toMatch(/POSTGRES_DB: shotx_test/);
  });

  it('runs Redis for the rate-limiter tests', () => {
    expect(checks).toMatch(/image: redis:7\.2-alpine/);
    expect(checks).toMatch(/REDIS_URL: redis:\/\/localhost:6379/);
  });
});

describe('.env.example', () => {
  const env = Object.fromEntries(
    read('.env.example')
      .split('\n')
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  const config = parseConfig(rawConfig());

  it('lists the Redis credentials, empty for local Redis without AUTH', () => {
    expect(env.REDIS_URL).toMatch(/^redis:\/\/localhost:\d+$/);
    expect(env.REDIS_USERNAME).toBe('');
    expect(env.REDIS_PASSWORD).toBe('');
  });

  it('matches the derived face-search limits and queue visibility timeouts', () => {
    const limits = faceSearchLimits(config);
    expect(env.FACE_SEARCH_MAX_SELFIE_BYTES).toBe(String(limits.selfieMaxBytes));
    expect(env.FACE_SEARCH_MAX_BODY_BYTES).toBe(String(limits.maxBodyBytes));
    for (const q of QUEUE_NAMES) {
      expect(env[QUEUE_VISIBILITY_TIMEOUT_ENV[q]], q).toBe(
        String(config.queues[q].visibilityTimeoutSeconds),
      );
    }
  });

  const faceEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('FACE_')));

  it('lists every FACE_* setting the shared face config reads', () => {
    // Keys of the zod schemas in packages/shared/src/config/face.ts.
    const source = read('packages/shared/src/config/face.ts');
    const keys = [...source.matchAll(/^\s+(FACE_[A-Z0-9_]+): /gm)].map((m) => m[1]);
    expect(keys).toEqual(
      expect.arrayContaining([
        'FACE_ORPHAN_GRACE_MS',
        'FACE_REKOGNITION_REQUEST_TIMEOUT_MS',
        'FACE_REKOGNITION_TPS_LIST_FACES',
      ]),
    );
    for (const key of keys) expect(faceEnv, key).toHaveProperty(key as string);
  });

  it('uses the code defaults, with an orphan grace long enough for its own retry budget', () => {
    const face = loadFaceConfig(faceEnv);
    // FACE_MODEL_DIR has no code default: the example points it at `pnpm face-models`' folder.
    expect(face).toEqual(loadFaceConfig({ FACE_MODEL_DIR: faceEnv.FACE_MODEL_DIR }));
    // Same check as synth (lib/config.ts), with these values and the faces job budget.
    const worst = facesJobWorstCase(face, config.queues.faces.jobBudget);
    expect(face.index.orphanGraceMs, describeFacesWorstCase(worst)).toBeGreaterThanOrEqual(
      minOrphanGraceMs(worst),
    );
  });

  /** `KEY=value` lines, plus `# KEY=` lines for optional keys documented without a value. */
  const listed = new Set(
    read('.env.example')
      .split('\n')
      .map((l) => /^(?:# )?([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((k): k is string => k !== undefined),
  );
  const loaderFiles: Record<string, (e: Env) => unknown> = {
    'api.ts': loadApiLimitsConfig,
    'consent.ts': () => undefined,
    'features.ts': loadFeatureFlags,
    'worker.ts': loadWorkerSettings,
    'share.ts': loadShareConfig,
    'upload.ts': loadUploadConfig,
    'drive.ts': loadDriveConfig,
    'password.ts': loadSharePasswordHashConfig,
    'retention.ts': loadRetentionConfig,
    // Billing tunables, the gateway selection and email. The gateway secrets and the sender
    // address have no default; the same placeholders go into both sides of the comparison.
    'billing.ts': (e) => ({
      billing: loadBillingConfig(e),
      gateway: loadPaymentGatewayConfig({ PAYMENT_FAKE_WEBHOOK_SECRET: 'x'.repeat(16), ...e }),
      email: loadEmailConfig({ EMAIL_FROM_ADDRESS: 'no-reply@shotx.test', ...e }),
    }),
  };

  for (const [file, load] of Object.entries(loaderFiles)) {
    it(`lists every setting of packages/shared/src/config/${file} at its code default`, () => {
      const keys = [
        ...read(`packages/shared/src/config/${file}`).matchAll(/^\s+([A-Z][A-Z0-9_]+): /gm),
      ].map((m) => m[1] as string);
      expect(keys.length, file).toBeGreaterThan(0);
      for (const key of keys) expect(listed.has(key), key).toBe(true);
      const values = Object.fromEntries(keys.flatMap((k) => (k in env ? [[k, env[k]]] : [])));
      expect(load(values), file).toEqual(load({}));
    });
  }

  it('lists the Phase 3 face, feature and consent keys', () => {
    // Empty: follows FACE_STRONG of the selected provider and model (ADR 0009).
    expect(env.FACE_DELETION_THRESHOLD).toBe('');
    expect(env.FACE_SEARCH_ENABLED).toBe('false');
    expect(env.CONSENT_POLICY_VERSION).toBe(LATEST_CONSENT_POLICY_VERSION);
    // A local placeholder that loadConsentConfig accepts; on AWS it is a generated secret.
    expect(env.IP_HASH_SECRET?.length).toBeGreaterThanOrEqual(32);
  });

  it('lists the face deletion alert keys at their code defaults (ADR 0007)', () => {
    expect(env.FACE_DELETION_ALERT_PER_SHARE).toBe('20');
    expect(env.FACE_DELETION_ALERT_WINDOW_SECONDS).toBe('86400');
    const deletion = loadFaceConfig(faceEnv).deletion;
    expect(deletion).toEqual(loadFaceConfig({}).deletion);
  });

  it('selects the fake gateway and email locally, with placeholder secrets only', () => {
    expect(env.PAYMENT_GATEWAY).toBe('fake');
    expect(env.EMAIL_PROVIDER).toBe('fake');
    expect(env.NODE_ENV).toBe('development');
    // Every gateway secret is listed; only the fake one has a (local placeholder) value.
    for (const name of PAYMENT_GATEWAY_SECRET_NAMES) expect(listed.has(name), name).toBe(true);
    for (const name of PAYMENT_GATEWAY_SECRET_NAMES) {
      if (name === PAYMENT_GATEWAY_SECRET_ENV.fake[0]) continue;
      expect(env, name).not.toHaveProperty(name);
    }
    expect(env.PAYMENT_FAKE_WEBHOOK_SECRET).toMatch(/^local-dev-only-/);
    expect(() => loadPaymentGatewayConfig(env)).not.toThrow();
    expect(loadEmailConfig(env)).toEqual({
      provider: 'fake',
      from: { address: 'no-reply@shotx.test', name: 'ShotX' },
    });
  });

  it('documents the face deletion threshold right above it', () => {
    const lines = read('.env.example').split('\n');
    const i = lines.findIndex((l) => l.startsWith('FACE_DELETION_THRESHOLD='));
    expect(lines[i - 1]).toContain('FACE_MAYBE');
  });

  it('documents that the burst window is in (0, 1]', () => {
    const lines = read('.env.example').split('\n');
    const i = lines.findIndex((l) => l.startsWith('FACE_REKOGNITION_BURST_SECONDS='));
    expect(lines.slice(Math.max(0, i - 3), i).join('\n')).toContain('(0, 1]');
    expect(() => loadFaceConfig({ FACE_REKOGNITION_BURST_SECONDS: '1.5' })).toThrow();
  });
});

describe('LocalStack init script', () => {
  const script = read('infra/local/localstack/init-aws.sh');
  const storage = parseConfig(rawConfig()).storage;

  it('reads only storage keys that exist in cdk.json', () => {
    const keys = [...script.matchAll(/storage\["([A-Za-z]+)"\]/g)].map((m) => m[1] as string);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) expect(storage, key).toHaveProperty(key);
  });

  it('mirrors the per-prefix tmp/ lifecycle rules', () => {
    for (const prefix of ['tmp/zips/', 'tmp/reconcile/', 'tmp/']) {
      expect(script, prefix).toContain(`{"Prefix": "${prefix}"}`);
    }
    // IndexFaces gets bytes (ADR 0008 section 5): no tmp/index/ rule.
    expect(script).not.toContain('tmp/index/');
  });
});

describe('Turborepo', () => {
  const turbo = JSON.parse(read('turbo.json')) as {
    tasks: { test: { env?: string[]; passThroughEnv?: string[] } };
  };

  it('hashes the env vars that decide which tests run, so cached results never replay a skip', () => {
    // REDIS_URL, TEST_DATABASE_URL and AWS_ENDPOINT_URL switch integration tests on or off.
    const hashed = turbo.tasks.test.env ?? [];
    for (const name of [
      'REDIS_URL',
      'DATABASE_URL',
      'TEST_DATABASE_URL',
      'AWS_REGION',
      'AWS_ENDPOINT_URL',
      'S3_FORCE_PATH_STYLE',
    ]) {
      expect(hashed, name).toContain(name);
      expect(turbo.tasks.test.passThroughEnv ?? [], name).not.toContain(name);
    }
  });

  it('passes AWS credentials through without hashing them', () => {
    expect(turbo.tasks.test.passThroughEnv).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  });
});

describe('contracts from @shotx/shared', () => {
  const libFiles = (dir: string): string[] =>
    readdirSync(new URL(`../${dir}/`, import.meta.url), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? libFiles(`${dir}/${e.name}`)
        : e.name.endsWith('.ts')
          ? [`${dir}/${e.name}`]
          : [],
    );
  const sources = libFiles('lib').map((f) => [f, read(`infra/${f}`)] as const);

  it('are imported, never copied into infra/lib', () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(
        /export const (QUEUE_NAMES|SCHEDULED_JOB_TYPES|S3_PREFIXES|SQS_MAX_VISIBILITY_TIMEOUT_SECONDS|QUEUE_URL_ENV|QUEUE_VISIBILITY_TIMEOUT_ENV|COGNITO_ENV|REKOGNITION_LIMITS)\b/,
      );
      // Job types, prefixes and queue env names appear only through the imports.
      for (const type of SCHEDULED_JOB_TYPES) expect(source, file).not.toContain(`'${type}'`);
      expect(source, file).not.toMatch(/'(originals|derived|tmp|tmp\/index|tmp\/zips)\/'/);
      expect(source, file).not.toMatch(/_QUEUE_(URL|VISIBILITY_TIMEOUT_SECONDS)`/);
      expect(source, file).not.toMatch(/'COGNITO_[A-Z_]+'|\bCOGNITO_[A-Z_]+: /);
    }
  });
});
