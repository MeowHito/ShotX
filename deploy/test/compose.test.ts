import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDatabaseConfig } from '@shotx/db';
import {
  BFF_CLIENT_IP_HEADER,
  BFF_KEY_HEADER,
  type Env,
  loadApiLimitsConfig,
  loadAppConfig,
  loadAuthClientConfig,
  loadAuthProviderConfig,
  loadBffAuthConfig,
  loadBillingConfig,
  loadCaptchaClientConfig,
  loadCaptchaConfig,
  loadConsentConfig,
  loadDriveConfig,
  loadEmailConfig,
  loadFaceConfig,
  loadFaceSearchUploadConfig,
  loadFeatureFlags,
  loadInternalApiConfig,
  loadMediaBrowserOrigins,
  loadMediaStorageConfig,
  loadMediaUrlSignerConfig,
  loadPaymentGatewayConfig,
  loadQueueBackendConfig,
  loadRedisConfig,
  loadFaceRekognitionClientConfig,
  loadRetentionConfig,
  loadScheduledJobsConfig,
  loadServerConfig,
  loadSesClientConfig,
  loadShareConfig,
  loadSharePasswordHashConfig,
  loadShotxAuthConfig,
  loadTrustedProxyConfig,
  loadUploadConfig,
  loadWorkerSettings,
  QUEUE_NAMES,
} from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { loadBackupConfig, loadMonitorConfig } from '../ops/config';

type Json = Record<string, unknown>;
type Loader = (env: Env) => unknown;

const deployDir = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(deployDir, path), 'utf8');

/** KEY=VALUE lines of an env file. */
function parseEnvFile(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

const production = parseEnvFile(read('.env.production.example'));

describe('.env.production.example', () => {
  it('gives the worker its shutdown grace plus at least 5 s before SIGKILL', () => {
    const grace = Number(production.WORKER_SHUTDOWN_GRACE_SECONDS);
    const stop = /^(\d+)s$/.exec(production.WORKER_STOP_GRACE_PERIOD ?? '');
    expect(stop).not.toBeNull();
    expect(Number(stop?.[1])).toBeGreaterThanOrEqual(grace + 5);
  });

  it('puts the proxy address inside the edge subnet', () => {
    const [net = '', bits = '32'] = (production.SHOTX_EDGE_SUBNET ?? '').split('/');
    const n = (ip: string) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
    const block = 2 ** (32 - Number(bits));
    expect(Math.floor(n(production.SHOTX_PROXY_IP ?? '') / block)).toBe(Math.floor(n(net) / block));
  });
});

describe('Caddyfile', () => {
  const caddy = read('caddy/Caddyfile');

  it('strips the headers only web may set, and client-sent forwarding headers', () => {
    for (const h of [BFF_KEY_HEADER, BFF_CLIENT_IP_HEADER, 'x-forwarded-for', 'cf-connecting-ip']) {
      expect(caddy.toLowerCase(), h).toContain(`request_header -${h}`);
    }
  });

  it('trusts no upstream proxy, buffers no bodies and logs no headers', () => {
    expect(caddy).not.toMatch(/^\s*trusted_proxies/m);
    expect(caddy).not.toMatch(/^\s*request_buffers/m);
    expect(caddy).not.toMatch(/log_credentials/);
    expect(caddy).toMatch(/request>headers delete/);
  });

  it('routes the selfie uploads, /api and everything else', () => {
    expect(caddy).toContain('^/api/s/[^/]+/face-(search|deletion)$');
    expect(caddy).toMatch(/handle \/api\/\* \{[\s\S]*reverse_proxy api:4000/);
    expect(caddy).toMatch(/handle \{[\s\S]*reverse_proxy web:3000/);
  });
});

// --- docker compose config --------------------------------------------------------------------

const docker = spawnSync('docker', ['compose', 'version'], { timeout: 10_000 });
const hasCompose = docker.status === 0;

function composeConfig(): Json {
  const dir = mkdtempSync(join(tmpdir(), 'shotx-env-'));
  for (const f of readdirSync(join(deployDir, 'env'))) {
    if (f.endsWith('.env.example')) {
      copyFileSync(join(deployDir, 'env', f), join(dir, f.replace(/\.example$/, '')));
    }
  }
  const out = spawnSync(
    'docker',
    [
      'compose',
      '--env-file',
      '.env.production.example',
      '-f',
      'docker-compose.yml',
      'config',
      '--format',
      'json',
    ],
    {
      cwd: deployDir,
      timeout: 60_000,
      env: { ...process.env, SHOTX_ENV_DIR: dir, REDIS_ACL_FILE: './redis/users.acl.example' },
      encoding: 'utf8',
    },
  );
  if (out.status !== 0) throw new Error(`docker compose config failed: ${out.stderr}`);
  return JSON.parse(out.stdout) as Json;
}

/** Valid stand-ins for the REPLACE_ME secrets, so the loaders can run on the examples. */
function secretSamples(): Record<string, string> {
  const ed25519 = () =>
    generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'der', type: 'pkcs8' })
      .toString('base64');
  const random = () => randomBytes(36).toString('base64url');
  return {
    AUTH_BFF_KEY: random(),
    AUTH_USERS_SIGNING_KEY: ed25519(),
    AUTH_ADMINS_SIGNING_KEY: ed25519(),
    ADMIN_TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    REKOGNITION_ACCESS_KEY_ID: 'AKIAEXAMPLE000000001',
    SES_ACCESS_KEY_ID: 'AKIAEXAMPLE000000002',
    LINE_LOGIN_CHANNEL_ID: '1234567890',
    GOOGLE_OAUTH_CLIENT_ID: '1234-abc.apps.googleusercontent.com',
    TURNSTILE_SITE_KEY: '0x4AAAAAAAexampleSiteKey',
    TURNSTILE_SECRET_KEY: '0x4AAAAAAAexampleSecretKeyxxxxxxxxxxxx',
    STORAGE_ENDPOINT_URL: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    BACKUP_ENDPOINT_URL: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
    BACKUP_AGE_RECIPIENTS: 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p',
  };
}

function withSamples(env: Record<string, string>): Record<string, string> {
  const samples = secretSamples();
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => {
      if (samples[k] !== undefined && (v.includes('REPLACE_ME') || v.includes('ACCOUNT_ID'))) {
        return [k, samples[k]];
      }
      return [k, v.includes('REPLACE_ME') ? randomBytes(36).toString('base64url') : v];
    }),
  );
}

