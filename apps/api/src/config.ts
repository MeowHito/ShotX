import {
  type ApiLimitsConfig,
  type AppConfig,
  type AuthPool,
  type AwsConfig,
  type CloudFrontSigningConfig,
  type CognitoPoolConfig,
  type ConsentConfig,
  type DriveConfig,
  type Env,
  type FaceConfig,
  type FaceSearchUploadConfig,
  type FeatureFlags,
  loadApiLimitsConfig,
  loadAppConfig,
  loadAwsConfig,
  loadCloudFrontSigningConfig,
  loadCognitoConfig,
  loadConsentConfig,
  loadDriveConfig,
  loadFaceConfig,
  loadFaceSearchUploadConfig,
  loadFeatureFlags,
  loadMediaStorageConfig,
  loadQueueUrls,
  loadRedisConfig,
  loadRetentionConfig,
  loadSentryConfig,
  loadServerConfig,
  loadShareConfig,
  loadUploadConfig,
  type MediaStorageConfig,
  type RedisConfig,
  type RetentionConfig,
  type SentryConfig,
  type ServerConfig,
  type ShareConfig,
  type UploadConfig,
} from '@shotx/shared';

/** Port the API listens on when PORT is unset (infra sets 4000 too; health is `/api/health`). */
export const API_DEFAULT_PORT = 4000;

/** Request limits of the API (loadApiLimitsConfig). */
export type ApiLimits = ApiLimitsConfig;

/** The queues the API sends to: face index/unindex/deletion jobs and zip jobs. */
export const API_QUEUES = ['faces', 'zip'] as const;
export type ApiQueue = (typeof API_QUEUES)[number];

export interface ApiConfig {
  app: AppConfig;
  server: ServerConfig;
  aws: AwsConfig;
  storage: MediaStorageConfig;
  redis: RedisConfig;
  upload: UploadConfig;
  drive: DriveConfig;
  share: ShareConfig;
  retention: RetentionConfig;
  cloudFront: CloudFrontSigningConfig;
  cognito: Record<AuthPool, CognitoPoolConfig>;
  sentry: SentryConfig;
  limits: ApiLimits;
  features: FeatureFlags;
  consent: ConsentConfig;
  face: FaceConfig;
  faceUpload: FaceSearchUploadConfig;
  queues: Record<ApiQueue, string>;
}

/** Everything the API reads from the environment, through the shared loaders only. */
export function loadApiConfig(env: Env): ApiConfig {
  return {
    app: loadAppConfig(env),
    server: loadServerConfig(env, API_DEFAULT_PORT),
    aws: loadAwsConfig(env),
    storage: loadMediaStorageConfig(env),
    redis: loadRedisConfig(env),
    upload: loadUploadConfig(env),
    drive: loadDriveConfig(env),
    share: loadShareConfig(env),
    retention: loadRetentionConfig(env),
    cloudFront: loadCloudFrontSigningConfig(env),
    cognito: loadCognitoConfig(env, ['users', 'admins']),
    sentry: loadSentryConfig(env),
    limits: loadApiLimitsConfig(env),
    features: loadFeatureFlags(env),
    consent: loadConsentConfig(env),
    face: loadFaceConfig(env),
    faceUpload: loadFaceSearchUploadConfig(env),
    queues: loadQueueUrls(env, API_QUEUES),
  };
}

/** Key prefix of every Redis key the API writes: `shotx:<stage>:api:`. */
export function redisKeyPrefix(config: Pick<ApiConfig, 'app'>): string {
  return `shotx:${config.app.stage}:api:`;
}

/** Cookies get `Secure` unless the site itself is plain http (localhost development). */
export function secureCookies(config: Pick<ApiConfig, 'app'>): boolean {
  return config.app.publicBaseUrl.startsWith('https://');
}
