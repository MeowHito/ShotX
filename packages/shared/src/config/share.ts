import { z } from 'zod';
import { type Env, parseEnv } from './env';
import type { RateLimitRule } from './face';
import { GiB, int, MiB, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from './fields';

/** Upper bound of ZIP_MAX_FILES; queue message schemas use it as their hard ceiling. */
export const ZIP_MAX_FILES_LIMIT = 10_000;

/** Most items one share page may return; the `limit` query parameter is capped here. */
export const SHARE_PAGE_SIZE_LIMIT = 500;

/** Longest SIGNED_URL_EXPIRY_BUCKET_SECONDS. */
export const SIGNED_URL_EXPIRY_BUCKET_MAX_SECONDS = SECONDS_PER_HOUR;

/** Longest ZIP_RESULT_TTL_SECONDS: the bucket's tmp/ lifecycle rule expires objects after 1–3 days. */
export const ZIP_RESULT_TTL_MAX_SECONDS = 3 * SECONDS_PER_DAY;

const ttl = int(60, 7 * SECONDS_PER_DAY);
const requests = int(1, 1_000_000);
const windowSeconds = int(1, SECONDS_PER_DAY);

const shareEnvSchema = z
  .object({
    /** CloudFront signed URLs for thumbnails and previews (spec: ~1 h). */
    SIGNED_URL_VIEW_TTL_SECONDS: ttl.default(SECONDS_PER_HOUR),
    /** CloudFront signed URLs for downloads and finished zips (spec: ~10 min). */
    SIGNED_URL_DOWNLOAD_TTL_SECONDS: ttl.default(10 * SECONDS_PER_MINUTE),
    /**
     * Signed URL expiries are rounded up to a multiple of this (see bucketedExpiry), so every URL
     * for one object issued within the same window is byte-identical and browsers and CloudFront
     * get cache hits. A URL then lives between its TTL and TTL + this.
     */
    SIGNED_URL_EXPIRY_BUCKET_SECONDS: int(1, SIGNED_URL_EXPIRY_BUCKET_MAX_SECONDS).default(
      5 * SECONDS_PER_MINUTE,
    ),
    /** Items per page on the share page (spec: ~100). */
    SHARE_PAGE_SIZE: int(1, SHARE_PAGE_SIZE_LIMIT).default(100),
    /**
     * Lifetime of a viewer's face-search result in Redis (spec: 24 h). In face_only mode it is the
     * grant of matched files; in every mode it backs "ไม่ใช่ฉัน" feedback. Refreshed by each scan.
     */
    SHARE_FACE_ONLY_GRANT_TTL_SECONDS: ttl.default(SECONDS_PER_DAY),
    /** Lifetime of the share-scoped cookie set by unlocking a password share (assumption). */
    SHARE_UNLOCK_TTL_SECONDS: ttl.default(SECONDS_PER_DAY),
    /** Lifetime of the first-party anon_id cookie used to count people (spec: 1 year). */
    ANON_ID_MAX_AGE_DAYS: int(1, 400).default(365),
    /**
     * Lifetime of the API's viewer-session cookie that carries a signed-in viewer to the public
     * share routes (POST /me/viewer-session). Assumption: 12 h.
     */
    VIEWER_SESSION_TTL_SECONDS: int(5 * SECONDS_PER_MINUTE, 7 * SECONDS_PER_DAY).default(
      12 * SECONDS_PER_HOUR,
    ),
    /** Zip limits per job (values are assumptions; the spec puts them in config). */
    ZIP_MAX_FILES: int(1, ZIP_MAX_FILES_LIMIT).default(500),
    ZIP_MAX_BYTES: int(1 * MiB, 50 * GiB).default(2 * GiB),
    /**
     * How long a finished zip can be downloaded (`zip_jobs.expires_at - completed_at`). The
     * tmp/ lifecycle rule must keep objects at least this long. Assumption: 24 h.
     */
    ZIP_RESULT_TTL_SECONDS: int(10 * SECONDS_PER_MINUTE, ZIP_RESULT_TTL_MAX_SECONDS).default(
      SECONDS_PER_DAY,
    ),
    // Request limits of the public share routes (assumptions; load-test before launch). Face
    // search and face deletion share the FACE_SEARCH_RATE_* limits (see loadFaceConfig).
    /** Unlock attempts per IP and share: the password brute-force limit. */
    SHARE_UNLOCK_RATE_PER_IP: requests.default(10),
    SHARE_UNLOCK_RATE_PER_IP_WINDOW_SECONDS: windowSeconds.default(15 * SECONDS_PER_MINUTE),
    /** Single-file download URLs per share and viewer (or anonymous session). */
    SHARE_DOWNLOAD_RATE_PER_VIEWER: requests.default(300),
    SHARE_DOWNLOAD_RATE_PER_VIEWER_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
    /** Zip jobs per share and viewer (idempotent replays don't count). */
    ZIP_CREATE_RATE_PER_VIEWER: requests.default(10),
    ZIP_CREATE_RATE_PER_VIEWER_WINDOW_SECONDS: windowSeconds.default(SECONDS_PER_HOUR),
    /** "ไม่ใช่ฉัน" feedback per share and viewer. */
    SHARE_FEEDBACK_RATE_PER_VIEWER: requests.default(100),
    SHARE_FEEDBACK_RATE_PER_VIEWER_WINDOW_SECONDS: windowSeconds.default(10 * SECONDS_PER_MINUTE),
  })
  .refine((e) => e.SIGNED_URL_DOWNLOAD_TTL_SECONDS <= e.SIGNED_URL_VIEW_TTL_SECONDS, {
    error:
      'SIGNED_URL_DOWNLOAD_TTL_SECONDS must be less than or equal to SIGNED_URL_VIEW_TTL_SECONDS',
  })
  .refine((e) => e.SIGNED_URL_EXPIRY_BUCKET_SECONDS <= e.SIGNED_URL_DOWNLOAD_TTL_SECONDS, {
    error:
      'SIGNED_URL_EXPIRY_BUCKET_SECONDS must be less than or equal to SIGNED_URL_DOWNLOAD_TTL_SECONDS',
  });

export interface ShareConfig {
  signedUrlTtlSeconds: { view: number; download: number };
  /** Expiries are rounded up to a multiple of this (bucketedExpiry). */
  signedUrlExpiryBucketSeconds: number;
  pageSize: number;
  /** Lifetime of a face-search result (the face_only grant). */
  faceOnlyGrantTtlSeconds: number;
  unlockTtlSeconds: number;
  anonIdMaxAgeDays: number;
  viewerSessionTtlSeconds: number;
  zip: { maxFiles: number; maxBytes: number; resultTtlSeconds: number };
  /** Enforced by the API in Redis; a failed limiter write denies the request (ADR 0005). */
  rateLimits: {
    /** Keyed by IP and share. */
    unlockPerIp: RateLimitRule;
    /** Keyed by share and viewer (viewerKey). */
    downloadPerViewer: RateLimitRule;
    zipCreatePerViewer: RateLimitRule;
    feedbackPerViewer: RateLimitRule;
  };
}

export function loadShareConfig(env: Env): ShareConfig {
  const e = parseEnv(shareEnvSchema, env, 'share');
  return {
    signedUrlTtlSeconds: {
      view: e.SIGNED_URL_VIEW_TTL_SECONDS,
      download: e.SIGNED_URL_DOWNLOAD_TTL_SECONDS,
    },
    signedUrlExpiryBucketSeconds: e.SIGNED_URL_EXPIRY_BUCKET_SECONDS,
    pageSize: e.SHARE_PAGE_SIZE,
    faceOnlyGrantTtlSeconds: e.SHARE_FACE_ONLY_GRANT_TTL_SECONDS,
    unlockTtlSeconds: e.SHARE_UNLOCK_TTL_SECONDS,
    anonIdMaxAgeDays: e.ANON_ID_MAX_AGE_DAYS,
    viewerSessionTtlSeconds: e.VIEWER_SESSION_TTL_SECONDS,
    zip: {
      maxFiles: e.ZIP_MAX_FILES,
      maxBytes: e.ZIP_MAX_BYTES,
      resultTtlSeconds: e.ZIP_RESULT_TTL_SECONDS,
    },
    rateLimits: {
      unlockPerIp: {
        limit: e.SHARE_UNLOCK_RATE_PER_IP,
        windowSeconds: e.SHARE_UNLOCK_RATE_PER_IP_WINDOW_SECONDS,
      },
      downloadPerViewer: {
        limit: e.SHARE_DOWNLOAD_RATE_PER_VIEWER,
        windowSeconds: e.SHARE_DOWNLOAD_RATE_PER_VIEWER_WINDOW_SECONDS,
      },
      zipCreatePerViewer: {
        limit: e.ZIP_CREATE_RATE_PER_VIEWER,
        windowSeconds: e.ZIP_CREATE_RATE_PER_VIEWER_WINDOW_SECONDS,
      },
      feedbackPerViewer: {
        limit: e.SHARE_FEEDBACK_RATE_PER_VIEWER,
        windowSeconds: e.SHARE_FEEDBACK_RATE_PER_VIEWER_WINDOW_SECONDS,
      },
    },
  };
}
