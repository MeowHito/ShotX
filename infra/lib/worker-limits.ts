import {
  loadShareConfig,
  loadWorkerSettings,
  type ShareConfig,
  type WorkerSettings,
  type ZipObjectLifetime,
} from '@shotx/shared';
import { ECS_MAX_STOP_TIMEOUT_SECONDS } from './constants';
import { backendEnv, type ServiceEnvGroups } from './face-limits';

/**
 * Limits infra derives from the worker and share configuration in packages/shared, parsed with
 * the same loaders api and worker use (`loadWorkerSettings`, `loadShareConfig`), so the queues,
 * the ECS stop timeout and the bucket lifecycle can't drift from what the services do.
 */

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

// --- tmp/zips/ and tmp/reconcile/ lifecycle (ADR 0006) ----------------------------------------

// The ADR 0006 math lives in packages/shared (config/lifecycle.ts), shared with deploy/r2. S3
// lifecycle counts a multipart object's age from the upload's initiation, so a zip can be up to
// WORKER_ZIP_MAX_PROCESSING_SECONDS older than `completed_at`.
export {
  minReconcileExpirationDays,
  minZipExpirationDays,
  RECONCILE_RUN_INTERVAL_SECONDS,
  type ZipObjectLifetime,
  zipObjectLifetime,
} from '@shotx/shared';

export function describeZipLifetime(l: ZipObjectLifetime): string {
  return (
    `WORKER_ZIP_MAX_PROCESSING_SECONDS ${l.maxProcessingSeconds}s (S3 dates a multipart object ` +
    `from its initiation) + ZIP_RESULT_TTL_SECONDS ${l.resultTtlSeconds}s + ` +
    `SIGNED_URL_DOWNLOAD_TTL_SECONDS ${l.downloadTtlSeconds}s + ` +
    `SIGNED_URL_EXPIRY_BUCKET_SECONDS ${l.expiryBucketSeconds}s = ${l.seconds}s`
  );
}
