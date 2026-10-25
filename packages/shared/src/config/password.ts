import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { int } from './fields';

/** argon2id cost parameters: memory in KiB, passes (time cost) and lanes (parallelism). */
export interface Argon2idParams {
  memoryKiB: number;
  timeCost: number;
  parallelism: number;
}

/**
 * OWASP Password Storage Cheat Sheet, argon2id: equivalent minimum configurations (all with
 * parallelism 1). A configuration is acceptable when its memory is at least the minimum for its
 * time cost; 5 passes or more need 7 MiB (7168 KiB).
 */
export const OWASP_ARGON2ID_MIN_MEMORY_KIB_BY_TIME_COST: Readonly<Record<number, number>> = {
  1: 47_104,
  2: 19_456,
  3: 12_288,
  4: 9_216,
  5: 7_168,
};

/**
 * Bounds of the configurable parameters, and of the parameters the API accepts when it verifies a
 * stored hash (a PHC string carries its own parameters, so old hashes keep verifying after the
 * configuration changes). Upper bounds stop a corrupt row from making the API burn memory or CPU.
 * The API's verifier must use these bounds (and accept any time cost in range), so every hash the
 * configuration can produce also verifies.
 */
export const ARGON2ID_PARAM_BOUNDS = {
  memoryKiB: { min: 7_168, max: 262_144 },
  timeCost: { min: 1, max: 10 },
  parallelism: { min: 1, max: 8 },
} as const;

/** Smallest memory OWASP accepts for `timeCost` passes. */
export function owaspArgon2idMinMemoryKiB(timeCost: number): number {
  if (!Number.isInteger(timeCost) || timeCost < 1) {
    throw new RangeError(`timeCost must be a positive integer, got ${timeCost}`);
  }
  return OWASP_ARGON2ID_MIN_MEMORY_KIB_BY_TIME_COST[Math.min(timeCost, 5)] as number;
}

/**
 * True when the parameters are within ARGON2ID_PARAM_BOUNDS, meet OWASP's minimum for their time
 * cost, and give argon2 at least 8 KiB per lane (its own requirement).
 */
export function argon2idParamsAcceptable(params: Argon2idParams): boolean {
  const { memoryKiB, timeCost, parallelism } = params;
  const b = ARGON2ID_PARAM_BOUNDS;
  const inRange = (v: number, r: { min: number; max: number }) =>
    Number.isInteger(v) && v >= r.min && v <= r.max;
  return (
    inRange(memoryKiB, b.memoryKiB) &&
    inRange(timeCost, b.timeCost) &&
    inRange(parallelism, b.parallelism) &&
    memoryKiB >= owaspArgon2idMinMemoryKiB(timeCost) &&
    memoryKiB >= 8 * parallelism
  );
}

const b = ARGON2ID_PARAM_BOUNDS;

const sharePasswordEnvSchema = z
  .object({
    /** argon2id memory of new share password hashes, in KiB. Default 19 MiB (OWASP). */
    SHARE_PASSWORD_ARGON2_MEMORY_KIB: int(b.memoryKiB.min, b.memoryKiB.max).default(19_456),
    /** argon2id passes. Default 2 (OWASP, with 19 MiB). */
    SHARE_PASSWORD_ARGON2_TIME_COST: int(b.timeCost.min, b.timeCost.max).default(2),
    /** argon2id lanes. Default 1 (OWASP). */
    SHARE_PASSWORD_ARGON2_PARALLELISM: int(b.parallelism.min, b.parallelism.max).default(1),
  })
  .refine(
    (e) =>
      argon2idParamsAcceptable({
        memoryKiB: e.SHARE_PASSWORD_ARGON2_MEMORY_KIB,
        timeCost: e.SHARE_PASSWORD_ARGON2_TIME_COST,
        parallelism: e.SHARE_PASSWORD_ARGON2_PARALLELISM,
      }),
    {
      error:
        'SHARE_PASSWORD_ARGON2_MEMORY_KIB is below the OWASP minimum for SHARE_PASSWORD_ARGON2_TIME_COST (t=1: 47104, t=2: 19456, t=3: 12288, t=4: 9216, t>=5: 7168 KiB) or below 8 KiB per lane',
    },
  );

export interface SharePasswordHashConfig {
  /** Parameters of new hashes. Existing hashes keep their own (PHC string). */
  argon2id: Argon2idParams;
}

/**
 * Reads SHARE_PASSWORD_ARGON2_MEMORY_KIB (19456), SHARE_PASSWORD_ARGON2_TIME_COST (2) and
 * SHARE_PASSWORD_ARGON2_PARALLELISM (1) (api only). OWASP's minimums are the lower bounds.
 */
export function loadSharePasswordHashConfig(env: Env): SharePasswordHashConfig {
  const e = parseEnv(sharePasswordEnvSchema, env, 'share password hashing');
  return {
    argon2id: {
      memoryKiB: e.SHARE_PASSWORD_ARGON2_MEMORY_KIB,
      timeCost: e.SHARE_PASSWORD_ARGON2_TIME_COST,
      parallelism: e.SHARE_PASSWORD_ARGON2_PARALLELISM,
    },
  };
}
