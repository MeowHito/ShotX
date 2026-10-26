import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { NODE_ENVS } from './runtime';

// Internal: not re-exported from the package (local-dev.ts re-exports LOCAL_DEV_APP_STAGE).

/** The only APP_STAGE that may use the local development stand-ins. */
export const LOCAL_DEV_APP_STAGE = 'local';

const localGateSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  APP_STAGE: z.string().optional(),
});

/** True on APP_STAGE=local with a non-production NODE_ENV. */
export function isLocalStage(env: Env, name: string): boolean {
  const e = parseEnv(localGateSchema, env, name);
  return e.APP_STAGE === LOCAL_DEV_APP_STAGE && e.NODE_ENV !== 'production';
}

/**
 * Throws unless APP_STAGE=local with a non-production NODE_ENV: an allowlist, so a mistyped stage
 * name can never enable a local stand-in.
 */
export function assertLocalStage(env: Env, what: string, name: string): void {
  if (!isLocalStage(env, name)) {
    throw new Error(
      `Invalid ${name} configuration: ${what} needs APP_STAGE=${LOCAL_DEV_APP_STAGE} and a non-production NODE_ENV`,
    );
  }
}
