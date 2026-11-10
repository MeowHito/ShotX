import { z } from 'zod';
import { loadAdminPasswordPolicy, loadPhotographerPasswordPolicy } from './auth';
import { type Env, parseEnv } from './env';
import { int } from './fields';

/** Most items one admin list page may ask for (`limit` of GET /admin/users and cash payments). */
export const ADMIN_LIST_PAGE_SIZE_LIMIT = 200;

const adminConsoleEnvSchema = z.object({
  /** Default page size of GET /admin/users and GET /admin/cash-payments (ADR 0010). */
  ADMIN_LIST_PAGE_SIZE: int(1, ADMIN_LIST_PAGE_SIZE_LIMIT).default(50),
});

export interface AdminConsoleConfig {
  listPageSize: number;
}

/** Reads ADMIN_LIST_PAGE_SIZE (api; default 50). */
export function loadAdminConsoleConfig(env: Env): AdminConsoleConfig {
  return {
    listPageSize: parseEnv(adminConsoleEnvSchema, env, 'admin console').ADMIN_LIST_PAGE_SIZE,
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
  /** ADMIN_PASSWORD_MIN_LENGTH and PHOTOGRAPHER_PASSWORD_MIN_LENGTH (the API's loaders). */
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
 * (loadAdminPasswordPolicy, loadPhotographerPasswordPolicy). Secret-free (admin app). Throws when
 * the generated length is below requiredGeneratedPasswordLength.
 */
export function loadAdminPasswordUiConfig(env: Env): AdminPasswordUiConfig {
  const e = parseEnv(adminPasswordUiEnvSchema, env, 'admin password UI');
  const minLength = {
    admin: loadAdminPasswordPolicy(env).minLength,
    photographer: loadPhotographerPasswordPolicy(env).minLength,
  };
  const required = requiredGeneratedPasswordLength(minLength);
  if (e.ADMIN_GENERATED_PASSWORD_LENGTH < required) {
    throw new Error(
      `Invalid admin password UI configuration: ADMIN_GENERATED_PASSWORD_LENGTH must be at least ${required} (ADMIN_PASSWORD_MIN_LENGTH / PHOTOGRAPHER_PASSWORD_MIN_LENGTH)`,
    );
  }
  return { generatedLength: e.ADMIN_GENERATED_PASSWORD_LENGTH, minLength };
}
