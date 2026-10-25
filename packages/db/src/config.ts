import { checkServerIdentity, type ConnectionOptions } from 'node:tls';
import { type Env, parseEnv } from '@shotx/shared';
import type { PoolConfig } from 'pg';
import { z } from 'zod';

/**
 * libpq `sslmode` values this platform supports. `allow` and `prefer` are rejected: they fall
 * back between TLS and plaintext, which node-postgres can't do, so honouring them would be a lie.
 */
export const SSL_MODES = ['disable', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

const sslMode = z.enum(SSL_MODES, {
  error: () =>
    'must be disable, require, verify-ca or verify-full (allow and prefer are not supported)',
});
const port = z.coerce.number().int().min(1).max(65_535);

const pgEnvSchema = z.object({
  PGHOST: z.string().min(1),
  PGPORT: port.default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().optional(),
  // Required: the libpq form is what ECS tasks use, so it must say how it does TLS.
  PGSSLMODE: sslMode,
});

const poolEnvSchema = z.object({
  /** Connections per pool (per process). */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

export interface DatabaseConfig {
  /** Which form the settings came from. */
  source: 'DATABASE_URL' | 'PG';
  host: string;
  port: number;
  database: string;
  user: string;
  password: string | undefined;
  sslMode: SslMode;
  poolMax: number;
}

const URL_PARAMS = new Set(['sslmode']);

function fail(reason: string): never {
  // Never include the URL or password: this ends up in logs.
  throw new Error(`Invalid database configuration: ${reason}`);
}

function parseDatabaseUrl(raw: string): Omit<DatabaseConfig, 'poolMax'> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL is not a valid URL');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    fail('DATABASE_URL must start with postgres:// or postgresql://');
  }
  const unsupported = [...url.searchParams.keys()].filter((key) => !URL_PARAMS.has(key));
  if (unsupported.length > 0) {
    fail(`DATABASE_URL has unsupported parameters: ${unsupported.join(', ')} (only sslmode)`);
  }
  const decode = (value: string, what: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return fail(`DATABASE_URL ${what} is not valid URL encoding`);
    }
  };
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const database = decode(url.pathname.replace(/^\//, ''), 'database name');
  const user = decode(url.username, 'user');
  if (host === '') fail('DATABASE_URL has no host');
  if (database === '' || database.includes('/')) fail('DATABASE_URL must name one database');
  if (user === '') fail('DATABASE_URL has no user');
  const mode = sslMode.safeParse(url.searchParams.get('sslmode') ?? 'disable');
  if (!mode.success) fail(`DATABASE_URL sslmode ${mode.error.issues[0]?.message ?? 'is invalid'}`);
  return {
    source: 'DATABASE_URL',
    host,
    port: url.port === '' ? 5432 : Number(url.port),
    database,
    user,
    password: url.password === '' ? undefined : decode(url.password, 'password'),
    sslMode: mode.data,
  };
}

/**
 * Reads the PostgreSQL connection from the environment, in one of two forms:
 *
 * - `DATABASE_URL=postgres://user:password@host:5432/db?sslmode=...` (local development and
 *   tests). Without `sslmode` the connection is plaintext (`disable`), matching docker compose.
 * - The libpq variables PGHOST, PGPORT (default 5432), PGDATABASE, PGUSER, PGPASSWORD and
 *   PGSSLMODE (required). ECS tasks get this form with PGSSLMODE=verify-full.
 *
 * DATABASE_URL wins when both are set; the PG* variables are then ignored entirely.
 */
export function loadDatabaseConfig(env: Env): DatabaseConfig {
  const { DATABASE_POOL_MAX: poolMax } = parseEnv(poolEnvSchema, env, 'database');
  const url = env.DATABASE_URL;
  if (url !== undefined && url !== '') return { ...parseDatabaseUrl(url), poolMax };
  if (['PGHOST', 'PGDATABASE', 'PGUSER'].every((k) => (env[k] ?? '') === '')) {
    fail('set DATABASE_URL, or PGHOST, PGDATABASE, PGUSER and PGSSLMODE');
  }
  const e = parseEnv(pgEnvSchema, env, 'database');
  return {
    source: 'PG',
    host: e.PGHOST,
    port: e.PGPORT,
    database: e.PGDATABASE,
    user: e.PGUSER,
    password: e.PGPASSWORD,
    sslMode: e.PGSSLMODE,
    poolMax,
  };
}

/**
 * node-postgres TLS options for an sslmode, mapped explicitly:
 * - `disable`: no TLS.
 * - `require`: TLS without certificate verification (encryption only).
 * - `verify-ca`: TLS; the certificate must chain to a trusted CA, the host name isn't checked.
 * - `verify-full`: TLS; trusted chain and the host name must match the certificate.
 *
 * Trusted CAs are Node's plus NODE_EXTRA_CA_CERTS, which the images point at the RDS CA bundle.
 */
export function pgSslOptions(mode: SslMode): false | ConnectionOptions {
  switch (mode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify-ca':
      return { rejectUnauthorized: true, checkServerIdentity: () => undefined };
    case 'verify-full':
      return { rejectUnauthorized: true, checkServerIdentity };
  }
}

/**
 * Pool settings with every connection field set explicitly, so node-postgres never fills one in
 * from PG* variables or parses a connection string itself. (It still falls back to PGPASSWORD
 * when no password is given; set the password in the URL or PGPASSWORD, not both.)
 */
export function pgPoolConfig(config: DatabaseConfig): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: pgSslOptions(config.sslMode),
    max: config.poolMax,
  };
}
