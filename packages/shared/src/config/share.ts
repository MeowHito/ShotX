import { z } from 'zod';
import { type Env, parseEnv } from './env';
import type { RateLimitRule } from './face';
import { GiB, int, MiB, SECONDS_PER_DAY, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from './fields';
import { WORKER_MAX_PROCESSING_SECONDS_LIMIT } from './worker';

/** Upper bound of ZIP_MAX_FILES; queue message schemas use it as their hard ceiling. */
export const ZIP_MAX_FILES_LIMIT = 10_000;

/** Most items one share page may return; the `limit` query parameter is capped here. */
export const SHARE_PAGE_SIZE_LIMIT = 500;

/** Longest SIGNED_URL_EXPIRY_BUCKET_SECONDS. */
export const SIGNED_URL_EXPIRY_BUCKET_MAX_SECONDS = SECONDS_PER_HOUR;

/**
 * Ceiling of every tmp/ lifecycle rule in the media bucket, in days (spec: 1–3 days; ADR 0006 as
 * amended in the Phase 3 review). infra keeps `storage.tmp*ExpirationDays` at or below it.
 */
export const TMP_LIFECYCLE_MAX_DAYS = 3;

/**
 * Longest ZIP_RESULT_TTL_SECONDS: 2 days. A zip object must outlive, counted from when the worker
 * starts writing it (S3 dates a multipart object from its initiation), the processing time
 * (WORKER_ZIP_MAX_PROCESSING_SECONDS, at most WORKER_MAX_PROCESSING_SECONDS_LIMIT = 11 h) +
 * ZIP_RESULT_TTL_SECONDS + SIGNED_URL_DOWNLOAD_TTL_SECONDS + SIGNED_URL_EXPIRY_BUCKET_SECONDS,
 * which infra's synth checks against the tmp/zips/ rule (minZipExpirationDays). With the 3-day
 * ceiling, 2 days leaves 1 day for the rest: 11 h of processing plus up to 13 h of download TTL
 * and bucket, which loadShareConfig enforces (see ZIP_OBJECT_MAX_AGE_SECONDS). At the defaults
 * (24 h TTL, 2 h processing, 10 min URL, 5 min bucket) a zip needs 94,500 s, inside a 2-day rule.
 */
export const ZIP_RESULT_TTL_MAX_SECONDS = 2 * SECONDS_PER_DAY;

/**
 * The oldest a zip object may get while it can still be downloaded, at the worst allowed worker
 * setting: TMP_LIFECYCLE_MAX_DAYS. loadShareConfig rejects a ZIP_RESULT_TTL_SECONDS +
 * SIGNED_URL_DOWNLOAD_TTL_SECONDS + SIGNED_URL_EXPIRY_BUCKET_SECONDS that would not fit in it
 * together with WORKER_MAX_PROCESSING_SECONDS_LIMIT, so no allowed configuration needs a tmp/zips/
 * rule longer than the ceiling.
 */
export const ZIP_OBJECT_MAX_AGE_SECONDS = TMP_LIFECYCLE_MAX_DAYS * SECONDS_PER_DAY;

const ttl = int(60, 7 * SECONDS_PER_DAY);
const requests = int(1, 1_000_000);
const windowSeconds = int(1, SECONDS_PER_DAY);

const shareEnvSchema = z
  .object({
    /** Signed media URLs for thumbnails and previews (spec: ~1 h). */
    SIGNED_URL_VIEW_TTL_SECONDS: ttl.default(SECONDS_PER_HOUR),
    /** Signed media URLs for downloads and finished zips (spec: ~10 min). */
    SIGNED_URL_DOWNLOAD_TTL_SECONDS: ttl.default(10 * SECONDS_PER_MINUTE),
    /**
     * Signed URL expiries are rounded up to a multiple of this (see bucketedExpiry), so every URL
     * for one object issued within the same window is byte-identical and browsers and CloudFront
     * get cache hits. A URL then lives between its TTL and TTL + this.
     *
     * MEDIA_URL_SIGNER=s3-presign (R2, ADR 0008 section 2) also rounds the SigV4 signing date
     * (X-Amz-Date) down to a multiple of this, since the date is part of the URL; X-Amz-Expires
     * is then bucketed expiry - signing date (at most TTL + 2 x this), capped at
     * S3_PRESIGN_MAX_EXPIRES_SECONDS (7 days). Media URLs are never unsigned or non-expiring.
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
     * tmp/zips/ lifecycle rule must keep objects at least this long plus the margins (see
     * ZIP_RESULT_TTL_MAX_SECONDS). Assumption: 24 h; at most 2 days.
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
  })
  .refine(
    (e) =>
      WORKER_MAX_PROCESSING_SECONDS_LIMIT +
        e.ZIP_RESULT_TTL_SECONDS +
        e.SIGNED_URL_DOWNLOAD_TTL_SECONDS +
        e.SIGNED_URL_EXPIRY_BUCKET_SECONDS <=
      ZIP_OBJECT_MAX_AGE_SECONDS,
    {
      error: `ZIP_RESULT_TTL_SECONDS + SIGNED_URL_DOWNLOAD_TTL_SECONDS + SIGNED_URL_EXPIRY_BUCKET_SECONDS must leave ${WORKER_MAX_PROCESSING_SECONDS_LIMIT} s of zip processing within the ${TMP_LIFECYCLE_MAX_DAYS}-day tmp/ lifecycle ceiling`,
    },
  );

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
