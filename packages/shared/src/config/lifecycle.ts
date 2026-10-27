import { z } from 'zod';
import type { ShareConfig } from './share';
import { TMP_LIFECYCLE_MAX_DAYS } from './share';
import { type Env, parseEnv } from './env';
import { int, MS_PER_SECOND, SECONDS_PER_DAY } from './fields';
import { UPLOAD_SESSION_TTL_MAX_SECONDS } from './upload';
import type { WorkerSettings } from './worker';

// Media bucket lifecycle (ADR 0006, amended by ADR 0008 section 2). The values were only in
// infra/cdk.json `storage.*`; this is their shared home, so the VPS deploy script (deploy/r2)
// reads them here and no longer reads infra/cdk.json. The defaults equal cdk.json while infra/
// exists (config/lifecycle.test.ts). AWS-only settings stay in infra:
// originalsIntelligentTieringAfterDays and cloudFrontLogExpirationDays.

/** The defaults, equal to infra/cdk.json `context.shotx.storage`. */
export const STORAGE_LIFECYCLE_DEFAULTS = {
  abortIncompleteMultipartUploadDays: 2,
  tmpZipsExpirationDays: 2,
  tmpReconcileExpirationDays: 3,
  tmpOtherExpirationDays: 3,
  uploadCorsMaxAgeSeconds: 3000,
} as const;

/** Environment variables of each lifecycle setting (deploy script, VPS). */
export const STORAGE_LIFECYCLE_ENV = {
  abortIncompleteMultipartUploadDays: 'STORAGE_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS',
  tmpZipsExpirationDays: 'STORAGE_TMP_ZIPS_EXPIRATION_DAYS',
  tmpReconcileExpirationDays: 'STORAGE_TMP_RECONCILE_EXPIRATION_DAYS',
  tmpOtherExpirationDays: 'STORAGE_TMP_OTHER_EXPIRATION_DAYS',
  uploadCorsMaxAgeSeconds: 'STORAGE_UPLOAD_CORS_MAX_AGE_SECONDS',
} as const satisfies Record<keyof typeof STORAGE_LIFECYCLE_DEFAULTS, string>;

/**
 * Fewest days for the abort-incomplete-multipart rule: an upload session (at most
 * UPLOAD_SESSION_TTL_MAX_SECONDS, 36 h) must end before the rule could drop parts of a live
 * upload, so 2 days.
 */
export const ABORT_INCOMPLETE_MULTIPART_MIN_DAYS = Math.ceil(
  (UPLOAD_SESSION_TTL_MAX_SECONDS + 1) / SECONDS_PER_DAY,
);

const tmpDays = int(1, TMP_LIFECYCLE_MAX_DAYS);
const E = STORAGE_LIFECYCLE_ENV;
const D = STORAGE_LIFECYCLE_DEFAULTS;

const lifecycleEnvSchema = z
  .object({
    [E.abortIncompleteMultipartUploadDays]: int(ABORT_INCOMPLETE_MULTIPART_MIN_DAYS, 7).default(
      D.abortIncompleteMultipartUploadDays,
    ),
    [E.tmpZipsExpirationDays]: tmpDays.default(D.tmpZipsExpirationDays),
    [E.tmpReconcileExpirationDays]: tmpDays.default(D.tmpReconcileExpirationDays),
    [E.tmpOtherExpirationDays]: tmpDays.default(D.tmpOtherExpirationDays),
    /** Access-Control-Max-Age of the bucket's CORS rules. */
    [E.uploadCorsMaxAgeSeconds]: int(0, SECONDS_PER_DAY).default(D.uploadCorsMaxAgeSeconds),
  })
  .refine(
    (e) =>
      e[E.tmpOtherExpirationDays] >=
      Math.max(e[E.tmpZipsExpirationDays], e[E.tmpReconcileExpirationDays]),
    {
      error: `${E.tmpOtherExpirationDays} must be at least ${E.tmpZipsExpirationDays} and ${E.tmpReconcileExpirationDays}: the shortest matching expiration applies, so the tmp/ catch-all would cut the per-prefix rules short`,
    },
  );

/** Lifecycle and CORS settings of the media bucket (field names as infra/cdk.json `storage`). */
export interface StorageLifecycleConfig {
  abortIncompleteMultipartUploadDays: number;
  tmpZipsExpirationDays: number;
  tmpReconcileExpirationDays: number;
  tmpOtherExpirationDays: number;
  uploadCorsMaxAgeSeconds: number;
}

