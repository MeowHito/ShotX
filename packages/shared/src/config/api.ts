import { z } from 'zod';
import { type Env, parseEnv } from './env';
import type { RateLimitRule } from './face';
import { int, KiB, MiB, SECONDS_PER_DAY } from './fields';

const apiLimitsEnvSchema = z
  .object({
    /** Largest JSON body of every route except `POST /uploads/:id/complete`. */
    API_JSON_BODY_MAX_BYTES: int(1 * KiB, 10 * MiB).default(64 * KiB),
    /** Largest JSON body of `POST /uploads/:id/complete`: up to 10,000 parts with their ETags. */
    UPLOAD_COMPLETE_BODY_MAX_BYTES: int(64 * KiB, 16 * MiB).default(1 * MiB),
    /**
     * `POST /uploads/init` per photographer and window. Folder drag-and-drop starts one init per
     * file, 4-6 at a time; replays with the same clientUploadId count too.
     */
    UPLOAD_INIT_RATE_PER_USER: int(1, 1_000_000).default(600),
    UPLOAD_INIT_RATE_WINDOW_SECONDS: int(1, SECONDS_PER_DAY).default(60),
  })
  .refine((e) => e.API_JSON_BODY_MAX_BYTES <= e.UPLOAD_COMPLETE_BODY_MAX_BYTES, {
    error: 'API_JSON_BODY_MAX_BYTES must be less than or equal to UPLOAD_COMPLETE_BODY_MAX_BYTES',
  });

/** Request limits of the API (api only). Face-search body limits are in loadFaceSearchUploadConfig. */
export interface ApiLimitsConfig {
  jsonBodyMaxBytes: number;
  completeBodyMaxBytes: number;
  uploadInitRate: RateLimitRule;
}

/**
 * Reads API_JSON_BODY_MAX_BYTES (64 KiB), UPLOAD_COMPLETE_BODY_MAX_BYTES (1 MiB),
 * UPLOAD_INIT_RATE_PER_USER (600) and UPLOAD_INIT_RATE_WINDOW_SECONDS (60).
 */
export function loadApiLimitsConfig(env: Env): ApiLimitsConfig {
  const e = parseEnv(apiLimitsEnvSchema, env, 'API limits');
  return {
    jsonBodyMaxBytes: e.API_JSON_BODY_MAX_BYTES,
    completeBodyMaxBytes: e.UPLOAD_COMPLETE_BODY_MAX_BYTES,
    uploadInitRate: {
      limit: e.UPLOAD_INIT_RATE_PER_USER,
      windowSeconds: e.UPLOAD_INIT_RATE_WINDOW_SECONDS,
    },
  };
}
