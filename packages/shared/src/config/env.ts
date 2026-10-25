import { z } from 'zod';

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Parses environment variables with a zod schema. Empty strings count as unset, so `FOO=` in a
 * compose file falls back to the default instead of coercing to 0.
 */
export function parseEnv<T extends z.ZodType>(schema: T, env: Env, name: string): z.output<T> {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const result = schema.safeParse(present);
  if (!result.success) {
    throw new Error(`Invalid ${name} configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