/**
 * Reads STORAGE_ABORT_INCOMPLETE_MULTIPART_UPLOAD_DAYS (2–7), STORAGE_TMP_ZIPS_EXPIRATION_DAYS,
 * STORAGE_TMP_RECONCILE_EXPIRATION_DAYS, STORAGE_TMP_OTHER_EXPIRATION_DAYS (1–3, the catch-all at
 * least the others) and STORAGE_UPLOAD_CORS_MAX_AGE_SECONDS, all defaulting to
 * STORAGE_LIFECYCLE_DEFAULTS. For the deploy script; the runtime checks against the share,
 * worker and face settings are zipObjectLifetime, minZipExpirationDays and
 * minReconcileExpirationDays.
 */
export function loadStorageLifecycleConfig(env: Env): StorageLifecycleConfig {
  const e = parseEnv(lifecycleEnvSchema, env, 'storage lifecycle') as Record<string, number>;
  return {
    abortIncompleteMultipartUploadDays: e[E.abortIncompleteMultipartUploadDays] as number,
    tmpZipsExpirationDays: e[E.tmpZipsExpirationDays] as number,
    tmpReconcileExpirationDays: e[E.tmpReconcileExpirationDays] as number,
    tmpOtherExpirationDays: e[E.tmpOtherExpirationDays] as number,
    uploadCorsMaxAgeSeconds: e[E.uploadCorsMaxAgeSeconds] as number,
  };
}

// --- ADR 0006 checks (moved from deploy/r2/rules.ts; infra/lib has its own copy) ---------------

/**
 * The orphan-face reconciliation job runs once a day (`faces.reconcile.daily`); a scan written by
 * one run is acted on by a later one once FACE_ORPHAN_GRACE_MS has passed.
 */
export const RECONCILE_RUN_INTERVAL_SECONDS = SECONDS_PER_DAY;

/** How long a finished zip may still be downloaded, measured from its upload's initiation. */
export interface ZipObjectLifetime {
  maxProcessingSeconds: number;
  resultTtlSeconds: number;
  downloadTtlSeconds: number;
  expiryBucketSeconds: number;
  seconds: number;
}

/**
 * WORKER_ZIP_MAX_PROCESSING_SECONDS (a multipart object is dated from its initiation) +
 * ZIP_RESULT_TTL_SECONDS + SIGNED_URL_DOWNLOAD_TTL_SECONDS + SIGNED_URL_EXPIRY_BUCKET_SECONDS,
 * each the largest of the given share configs (api and worker, when their env differs).
 */
export function zipObjectLifetime(
  worker: Pick<WorkerSettings, 'maxProcessingMs'>,
  shares: readonly Pick<
    ShareConfig,
    'zip' | 'signedUrlTtlSeconds' | 'signedUrlExpiryBucketSeconds'
  >[],
): ZipObjectLifetime {
  if (shares.length === 0) throw new RangeError('at least one share config is needed');
  const max = (pick: (s: (typeof shares)[number]) => number) => Math.max(...shares.map(pick));
  const maxProcessingSeconds = worker.maxProcessingMs.zip / MS_PER_SECOND;
  const resultTtlSeconds = max((s) => s.zip.resultTtlSeconds);
  const downloadTtlSeconds = max((s) => s.signedUrlTtlSeconds.download);
  const expiryBucketSeconds = max((s) => s.signedUrlExpiryBucketSeconds);
  return {
    maxProcessingSeconds,
    resultTtlSeconds,
    downloadTtlSeconds,
    expiryBucketSeconds,
    seconds: maxProcessingSeconds + resultTtlSeconds + downloadTtlSeconds + expiryBucketSeconds,
  };
}

/** Smallest tmpZipsExpirationDays that keeps every downloadable zip. */
export function minZipExpirationDays(lifetime: ZipObjectLifetime): number {
  return Math.ceil(lifetime.seconds / SECONDS_PER_DAY);
}

/** Smallest tmpReconcileExpirationDays: one orphan grace plus one daily run. */
export function minReconcileExpirationDays(orphanGraceMs: number): number {
  return Math.ceil(
    (orphanGraceMs / MS_PER_SECOND + RECONCILE_RUN_INTERVAL_SECONDS) / SECONDS_PER_DAY,
  );
}