const LOADERS: Record<string, Loader[]> = {
  web: [
    loadAppConfig,
    (e) => loadServerConfig(e, 3000),
    loadInternalApiConfig,
    loadAuthProviderConfig,
    loadBffAuthConfig,
    loadAuthClientConfig,
    loadUploadConfig,
    loadMediaBrowserOrigins,
    loadCaptchaClientConfig,
  ],
  api: [
    loadAppConfig,
    (e) => loadServerConfig(e, 4000),
    loadDatabaseConfig,
    loadMediaStorageConfig,
    loadMediaUrlSignerConfig,
    loadRedisConfig,
    (e) => loadQueueBackendConfig(e, ['media', 'faces', 'zip']),
    loadAuthProviderConfig,
    loadShotxAuthConfig,
    loadBffAuthConfig,
    loadTrustedProxyConfig,
    loadFaceConfig,
    loadFaceSearchUploadConfig,
    loadFaceRekognitionClientConfig,
    loadSesClientConfig,
    loadApiLimitsConfig,
    loadFeatureFlags,
    loadConsentConfig,
    loadShareConfig,
    loadUploadConfig,
    loadDriveConfig,
    loadSharePasswordHashConfig,
    loadRetentionConfig,
    loadBillingConfig,
    loadPaymentGatewayConfig,
    loadEmailConfig,
    loadCaptchaConfig,
  ],
  worker: [
    loadAppConfig,
    loadDatabaseConfig,
    loadMediaStorageConfig,
    loadRedisConfig,
    (e) => loadQueueBackendConfig(e, QUEUE_NAMES),
    loadScheduledJobsConfig,
    loadFaceConfig,
    loadFaceRekognitionClientConfig,
    loadSesClientConfig,
    loadWorkerSettings,
    loadFeatureFlags,
    loadShareConfig,
    loadRetentionConfig,
    loadBillingConfig,
    loadPaymentGatewayConfig,
    loadEmailConfig,
  ],
  migrate: [loadDatabaseConfig],
  monitor: [
    loadMonitorConfig,
    loadDatabaseConfig,
    loadRedisConfig,
    loadFaceConfig,
    loadWorkerSettings,
  ],
  backup: [loadBackupConfig, loadDatabaseConfig],
};

