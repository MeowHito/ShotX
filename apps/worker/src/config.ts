import { type DatabaseConfig, loadDatabaseConfig } from '@shotx/db';
import {
  type AppConfig,
  type AwsClientConfig,
  type AwsConfig,
  type BillingConfig,
  type BullMqQueueSettings,
  type EmailConfig,
  type Env,
  type FaceConfig,
  type FeatureFlags,
  loadAppConfig,
  loadAwsConfig,
  loadBillingConfig,
  loadEmailConfig,
  loadFaceConfig,
  loadFeatureFlags,
  loadMediaConfig,
  loadMediaStorageConfig,
  loadPaymentGatewayConfig,
  loadQueueBackendConfig,
  loadQueueVisibilityTimeouts,
  loadRedisConfig,
  loadRekognitionClientConfig,
  loadRetentionConfig,
  loadScheduledJobsConfig,
  loadSesClientConfig,
  loadShareConfig,
  loadUploadConfig,
  loadWorkerSettings,
  type MediaConfig,
  type MediaStorageConfig,
  type PaymentGatewayConfig,
  QUEUE_NAMES,
  type QueueName,
  type RedisConfig,
  type RetentionConfig,
  type ScheduledJobsConfig,
  type ShareConfig,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
  type WorkerSettings,
} from '@shotx/shared';

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
   * Rekognition's region, endpoint and keys (ADR 0008 section 1): explicit, never
   * AWS_ENDPOINT_URL or the default chain off AWS. Secret: never log it.
   */
  rekognitionClient: AwsClientConfig;
  /** The SES client with EMAIL_PROVIDER=ses, else null. Secret: never log it. */
  sesClient: AwsClientConfig | null;
  storage: MediaStorageConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  queue: WorkerQueueConfig;
  media: MediaConfig;
  retention: RetentionConfig;
  face: FaceConfig;
  features: FeatureFlags;
  zip: ZipConfig;
  /** UPLOAD_PART_BYTES: the preferred part size of the zip consumer's multipart uploads. */
  multipartPartBytes: number;
  /** WORKER_* settings and LOG_LEVEL (loadWorkerSettings in @shotx/shared). */
  worker: WorkerSettings;
  /** Billing tunables (auto-renew attempts and lead, VAT) for subscriptions.transition.daily. */
  billing: BillingConfig;
  /** EMAIL_PROVIDER and the sender (lifecycle emails and receipts). */
  email: EmailConfig;
  /**
   * PAYMENT_GATEWAY and its secrets, for auto-renew charges. Secret: never log this object.
   */
  paymentGateway: PaymentGatewayConfig;
}

/** Everything the worker reads from the environment, validated at start-up. */
export function loadWorkerConfig(env: Env): WorkerConfig {
  return {
    app: loadAppConfig(env),
    aws: loadAwsConfig(env),
    rekognitionClient: loadRekognitionClientConfig(env),
    sesClient: loadSesClientConfig(env),
    storage: loadMediaStorageConfig(env),
    database: loadDatabaseConfig(env),
    redis: loadRedisConfig(env),
    queue: loadWorkerQueueConfig(env),
    media: loadMediaConfig(env),
    retention: loadRetentionConfig(env),
    face: loadFaceConfig(env),
    features: loadFeatureFlags(env),
    zip: loadShareConfig(env).zip,
    multipartPartBytes: loadUploadConfig(env).partBytes,
    worker: loadWorkerSettings(env),
    billing: loadBillingConfig(env),
    email: loadEmailConfig(env),
    paymentGateway: loadPaymentGatewayConfig(env),
  };
}

/** QUEUE_BACKEND and its settings for the consumed queues. */
export function loadWorkerQueueConfig(env: Env): WorkerQueueConfig {
  const backend = loadQueueBackendConfig(env, CONSUMED_QUEUES);
  if (backend.backend === 'bullmq') {
    return { ...backend, schedules: loadScheduledJobsConfig(env) };
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
