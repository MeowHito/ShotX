import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { secret } from './fields';
import { isPrivateHost } from './ip';

/**
 * `redis://host[:port][/db]` or `rediss://` (TLS). Credentials in the URL are rejected: they would
 * end up wherever the URL is logged. Error messages never repeat the value.
 */
const redisUrl = z.string().transform((value, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: 'custom', message });
    return z.NEVER;
  };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('must be an absolute URL');
  }
  if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
    return fail('must start with redis:// or rediss://');
  }
  if (url.username !== '' || url.password !== '') {
    return fail('must not contain credentials (use REDIS_USERNAME and REDIS_PASSWORD)');
  }
  if (url.hostname === '') return fail('must have a host');
  if (url.search !== '' || url.hash !== '') return fail('must not have a query or fragment');
  if (!/^\/?(\d{1,2})?$/.test(url.pathname)) return fail('path must be empty or a database number');
  return value;
});

/**
 * Hostname of a redis:// URL (already validated), lowercased; brackets kept off IPv6 literals.
 */
function redisHost(url: string): string {
  return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
}

const redisEnvSchema = z
  .object({
    REDIS_URL: redisUrl,
    REDIS_USERNAME: secret().optional(),
    REDIS_PASSWORD: secret().optional(),
    /**
     * Allow REDIS_USERNAME/REDIS_PASSWORD over plain `redis://` (the VPS compose Redis on its
     * private network, ADR 0008 section 3). Only for a private host (isPrivateHost: a compose
     * service name such as `redis`, localhost, or a private IP); never set by infra on AWS.
     */
    REDIS_ALLOW_PLAINTEXT_AUTH: z.stringbool().default(false),
  })
  .refine((e) => (e.REDIS_USERNAME === undefined) === (e.REDIS_PASSWORD === undefined), {
    error: 'REDIS_USERNAME and REDIS_PASSWORD must be set together (or both left empty)',
  })
  .refine(
    (e) =>
      e.REDIS_PASSWORD === undefined ||
      e.REDIS_URL.startsWith('rediss:') ||
      e.REDIS_ALLOW_PLAINTEXT_AUTH,
    {
      error:
        'REDIS_URL must use rediss:// (TLS) when REDIS_USERNAME and REDIS_PASSWORD are set, unless REDIS_ALLOW_PLAINTEXT_AUTH=true for a private host',
    },
  )
  .refine(
    (e) =>
      e.REDIS_PASSWORD === undefined ||
      e.REDIS_URL.startsWith('rediss:') ||
      !e.REDIS_ALLOW_PLAINTEXT_AUTH ||
      isPrivateHost(redisHost(e.REDIS_URL)),
    {
      error:
        'REDIS_ALLOW_PLAINTEXT_AUTH needs a private REDIS_URL host (a compose service name, localhost or a private IP); use rediss:// otherwise',
    },
  );

/** An ElastiCache RBAC user. Secret: never log it. */
export interface RedisCredentials {
  username: string;
  password: string;
}

export interface RedisConfig {
  /** Connection URL without credentials. */
  url: string;
  /** True for `rediss://`. */
  tls: boolean;
  /** Null when Redis has no AUTH (local development). */
  credentials: RedisCredentials | null;
}

/**
 * Reads REDIS_URL (required; api and worker) and the optional RBAC credentials REDIS_USERNAME and
 * REDIS_PASSWORD, which must come together. Credentials need TLS (`rediss://`), except over plain
 * `redis://` with REDIS_ALLOW_PLAINTEXT_AUTH=true and a private host (the VPS compose network,
 * where the password never leaves the machine). Connect with e.g.
 * `new Redis(config.url, { ...config.credentials })`.
 */
export function loadRedisConfig(env: Env): RedisConfig {
  const e = parseEnv(redisEnvSchema, env, 'Redis');
  return {
    url: e.REDIS_URL,
    tls: e.REDIS_URL.startsWith('rediss:'),
    credentials:
      e.REDIS_USERNAME !== undefined && e.REDIS_PASSWORD !== undefined
        ? { username: e.REDIS_USERNAME, password: e.REDIS_PASSWORD }
        : null,
  };
}
