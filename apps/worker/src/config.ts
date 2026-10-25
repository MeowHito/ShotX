import { type DatabaseConfig, loadDatabaseConfig } from '@shotx/db';
import {
  type AppConfig,
  type AwsConfig,
  type BillingConfig,
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
  loadQueueUrls,
  loadQueueVisibilityTimeouts,
  loadRedisConfig,
  loadRetentionConfig,
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
  type ShareConfig,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
  type WorkerSettings,
} from '@shotx/shared';

/** Queues the worker consumes: every queue (media, faces, zip, jobs). */
export const CONSUMED_QUEUES = QUEUE_NAMES;
export type ConsumedQueue = QueueName;

/** The zip limits and result lifetime (ZIP_MAX_FILES, ZIP_MAX_BYTES, ZIP_RESULT_TTL_SECONDS). */
export type ZipConfig = ShareConfig['zip'];

export interface WorkerConfig {
  app: AppConfig;
  aws: AwsConfig;
  storage: MediaStorageConfig;
  database: DatabaseConfig;
  redis: RedisConfig;
  queueUrls: Record<QueueName, string>;
  visibilityTimeoutSeconds: Record<QueueName, number>;
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
  const visibilityTimeoutSeconds = loadQueueVisibilityTimeouts(env, CONSUMED_QUEUES);
  for (const queue of CONSUMED_QUEUES) {
    const seconds = visibilityTimeoutSeconds[queue];
    if (seconds < 3 || seconds > SQS_MAX_VISIBILITY_TIMEOUT_SECONDS) {
      throw new Error(
        `Invalid queue configuration: the ${queue} visibility timeout must be at least 3 s for heartbeats`,
      );
    }
  }
  return {
    app: loadAppConfig(env),
    aws: loadAwsConfig(env),
    storage: loadMediaStorageConfig(env),
    database: loadDatabaseConfig(env),
    redis: loadRedisConfig(env),
    queueUrls: loadQueueUrls(env, CONSUMED_QUEUES),
    visibilityTimeoutSeconds,
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
