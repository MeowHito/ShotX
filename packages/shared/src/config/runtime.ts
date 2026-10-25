import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { httpUrl, int } from './fields';

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

const appEnvSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  /** Same format as the infra stage name (infra/lib/config.ts). */
  APP_STAGE: z.string().regex(/^[a-z][a-z0-9-]{1,15}$/, {
    error: 'must be 2-16 characters: a lowercase letter, then lowercase letters, digits or -',
  }),
  PUBLIC_BASE_URL: httpUrl({ httpsOnly: true }),
  ADMIN_BASE_URL: httpUrl({ httpsOnly: true }),
});

/** Settings every service gets (web, admin, api and worker). */
export interface AppConfig {
  nodeEnv: NodeEnv;
  /** Deployment stage, e.g. `local`, `staging`, `prod`. */
  stage: string;
  /** Origin of the main site (studio, share pages, `/api`, `/media`), without a trailing slash. */
  publicBaseUrl: string;
  /** Origin of the admin app, without a trailing slash. */
  adminBaseUrl: string;
}

/**
 * Reads NODE_ENV (default `development`), APP_STAGE and the public origins PUBLIC_BASE_URL and
 * ADMIN_BASE_URL. The origins must be https except on localhost.
 */
export function loadAppConfig(env: Env): AppConfig {
  const e = parseEnv(appEnvSchema, env, 'app');
  return {
    nodeEnv: e.NODE_ENV,
    stage: e.APP_STAGE,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    adminBaseUrl: e.ADMIN_BASE_URL,
  };
}

export interface ServerConfig {
  /** TCP port the HTTP server listens on. */
  port: number;
}

/**
 * Reads PORT, the port an HTTP service (web, admin, api) listens on. infra sets it on AWS; locally
 * each app passes its own default.
 */
export function loadServerConfig(env: Env, defaultPort: number): ServerConfig {
  const schema = z.object({ PORT: int(1, 65_535).default(defaultPort) });
  return { port: parseEnv(schema, env, 'server').PORT };
}

const internalApiEnvSchema = z.object({ API_INTERNAL_URL: httpUrl() });

export interface InternalApiConfig {
  /**
   * Origin web and admin use to call the API server-side (the internal ALB on AWS), without a
   * trailing slash. API routes are under `/api` on it.
   */
  apiInternalUrl: string;
}

/** Reads API_INTERNAL_URL (web and admin). Plain http is fine: it never leaves the VPC. */
export function loadInternalApiConfig(env: Env): InternalApiConfig {
  return { apiInternalUrl: parseEnv(internalApiEnvSchema, env, 'internal API').API_INTERNAL_URL };
}
