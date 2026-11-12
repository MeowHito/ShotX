import { type DatabaseConfig, loadDatabaseConfig } from '@shotx/db';
import {
  type AppConfig,
  type AwsClientConfig,
  type AwsConfig,
  type BillingConfig,
  type BillingOperatingMode,
  type BullMqQueueSettings,
  type DesignAssetConfig,
  type EmailConfig,
  type Env,
  type FaceConfig,
  type FeatureFlags,
  loadAppConfig,
  loadAwsConfig,
  loadBillingConfig,
  loadBillingModeConfig,
  loadDesignConfig,
  loadEmailConfig,
  loadFaceConfig,
  loadFeatureFlags,
  loadMediaConfig,
  loadMediaStorageConfig,
  loadPaymentGatewayConfig,
  loadQueueBackendConfig,
  loadQueueVisibilityTimeouts,
  loadRedisConfig,
  loadFaceRekognitionClientConfig,
  loadRetentionConfig,
  loadScheduledJobsConfig,
  loadSesClientConfig,
  loadShareConfig,
  loadUploadConfig,
  loadWorkerSettings,
  LOCAL_DEV_APP_STAGE,
  type MediaConfig,
  type MediaStorageConfig,
  type PaymentGatewayConfig,
  QUEUE_NAMES,
  type QueueName,
  type RedisConfig,
  type RetentionConfig,
  runsOffAws,
  type ScheduledJobsConfig,
  type ShareConfig,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
  type WorkerSettings,
} from '@shotx/shared';
import { schedulesForBillingMode } from './billing/mode';

/** Queues the worker consumes: every queue (media, faces, zip, jobs). */
export const CONSUMED_QUEUES = QUEUE_NAMES;
export type ConsumedQueue = QueueName;

/** The zip limits and result lifetime (ZIP_MAX_FILES, ZIP_MAX_BYTES, ZIP_RESULT_TTL_SECONDS). */
export type ZipConfig = ShareConfig['zip'];

/**
 * Where the queues live (QUEUE_BACKEND), with what each runtime needs:
 * - `sqs` (until infra/ is removed): queue URLs and visibility timeouts (heartbeats);
 * - `bullmq` (ADR 0008): the key prefix, per-queue settings and the job schedules.
 */
export type WorkerQueueConfig =
  | {
      backend: 'sqs';
      urls: Record<QueueName, string>;
      visibilityTimeoutSeconds: Record<QueueName, number>;
    }
  | {
      backend: 'bullmq';
      prefix: string;
      queues: Record<QueueName, BullMqQueueSettings>;
      schedules: ScheduledJobsConfig;
    };

export interface WorkerConfig {
  app: AppConfig;
  /** AWS_REGION and AWS_ENDPOINT_URL (LocalStack): the SQS client on the AWS stacks only. */
  aws: AwsConfig;
  /**
   * Rekognition's region, endpoint and keys (ADR 0008 section 1) with FACE_PROVIDER=rekognition:
   * explicit, never AWS_ENDPOINT_URL or the default chain off AWS; else null (ADR 0009). Secret:
   * never log it.
   */
  rekognitionClient: AwsClientConfig | null;
  /** The SES client with EMAIL_PROVIDER=ses, else null. Secret: never log it. */
  sesClient: AwsClientConfig | null;
  /**
   * runsOffAws: the VPS of ADR 0008 (or local development like it). No task role there, so no
   * client may fall back to the default credential chain (assertOffAwsQueue, assertOffAwsStorage).
   */
  offAws: boolean;
  storage: MediaStorageConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  queue: WorkerQueueConfig;
  media: MediaConfig;
  /**
   * DESIGN_ASSET_* (ADR 0013): the design.asset job's web.webp, the orphan purge in
   * trash.purge.daily (DESIGN_ASSET_ORPHAN_DAYS).
   */
  design: DesignAssetConfig;
  retention: RetentionConfig;
  face: FaceConfig;
  features: FeatureFlags;
  zip: ZipConfig;
  /** UPLOAD_PART_BYTES: the preferred part size of the zip consumer's multipart uploads. */
  multipartPartBytes: number;
  /** WORKER_* settings and LOG_LEVEL (loadWorkerSettings in @shotx/shared). */
  worker: WorkerSettings;
  /**
   * BILLING_MODE (ADR 0010, default `offline`): with `offline` the billing jobs
   * (BILLING_JOB_TYPES: subscription transitions, renewal charges, billing emails) are neither
   * scheduled nor run; every other job and consumer runs in both modes.
   */
  billingMode: BillingOperatingMode;
  /** Billing tunables (auto-renew attempts and lead, VAT) for subscriptions.transition.daily. */
  billing: BillingConfig;
  /** EMAIL_PROVIDER and the sender (lifecycle emails and receipts; used in gateway mode only). */
  email: EmailConfig;
  /**
   * PAYMENT_GATEWAY and its secrets, for auto-renew charges; null with BILLING_MODE=offline, when
   * no PAYMENT_* setting is read or required. Secret: never log this object.
   */
  paymentGateway: PaymentGatewayConfig | null;
}

