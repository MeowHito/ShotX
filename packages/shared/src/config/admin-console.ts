import { z } from 'zod';
import { loadTemporaryPasswordPolicy } from './auth';
import { type Env, parseEnv } from './env';
import { int } from './fields';

/** Most items one admin list page may ask for (`limit` of GET /admin/users and cash payments). */
export const ADMIN_LIST_PAGE_SIZE_LIMIT = 200;

const adminConsoleEnvSchema = z.object({
  /** Default page size of GET /admin/users and GET /admin/cash-payments (ADR 0010). */
  ADMIN_LIST_PAGE_SIZE: int(1, ADMIN_LIST_PAGE_SIZE_LIMIT).default(50),
  /**
   * How long GET /admin/system reuses its count of the media bucket (R2 ListObjectsV2 pages are
   * billed requests and take a while on a big bucket). ADR 0016.
   */
  ADMIN_STORAGE_SCAN_TTL_SECONDS: int(60, 86_400).default(600),
  /**
   * Where GET /admin/system reads the server's disk usage (statfs). In the api container `/` is
   * the host disk's overlay; point it at a bind mount to measure another disk.
   */
  ADMIN_SYSTEM_DISK_PATH: z.string().min(1).default('/'),
  /** ADR 0018: how long an admin's act-as session in a photographer's studio lasts (no renewal). */
  ADMIN_ACT_AS_SESSION_SECONDS: int(300, 14_400).default(3600),
  /** ADR 0018: how long an act-as link can be opened (once). */
  ADMIN_ACT_AS_CODE_SECONDS: int(15, 600).default(120),
});

export interface AdminConsoleConfig {
  listPageSize: number;
  /** ADMIN_STORAGE_SCAN_TTL_SECONDS. */
  storageScanTtlSeconds: number;
  /** ADMIN_SYSTEM_DISK_PATH. */
  systemDiskPath: string;
  /** ADMIN_ACT_AS_SESSION_SECONDS. */
  actAsSessionSeconds: number;
  /** ADMIN_ACT_AS_CODE_SECONDS. */
  actAsCodeSeconds: number;
}

/** Reads ADMIN_LIST_PAGE_SIZE (api; default 50). */
export function loadAdminConsoleConfig(env: Env): AdminConsoleConfig {
  const e = parseEnv(adminConsoleEnvSchema, env, 'admin console');
  return {
    listPageSize: e.ADMIN_LIST_PAGE_SIZE,
    storageScanTtlSeconds: e.ADMIN_STORAGE_SCAN_TTL_SECONDS,
    systemDiskPath: e.ADMIN_SYSTEM_DISK_PATH,
    actAsSessionSeconds: e.ADMIN_ACT_AS_SESSION_SECONDS,
    actAsCodeSeconds: e.ADMIN_ACT_AS_CODE_SECONDS,
  };
}

// --- Generated passwords (admin app; no secrets) --------------------------------------------------

/** Shortest password the admin app's "generate" button makes, whatever the configuration says. */
export const ADMIN_GENERATED_PASSWORD_MIN_LENGTH = 16;

/** Longest generated password (also the top of both pools' minimum-length ranges). */
export const ADMIN_GENERATED_PASSWORD_MAX_LENGTH = 128;

const adminPasswordUiEnvSchema = z.object({
  /**
   * Length of a password made by the admin app's "generate" button (create and reset). Must be at
   * least both pools' minimum length (requiredGeneratedPasswordLength), so the API never refuses
   * a generated password as too short.
   */
  ADMIN_GENERATED_PASSWORD_LENGTH: int(
    ADMIN_GENERATED_PASSWORD_MIN_LENGTH,
    ADMIN_GENERATED_PASSWORD_MAX_LENGTH,
  ).default(20),
});

export interface AdminPasswordUiConfig {
  /** ADMIN_GENERATED_PASSWORD_LENGTH. */
  generatedLength: number;
  /**
   * The shortest password an admin may set for each role: TEMPORARY_PASSWORD_MIN_LENGTH for both
   * (ADR 0015; the first sign-in replaces it under the pool's own policy).
   */
  minLength: { admin: number; photographer: number };
}

/**
 * The shortest generated length the policies allow: max(ADMIN_GENERATED_PASSWORD_MIN_LENGTH,
 * admin minimum, photographer minimum). Pure.
 */
export function requiredGeneratedPasswordLength(minLength: {
  admin: number;
  photographer: number;
}): number {
  return Math.max(ADMIN_GENERATED_PASSWORD_MIN_LENGTH, minLength.admin, minLength.photographer);
}

/**
 * Reads ADMIN_GENERATED_PASSWORD_LENGTH (16-128, default 20) and both pools' password minimums
 * (loadTemporaryPasswordPolicy, ADR 0015). Secret-free (admin app). Throws when
 * the generated length is below requiredGeneratedPasswordLength.
 */
export function loadAdminPasswordUiConfig(env: Env): AdminPasswordUiConfig {
  const e = parseEnv(adminPasswordUiEnvSchema, env, 'admin password UI');
  const temporary = loadTemporaryPasswordPolicy(env).minLength;
  const minLength = { admin: temporary, photographer: temporary };
  const required = requiredGeneratedPasswordLength(minLength);
  if (e.ADMIN_GENERATED_PASSWORD_LENGTH < required) {
    throw new Error(
      `Invalid admin password UI configuration: ADMIN_GENERATED_PASSWORD_LENGTH must be at least ${required} (ADMIN_PASSWORD_MIN_LENGTH / PHOTOGRAPHER_PASSWORD_MIN_LENGTH)`,
    );
  }
  return { generatedLength: e.ADMIN_GENERATED_PASSWORD_LENGTH, minLength };
}
