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
  loadAdminConsoleConfig,
  loadAdminPasswordUiConfig,
  loadApiLimitsConfig,
  loadAppConfig,
  loadAuthClientConfig,
  loadAuthProviderConfig,
  loadAdminBffAuthConfig,
  loadBffAuthConfig,
  loadBffKeysConfig,
  loadBillingConfig,
  loadBillingModeConfig,
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
  loadPhotographerPasswordPolicy,
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
  loadStorageQuotaConfig,
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

  /** The body of the site block that starts with `address {` (top level, tab-indented). */
  const site = (address: string): string => {
    const start = caddy.indexOf(`\n${address} {\n`);
    expect(start, address).toBeGreaterThanOrEqual(0);
    const end = caddy.indexOf('\n}\n', start);
    return caddy.slice(start, end);
  };
  const main = site('{$SHOTX_DOMAIN}');
  const admin = site('{$SHOTX_ADMIN_DOMAIN}');

  it('answers 404 for the api admin routes on the main domain, before any proxying', () => {
    const matcher = /@adminApi path ([^\n]+)/.exec(main)?.[1]?.split(' ');
    expect(matcher).toEqual(['/api/admin', '/api/admin/*', '/api/auth/admin', '/api/auth/admin/*']);
    const block = main.indexOf('handle @adminApi {\n\t\t\trespond 404\n\t\t}');
    expect(block).toBeGreaterThan(main.indexOf('route {'));
    expect(block).toBeLessThan(main.indexOf('reverse_proxy'));
  });

  it('sends the whole admin subdomain to admin:3001 and nothing to api or web', () => {
    expect(admin).toMatch(/reverse_proxy admin:3001/);
    expect(admin).not.toMatch(/api:4000|web:3000/);
    expect(admin).toMatch(/max_size \{\$PROXY_ADMIN_MAX_BODY\}/);
  });

  it('gives both sites the same header stripping, security headers and access log', () => {
    const snippet = /\n\(edge_common\) \{\n([\s\S]*?)\n\}\n/.exec(caddy)?.[1] ?? '';
    for (const h of [BFF_KEY_HEADER, BFF_CLIENT_IP_HEADER, 'x-forwarded-for', 'forwarded']) {
      expect(snippet.toLowerCase(), h).toContain(`request_header -${h}\n`);
    }
    expect(snippet).toMatch(/Strict-Transport-Security "max-age=\d+; includeSubDomains"/);
    expect(snippet).toMatch(/-Server/);
    expect(snippet).toMatch(/request>headers delete/);
    for (const block of [main, admin]) expect(block).toMatch(/^\timport edge_common$/m);
    // The header strips live only in the snippet, so neither site can drift.
    expect(caddy.match(/request_header -X-Forwarded-For/g)).toHaveLength(1);
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
    AUTH_ADMIN_BFF_KEY: random(),
    AUTH_USERS_SIGNING_KEY: ed25519(),
    AUTH_ADMINS_SIGNING_KEY: ed25519(),
    ADMIN_TOTP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    // Commented out in the examples (email off, no LINE/Google at launch); used by the
    // "switched on later" case below.
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
    loadBillingModeConfig,
    loadPhotographerPasswordPolicy,
  ],
  admin: [
    loadAppConfig,
    (e) => loadServerConfig(e, 3001),
    loadInternalApiConfig,
    loadAuthProviderConfig,
    loadAdminBffAuthConfig,
    loadAuthClientConfig,
    loadAdminPasswordUiConfig,
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
    loadBffKeysConfig,
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
    loadBillingModeConfig,
    loadPaymentGatewayConfig,
    loadStorageQuotaConfig,
    loadAdminConsoleConfig,
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
    loadBillingModeConfig,
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

  it('runs the admin app on the edge network behind the proxy, reaching the api directly', () => {
    const admin = services.admin as Json;
    expect((admin.build as Json).dockerfile).toBe('apps/admin/Dockerfile');
    expect(Object.keys(admin.networks as Json)).toEqual(['edge']);
    expect(admin.ports ?? []).toEqual([]);
    expect(admin.read_only).toBe(true);
    expect(admin.cap_drop).toEqual(['ALL']);
    expect(admin.security_opt).toContain('no-new-privileges:true');
    expect(env('admin')).toMatchObject({
      NODE_ENV: 'production',
      PORT: '3001',
      AUTH_PROVIDER: 'shotx',
      API_INTERNAL_URL: 'http://api:4000',
    });
    expect(String(env('admin').ADMIN_BASE_URL)).toMatch(/^https:\/\//);
    expect(String(env('admin').PUBLIC_BASE_URL)).toMatch(/^https:\/\//);
    expect((admin.depends_on as Json).api).toMatchObject({ condition: 'service_healthy' });
    expect(JSON.stringify((admin.healthcheck as Json).test)).toContain(
      'http://127.0.0.1:3001/healthz',
    );
    // The main site never waits for the admin app.
    expect(services.proxy?.depends_on as Json).not.toHaveProperty('admin');
    // Only the api's own secrets and keys stay out of the admin app.
    for (const k of [
      'PGPASSWORD',
      'REDIS_PASSWORD',
      'STORAGE_SECRET_ACCESS_KEY',
      'IP_HASH_SECRET',
    ]) {
      expect(env('admin'), k).not.toHaveProperty(k);
    }
  });

  it('gives the proxy the admin domain, matching ADMIN_BASE_URL', () => {
    const proxy = env('proxy');
    expect(proxy.SHOTX_ADMIN_DOMAIN).toBe(production.SHOTX_ADMIN_DOMAIN);
    expect(env('admin').ADMIN_BASE_URL).toBe(`https://${proxy.SHOTX_ADMIN_DOMAIN}`);
    expect(env('web').PUBLIC_BASE_URL).toBe(`https://${proxy.SHOTX_DOMAIN}`);
    expect(proxy.PROXY_ADMIN_MAX_BODY).toBeDefined();
  });

  it('shares the password and refresh settings across api, web and admin', () => {
    for (const k of [
      'ADMIN_PASSWORD_MIN_LENGTH',
      'PHOTOGRAPHER_PASSWORD_MIN_LENGTH',
      'AUTH_REFRESH_REUSE_GRACE_SECONDS',
    ]) {
      expect(env('admin')[k], k).toBeDefined();
      expect(env('web')[k], k).toBe(env('admin')[k]);
      expect(env('api')[k], k).toBe(env('admin')[k]);
    }
  });

  it('gives web and admin each their own BFF key, and the api both', () => {
    const has = (s: string, k: string) => Object.hasOwn(env(s), k);
    expect(['web', 'api'].map((s) => has(s, 'AUTH_BFF_KEY'))).toEqual([true, true]);
    expect(['admin', 'api'].map((s) => has(s, 'AUTH_ADMIN_BFF_KEY'))).toEqual([true, true]);
    expect(has('web', 'AUTH_ADMIN_BFF_KEY')).toBe(false);
    expect(has('admin', 'AUTH_BFF_KEY')).toBe(false);
    for (const [name] of Object.entries(services).filter(
      ([n]) => !['web', 'admin', 'api'].includes(n),
    )) {
      expect(has(name, 'AUTH_BFF_KEY') || has(name, 'AUTH_ADMIN_BFF_KEY'), name).toBe(false);
    }
    // The api refuses equal keys.
    const api = withSamples(env('api'));
    expect(() => loadBffKeysConfig(api)).not.toThrow();
    expect(() => loadBffKeysConfig({ ...api, AUTH_ADMIN_BFF_KEY: api.AUTH_BFF_KEY ?? '' })).toThrow(
      /AUTH_ADMIN_BFF_KEY/,
    );
  });

  it('runs billing offline: no gateway setting or secret anywhere (ADR 0010)', () => {
    for (const s of ['web', 'api', 'worker']) expect(env(s).BILLING_MODE, s).toBe('offline');
    for (const [name] of Object.entries(services)) {
      expect(
        Object.keys(env(name)).filter((k) => k.startsWith('PAYMENT_')),
        name,
      ).toEqual([]);
    }
    expect(loadPaymentGatewayConfig(withSamples(env('api')))).toBeNull();
    expect(loadStorageQuotaConfig(env('api')).enforced).toBe(false);
  });

  it('launches with email off and no LINE/Google sign-in (no SES_* or OIDC keys anywhere)', () => {
    for (const s of ['api', 'worker']) {
      const e = withSamples(env(s));
      expect(e.EMAIL_PROVIDER, s).toBe('off');
      expect(e, s).not.toHaveProperty('EMAIL_FROM_ADDRESS');
      expect(loadEmailConfig(e), s).toEqual({ provider: 'off', from: null });
      expect(loadSesClientConfig(e), s).toBeNull();
    }
    for (const [name] of Object.entries(services)) {
      const keys = Object.keys(env(name));
      expect(
        keys.filter((k) =>
          /^(SES_ACCESS_KEY_ID|SES_SECRET_ACCESS_KEY|LINE_LOGIN_|GOOGLE_OAUTH_)/.test(k),
        ),
        name,
      ).toEqual([]);
    }
    expect(() => loadShotxAuthConfig(withSamples(env('api')))).not.toThrow();
  });

  it('accepts SES and LINE/Google once switched on, and refuses a leftover REPLACE_ME', () => {
    const samples = secretSamples();
    const on = (s: string) => ({
      ...withSamples(env(s)),
      EMAIL_PROVIDER: 'ses',
      EMAIL_FROM_ADDRESS: 'no-reply@photos.example.com',
      SES_ACCESS_KEY_ID: samples.SES_ACCESS_KEY_ID ?? '',
      SES_SECRET_ACCESS_KEY: randomBytes(30).toString('base64'),
    });
    for (const s of ['api', 'worker']) {
      const e = on(s);
      expect(loadEmailConfig(e).provider, s).toBe('ses');
      expect(loadSesClientConfig(e), s).not.toBeNull();
    }
    const oidc = {
      ...on('api'),
      LINE_LOGIN_CHANNEL_ID: samples.LINE_LOGIN_CHANNEL_ID ?? '',
      LINE_LOGIN_CHANNEL_SECRET: randomBytes(24).toString('hex'),
      GOOGLE_OAUTH_CLIENT_ID: samples.GOOGLE_OAUTH_CLIENT_ID ?? '',
      GOOGLE_OAUTH_CLIENT_SECRET: randomBytes(24).toString('base64url'),
    };
    for (const load of LOADERS.api ?? []) expect(() => load(oidc)).not.toThrow();
    expect(() =>
      loadShotxAuthConfig({ ...oidc, LINE_LOGIN_CHANNEL_SECRET: 'REPLACE_ME' }),
    ).toThrow();
    expect(() => loadShotxAuthConfig({ ...oidc, LINE_LOGIN_CHANNEL_ID: 'REPLACE_ME' })).toThrow();
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

  for (const service of ['api', 'admin']) {
    it(`refuses to start ${service} while a secret is still REPLACE_ME`, () => {
      const raw = env(service);
      const failures = LOADERS[service]?.filter((load) => {
        try {
          load(raw);
          return false;
        } catch {
          return true;
        }
      });
      expect(failures?.length).toBeGreaterThan(0);
    });
  }
});