/** Everything the worker reads from the environment, validated at start-up. */
export function loadWorkerConfig(env: Env): WorkerConfig {
  return {
    app: loadAppConfig(env),
    aws: loadAwsConfig(env),
    rekognitionClient: loadFaceRekognitionClientConfig(env),
    sesClient: loadSesClientConfig(env),
    offAws: runsOffAws(env),
    storage: loadMediaStorageConfig(env),
    database: loadDatabaseConfig(env),
    redis: loadRedisConfig(env),
    queue: loadWorkerQueueConfig(env),
    media: loadMediaConfig(env),
    design: loadDesignConfig(env).asset,
    retention: loadRetentionConfig(env),
    face: loadFaceConfig(env),
    features: loadFeatureFlags(env),
    zip: loadShareConfig(env).zip,
    multipartPartBytes: loadUploadConfig(env).partBytes,
    worker: loadWorkerSettings(env),
    billingMode: loadBillingModeConfig(env).mode,
    billing: loadBillingConfig(env),
    email: loadEmailConfig(env),
    paymentGateway: loadPaymentGatewayConfig(env),
  };
}

/**
 * QUEUE_BACKEND and its settings for the consumed queues. The BullMQ schedules are the ones the
 * worker registers: with BILLING_MODE=offline the billing jobs are disabled
 * (schedulesForBillingMode).
 */
export function loadWorkerQueueConfig(env: Env): WorkerQueueConfig {
  const backend = loadQueueBackendConfig(env, CONSUMED_QUEUES);
  if (backend.backend === 'bullmq') {
    const schedules = schedulesForBillingMode(
      loadScheduledJobsConfig(env),
      loadBillingModeConfig(env).mode,
    );
    return { ...backend, schedules };
  }
  const visibilityTimeoutSeconds = loadQueueVisibilityTimeouts(env, CONSUMED_QUEUES);
  for (const queue of CONSUMED_QUEUES) {
    const seconds = visibilityTimeoutSeconds[queue];
    if (seconds < 3 || seconds > SQS_MAX_VISIBILITY_TIMEOUT_SECONDS) {
      throw new Error(
        `Invalid queue configuration: the ${queue} visibility timeout must be at least 3 s for heartbeats`,
      );
    }
  }
  return { backend: 'sqs', urls: backend.urls, visibilityTimeoutSeconds };
}

type OffAwsChecked = Pick<WorkerConfig, 'offAws' | 'app'>;

/**
 * Refuses QUEUE_BACKEND=sqs off AWS outside APP_STAGE=local (as the api does): the SQS client
 * relies on AWS_ENDPOINT_URL and the default credential chain, i.e. the ECS task role.
 */
export function assertOffAwsQueue(config: OffAwsChecked & Pick<WorkerConfig, 'queue'>): void {
  if (config.queue.backend === 'sqs' && config.offAws && config.app.stage !== LOCAL_DEV_APP_STAGE) {
    throw new Error('QUEUE_BACKEND=sqs is for the AWS stacks only; off AWS use bullmq');
  }
}

/**
 * Refuses AWS S3 through the default chain off AWS outside APP_STAGE=local (as the api does): off
 * AWS, media storage must be an explicit STORAGE_ENDPOINT_URL with its own STORAGE_* keys.
 */
export function assertOffAwsStorage(config: OffAwsChecked & Pick<WorkerConfig, 'storage'>): void {
  if (
    config.offAws &&
    !config.storage.client.explicit &&
    config.app.stage !== LOCAL_DEV_APP_STAGE
  ) {
    throw new Error(
      'Off AWS, media storage needs STORAGE_ENDPOINT_URL and STORAGE_* keys (no default credential chain)',
    );
  }
}