describe.skipIf(!hasCompose)('docker compose config', () => {
  const config = hasCompose ? composeConfig() : {};
  const services = (config.services ?? {}) as Record<string, Json>;
  const env = (name: string) => (services[name]?.environment ?? {}) as Record<string, string>;

  it('publishes ports from the proxy only', () => {
    const published = Object.entries(services)
      .filter(([, s]) => Array.isArray(s.ports) && s.ports.length > 0)
      .map(([n]) => n);
    expect(published).toEqual(['proxy']);
  });

  it('trusts exactly the proxy address for X-Forwarded-For', () => {
    const proxyNet = (services.proxy?.networks as Record<string, { ipv4_address?: string }>).edge;
    expect(env('api').TRUSTED_PROXY_ADDRESSES).toBe(proxyNet?.ipv4_address);
    expect(env('api').TRUSTED_PROXY_ADDRESSES).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it('runs api and worker on BullMQ, API-issued auth, presigned R2 URLs and no AWS endpoint', () => {
    for (const s of ['api', 'worker']) {
      expect(env(s), s).toMatchObject({
        NODE_ENV: 'production',
        QUEUE_BACKEND: 'bullmq',
        AUTH_PROVIDER: 'shotx',
        MEDIA_URL_SIGNER: 's3-presign',
        AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
        REDIS_ALLOW_PLAINTEXT_AUTH: 'true',
        PGSSLMODE: 'disable',
      });
      for (const k of ['AWS_ENDPOINT_URL', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']) {
        expect(env(s)[k], `${s} ${k}`).toBeUndefined();
      }
    }
  });

  it('keeps Postgres and Redis on the internal data network only', () => {
    const networks = (config.networks ?? {}) as Record<string, Json>;
    expect(networks.data?.internal).toBe(true);
    for (const s of ['postgres', 'redis']) {
      expect(Object.keys(services[s]?.networks as Json), s).toEqual(['data']);
    }
  });

  it('limits, restarts and rotates the logs of every service', () => {
    for (const [name, s] of Object.entries(services)) {
      const limits = ((s.deploy as Json | undefined)?.resources as Json | undefined)
        ?.limits as Json;
      expect(limits?.memory, name).toBeDefined();
      expect(limits?.cpus, name).toBeDefined();
      expect((s.logging as Json | undefined)?.driver, name).toBe('local');
      expect(s.restart, name).toBeDefined();
    }
  });

  it('starts api and worker only after a successful migrate', () => {
    for (const s of ['api', 'worker']) {
      expect((services[s]?.depends_on as Json).migrate, s).toMatchObject({
        condition: 'service_completed_successfully',
      });
    }
  });

  it('configures Redis with noeviction, an explicit maxmemory, AOF everysec and an ACL file', () => {
    const cmd = (services.redis?.command as string[]).join(' ');
    expect(cmd).toMatch(/--maxmemory-policy noeviction/);
    expect(cmd).toMatch(/--maxmemory \d+[kmg]b/);
    expect(cmd).toMatch(/--appendonly yes --appendfsync everysec/);
    expect(cmd).toMatch(/--aclfile /);
  });

  for (const [service, loaders] of Object.entries(LOADERS)) {
    it(`${service}: the shared loaders accept the example env once the secrets are filled in`, () => {
      const filled = withSamples(env(service));
      for (const load of loaders) expect(() => load(filled)).not.toThrow();
    });
  }

  it('refuses to start api while a secret is still REPLACE_ME', () => {
    const raw = env('api');
    const failures = LOADERS.api?.filter((load) => {
      try {
        load(raw);
        return false;
      } catch {
        return true;
      }
    });
    expect(failures?.length).toBeGreaterThan(0);
  });
});
