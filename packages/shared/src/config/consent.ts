import { z } from 'zod';
import { type Env, parseEnv } from './env';

/**
 * Every consent policy version that exists, oldest first. A version has one Thai text per
 * consent purpose (CONSENT_PURPOSES: `face_search`, `face_deletion`). The texts live in the web
 * app's i18n messages, keyed by purpose and version
 * (`satisfies Record<ConsentPurpose, Record<ConsentPolicyVersion, …>>`, so a new version or
 * purpose fails web's typecheck until it has text); the API records the version and purpose in
 * `consents`. A version's texts never change once it is here: changing a text means adding a
 * version, which makes earlier consents of both purposes stale. The DPO or legal team approves
 * every version before launch.
 */
export const CONSENT_POLICY_VERSIONS = ['2026-10-25'] as const;
export type ConsentPolicyVersion = (typeof CONSENT_POLICY_VERSIONS)[number];

/**
 * A well-formed policy version string as a client may send it: 1–32 characters from
 * `[0-9A-Za-z._-]`, starting with a letter or digit. Request bodies use this instead of the enum
 * of known versions, so an outdated or unknown version reaches the service, which answers 409
 * CONSENT_VERSION_MISMATCH with the current version (instead of a 400 that tells the page
 * nothing).
 */
export const consentPolicyVersionSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$/, { error: 'must be a policy version string' });

/** The newest known version, the default of CONSENT_POLICY_VERSION. */
export const LATEST_CONSENT_POLICY_VERSION: ConsentPolicyVersion = CONSENT_POLICY_VERSIONS[
  CONSENT_POLICY_VERSIONS.length - 1
] as ConsentPolicyVersion;

const consentEnvSchema = z.object({
  /**
   * The version viewers must accept before a scan. Raising it makes every earlier consent stale:
   * viewers see the new text and accept again.
   */
  CONSENT_POLICY_VERSION: z.enum(CONSENT_POLICY_VERSIONS).default(LATEST_CONSENT_POLICY_VERSION),
  /**
   * Key of `consents.ip_hash` (see ipHashFormat). At least 32 characters; a secret, never logged.
   * Rotating it only means new rows can't be linked to old ones.
   */
  IP_HASH_SECRET: z.string({ error: 'must be a string' }).min(32, {
    error: 'must be at least 32 characters',
  }),
});

export interface ConsentConfig {
  policyVersion: ConsentPolicyVersion;
  /** Secret: never log it. */
  ipHashSecret: string;
}

/** Reads CONSENT_POLICY_VERSION (default: the latest) and IP_HASH_SECRET (required; api only). */
export function loadConsentConfig(env: Env): ConsentConfig {
  const e = parseEnv(consentEnvSchema, env, 'consent');
  return { policyVersion: e.CONSENT_POLICY_VERSION, ipHashSecret: e.IP_HASH_SECRET };
}
