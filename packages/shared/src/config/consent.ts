import { z } from 'zod';
import { type Env, parseEnv } from './env';

/**
 * Every face-search consent text that exists, oldest first. The Thai text of each version lives in
 * the web app's i18n messages, keyed by this string (`satisfies Record<ConsentPolicyVersion, …>`,
 * so a new version fails web's typecheck until it has text); the API records the version in
 * `consents.policy_version`. A version's text never changes once it is here: changing the text
 * means adding a version. The DPO or legal team approves every version before launch.
 */
export const CONSENT_POLICY_VERSIONS = ['2026-10-25'] as const;
export type ConsentPolicyVersion = (typeof CONSENT_POLICY_VERSIONS)[number];

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
