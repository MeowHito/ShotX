import { z } from 'zod';
import { type Env, parseEnv } from './env';

const featureEnvSchema = z.object({
  /**
   * Face search, off by default. It stays off until a real-event Phase 0 evaluation passes.
   * `true`/`false` (also 1/0, yes/no, on/off). When false:
   * - api: `face_search` consent, face search and feedback answer FEATURE_DISABLED, enabling a
   *   folder's face index and face_only shares answer FEATURE_DISABLED (disabling still works),
   *   and the share meta and GET /me report the feature as unavailable. Face deletion ("ขอลบใบหน้า
   *   ของฉัน", its `face_deletion` consent and GET /s/:token/face-deletion) and consent withdrawal
   *   keep working: they are PDPA rights (CONSENT_PURPOSE_GATES);
   * - worker: `index.file` and `index.folder` jobs are acknowledged without indexing; expiry,
   *   unindexing, deletion and reconciliation keep running so existing faces still go away;
   * - web: hides scanning (it reads availability from the API, never from this variable).
   */
  FACE_SEARCH_ENABLED: z.stringbool().default(false),
});

export interface FeatureFlags {
  faceSearch: boolean;
}

/** Reads FACE_SEARCH_ENABLED (api and worker; default false). */
export function loadFeatureFlags(env: Env): FeatureFlags {
  return { faceSearch: parseEnv(featureEnvSchema, env, 'feature flag').FACE_SEARCH_ENABLED };
}
