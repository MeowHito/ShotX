import { z } from 'zod';
import { type Env, parseEnv } from './env';

const featureEnvSchema = z.object({
  /**
   * Face search, off by default. It stays off until a real-event Phase 0 evaluation passes.
   * `true`/`false` (also 1/0, yes/no, on/off). When false:
   * - api: consent, face search, face deletion and feedback answer FEATURE_DISABLED, enabling a
   *   folder's face index answers FEATURE_DISABLED (disabling still works), and the share meta and
   *   GET /me report the feature as unavailable;
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
