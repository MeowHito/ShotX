import { z } from 'zod';
import { type Env, parseEnv } from './env';
import { GiB, int, MiB, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from './fields';

/** Upper bound of ZIP_MAX_FILES; queue message schemas use it as their hard ceiling. */
export const ZIP_MAX_FILES_LIMIT = 10_000;

const ttl = int(60, 7 * SECONDS_PER_DAY);

const shareEnvSchema = z
  .object({
    /** CloudFront signed URLs for thumbnails and previews (spec: ~1 h). */
    SIGNED_URL_VIEW_TTL_SECONDS: ttl.default(SECONDS_PER_HOUR),
    /** CloudFront signed URLs for downloads and finished zips (spec: ~10 min). */
    SIGNED_URL_DOWNLOAD_TTL_SECONDS: ttl.default(10 * SECONDS_PER_MINUTE),
    /** Items per page on the share page (spec: ~100). */
    SHARE_PAGE_SIZE: int(1, 500).default(100),
    /** face_only mode: lifetime of the server-side grant of matched files (spec: 24 h). */
    SHARE_FACE_ONLY_GRANT_TTL_SECONDS: ttl.default(SECONDS_PER_DAY),
    /** Lifetime of the share-scoped cookie set by unlocking a password share (assumption). */
    SHARE_UNLOCK_TTL_SECONDS: ttl.default(SECONDS_PER_DAY),
    /** Lifetime of the first-party anon_id cookie used to count people (spec: 1 year). */
    ANON_ID_MAX_AGE_DAYS: int(1, 400).default(365),
    /** Zip limits per job (values are assumptions; the spec puts them in config). */
    ZIP_MAX_FILES: int(1, ZIP_MAX_FILES_LIMIT).default(500),
    ZIP_MAX_BYTES: int(1 * MiB, 50 * GiB).default(2 * GiB),
  })
  .refine((e) => e.SIGNED_URL_DOWNLOAD_TTL_SECONDS <= e.SIGNED_URL_VIEW_TTL_SECONDS, {
    error:
      'SIGNED_URL_DOWNLOAD_TTL_SECONDS must be less than or equal to SIGNED_URL_VIEW_TTL_SECONDS',
  });

export interface ShareConfig {
  signedUrlTtlSeconds: { view: number; download: number };
  pageSize: number;
  faceOnlyGrantTtlSeconds: number;
  unlockTtlSeconds: number;
  anonIdMaxAgeDays: number;
  zip: { maxFiles: number; maxBytes: number };
}

export function loadShareConfig(env: Env): ShareConfig {
  const e = parseEnv(shareEnvSchema, env, 'share');
  return {
    signedUrlTtlSeconds: {
      view: e.SIGNED_URL_VIEW_TTL_SECONDS,
      download: e.SIGNED_URL_DOWNLOAD_TTL_SECONDS,
    },
    pageSize: e.SHARE_PAGE_SIZE,
    faceOnlyGrantTtlSeconds: e.SHARE_FACE_ONLY_GRANT_TTL_SECONDS,
    unlockTtlSeconds: e.SHARE_UNLOCK_TTL_SECONDS,
    anonIdMaxAgeDays: e.ANON_ID_MAX_AGE_DAYS,
    zip: { maxFiles: e.ZIP_MAX_FILES, maxBytes: e.ZIP_MAX_BYTES },
  };
}
