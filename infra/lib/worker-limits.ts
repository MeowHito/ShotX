import {
  loadShareConfig,
  loadWorkerSettings,
  type ShareConfig,
  type WorkerSettings,
} from '@shotx/shared';
import { ECS_MAX_STOP_TIMEOUT_SECONDS } from './constants';
import { backendEnv, type ServiceEnvGroups } from './face-limits';

/**
 * Limits infra derives from the worker and share configuration in packages/shared, parsed with
 * the same loaders api and worker use (`loadWorkerSettings`, `loadShareConfig`), so the queues,
 * the ECS stop timeout and the bucket lifecycle can't drift from what the services do.
 */

const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1000;

/** The WORKER_* settings the worker will load at runtime. Throws on invalid values. */
export function serviceWorkerSettings(env: ServiceEnvGroups): WorkerSettings {
  return loadWorkerSettings(backendEnv(env, 'worker'));
}

/** The share settings (signed URL TTLs, zip limits) a backend service will load at runtime. */
export function serviceShareConfig(env: ServiceEnvGroups, service: 'api' | 'worker'): ShareConfig {
  return loadShareConfig(backendEnv(env, service));
}

// --- ECS stop timeout --------------------------------------------------------------------------

/**
 * On SIGTERM the worker lets running messages finish for WORKER_SHUTDOWN_GRACE_SECONDS, then
 * resets their visibility to 0. ECS kills the container `stopTimeout` seconds after SIGTERM, so
 * the stop timeout is the grace plus a margin for the visibility resets and process exit.
 */
export function workerStopTimeoutSeconds(settings: WorkerSettings, marginSeconds: number): number {
  return settings.shutdownGraceMs / MS_PER_SECOND + marginSeconds;
}

export function workerStopTimeoutIssue(
  settings: WorkerSettings,
  marginSeconds: number,
): string | undefined {
  const stop = workerStopTimeoutSeconds(settings, marginSeconds);
  return stop > ECS_MAX_STOP_TIMEOUT_SECONDS
    ? `WORKER_SHUTDOWN_GRACE_SECONDS (${settings.shutdownGraceMs / MS_PER_SECOND}) + ` +
        `stopTimeoutMarginSeconds (${marginSeconds}) = ${stop}s exceeds the Fargate maximum ` +
        `stop timeout of ${ECS_MAX_STOP_TIMEOUT_SECONDS}s`
    : undefined;
}

// --- zip queue ---------------------------------------------------------------------------------

/** Inputs to the zip job worst case that the share config doesn't have (`queues.zip.jobBudget`). */
export interface ZipJobBudget {
  /** Slowest sustained S3 -> zip -> S3 streaming rate a healthy job is expected to reach. */
  readonly minThroughputBytesPerSecond: number;
  /** Fixed per-job work: DB reads and writes, starting and completing the multipart upload. */
  readonly processingSeconds: number;
}

/**
 * Longest a healthy zip job takes: ZIP_MAX_BYTES streamed at the minimum throughput, plus the
 * fixed per-job work. The worker's WORKER_ZIP_MAX_PROCESSING_SECONDS must stay above it.
 */
export function zipJobWorstCaseSeconds(share: ShareConfig, budget: ZipJobBudget): number {
  return Math.ceil(
    share.zip.maxBytes / budget.minThroughputBytesPerSecond + budget.processingSeconds,
  );
}

// --- tmp/zips/ lifecycle -----------------------------------------------------------------------

export interface ZipObjectLifetime {
  /** Longest a zip job writes before it completes (WORKER_ZIP_MAX_PROCESSING_SECONDS). */
  readonly maxProcessingSeconds: number;
  /** ZIP_RESULT_TTL_SECONDS: completed_at to zip_jobs.expires_at. */
  readonly resultTtlSeconds: number;
  /** SIGNED_URL_DOWNLOAD_TTL_SECONDS: a URL issued just before expires_at lives this long... */
  readonly downloadTtlSeconds: number;
  /** ...rounded up by SIGNED_URL_EXPIRY_BUCKET_SECONDS (bucketedExpiry). */
  readonly expiryBucketSeconds: number;
  /** Total: the oldest age (from S3's creation date) at which a zip may still be downloaded. */
  readonly seconds: number;
}

/**
 * How old a zip object can be while a download of it is still allowed. S3 lifecycle counts age
 * from the object's creation date, which for a multipart upload is when the upload was
 * initiated, i.e. when the job started writing, up to WORKER_ZIP_MAX_PROCESSING_SECONDS before
 * `completed_at`. From `completed_at` the API issues URLs for ZIP_RESULT_TTL_SECONDS, and the last
 * one stays valid for the download TTL rounded up by the expiry bucket.
 */
export function zipObjectLifetime(
  worker: WorkerSettings,
  shares: readonly ShareConfig[],
): ZipObjectLifetime {
  const max = (pick: (s: ShareConfig) => number) => Math.max(...shares.map(pick));
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

/** Smallest `storage.tmpZipsExpirationDays` that keeps every downloadable zip. */
export function minZipExpirationDays(lifetime: ZipObjectLifetime): number {
  return Math.ceil(lifetime.seconds / SECONDS_PER_DAY);
}

export function describeZipLifetime(l: ZipObjectLifetime): string {
  return (
    `WORKER_ZIP_MAX_PROCESSING_SECONDS ${l.maxProcessingSeconds}s (S3 dates a multipart object ` +
    `from its initiation) + ZIP_RESULT_TTL_SECONDS ${l.resultTtlSeconds}s + ` +
    `SIGNED_URL_DOWNLOAD_TTL_SECONDS ${l.downloadTtlSeconds}s + ` +
    `SIGNED_URL_EXPIRY_BUCKET_SECONDS ${l.expiryBucketSeconds}s = ${l.seconds}s`
  );
}
