import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { FACE_PROVIDERS, type FaceProviderName } from './face-provider';
import { LOCAL_DEV_APP_STAGE } from './stage-gate';

/**
 * Every consent policy version that exists, oldest first. Only the newest version per face processor
 * collects new consents (outside APP_STAGE=local, see loadConsentConfig); older ones are retired but
 * stay here with their texts, because existing `consents` rows reference them. A version has one Thai text per
 * consent purpose (CONSENT_PURPOSES: `face_search`, `face_deletion`). The texts live in the web
 * app's i18n messages, keyed by purpose and version
 * (`satisfies Record<ConsentPurpose, Record<ConsentPolicyVersion, …>>`, so a new version or
 * purpose fails web's typecheck until it has text); the API records the version and purpose in
 * `consents`. A version's texts never change once it is here: changing a text means adding a
 * version, which makes earlier consents of both purposes stale. The DPO or legal team approves
 * every version before launch.
 */
export const CONSENT_POLICY_VERSIONS = [
  '2026-10-25',
  '2026-10-29',
  '2026-11-11',
  '2026-11-11b',
  '2026-11-12',
] as const;
export type ConsentPolicyVersion = (typeof CONSENT_POLICY_VERSIONS)[number];

/**
 * The face processor each version's texts name: 2026-10-25 names Amazon Web Services
 * (Rekognition), 2026-10-29 our own servers in Singapore (ADR 0009; no longer true, kept because
 * existing `consents` rows reference it), 2026-11-11 our own servers in Kuala Lumpur, Malaysia
 * (Hostinger VPS, ADR 0008 open question 2), 2026-11-11b the same processor with the simpler text
 * the owner approved (retired: it points to the "ขอลบใบหน้าของฉัน" page that ADR 0011 decision 2
 * unlinked), 2026-11-12 the same processor with deletion requested by contacting the photographer
 * or organiser. The API refuses a CONSENT_POLICY_VERSION that names
 * another processor than FACE_PROVIDER, so viewers never consent to the wrong one.
 */
export const CONSENT_POLICY_FACE_PROVIDER = {
  '2026-10-25': 'rekognition',
  '2026-10-29': 'self-hosted',
  '2026-11-11': 'self-hosted',
  '2026-11-11b': 'self-hosted',
  '2026-11-12': 'self-hosted',
} as const satisfies Record<ConsentPolicyVersion, FaceProviderName>;

/** The newest version whose texts name `provider`. */
export function latestConsentPolicyVersion(provider: FaceProviderName): ConsentPolicyVersion {
  const version = CONSENT_POLICY_VERSIONS.findLast(
    (v) => CONSENT_POLICY_FACE_PROVIDER[v] === provider,
  );
  if (version === undefined) throw new Error(`No consent policy version names ${provider}`);
  return version;
}

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

/** The newest known version. CONSENT_POLICY_VERSION defaults to latestConsentPolicyVersion. */
export const LATEST_CONSENT_POLICY_VERSION: ConsentPolicyVersion = CONSENT_POLICY_VERSIONS[
  CONSENT_POLICY_VERSIONS.length - 1
] as ConsentPolicyVersion;

const consentEnvSchema = z.object({
  APP_STAGE: z.string().optional(),
  FACE_PROVIDER: z.enum(FACE_PROVIDERS).default('self-hosted'),
  /**
   * The version viewers must accept before a scan. Raising it makes every earlier consent stale:
   * viewers see the new text and accept again. Default: the newest version for FACE_PROVIDER.
   * Outside APP_STAGE=local only that newest version is accepted (no new consents under a retired
   * text); local may pin an older one for tests.
   */
  CONSENT_POLICY_VERSION: z.enum(CONSENT_POLICY_VERSIONS).optional(),
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

/**
 * Reads CONSENT_POLICY_VERSION (default: the newest version naming FACE_PROVIDER's processor;
 * one naming another processor is refused, and outside APP_STAGE=local so is a retired one, i.e.
 * any version but that newest) and IP_HASH_SECRET (required; api only).
 */
export function loadConsentConfig(env: Env): ConsentConfig {
  const e = parseEnv(consentEnvSchema, env, 'consent');
  const policyVersion = e.CONSENT_POLICY_VERSION ?? latestConsentPolicyVersion(e.FACE_PROVIDER);
  if (CONSENT_POLICY_FACE_PROVIDER[policyVersion] !== e.FACE_PROVIDER) {
    throw new Error(
      `Invalid consent configuration: CONSENT_POLICY_VERSION ${policyVersion} names the ${CONSENT_POLICY_FACE_PROVIDER[policyVersion]} face processor, but FACE_PROVIDER is ${e.FACE_PROVIDER}`,
    );
  }
  const latest = latestConsentPolicyVersion(e.FACE_PROVIDER);
  if (policyVersion !== latest && e.APP_STAGE !== LOCAL_DEV_APP_STAGE) {
    throw new Error(
      `Invalid consent configuration: CONSENT_POLICY_VERSION ${policyVersion} is retired; the current version for FACE_PROVIDER ${e.FACE_PROVIDER} is ${latest} (older versions may be pinned only with APP_STAGE=${LOCAL_DEV_APP_STAGE})`,
    );
  }
  return { policyVersion, ipHashSecret: e.IP_HASH_SECRET };
}
