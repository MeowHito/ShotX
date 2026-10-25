import {
  type AppConfig,
  type AuthPool,
  type AwsConfig,
  type CloudFrontSigningConfig,
  type CognitoPoolConfig,
  type DriveConfig,
  type Env,
  loadAppConfig,
  loadAwsConfig,
  loadCloudFrontSigningConfig,
  loadCognitoConfig,
  loadDriveConfig,
  loadMediaStorageConfig,
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

/**
 * API limits that have no @shotx/shared loader yet. They are requested from contracts as
 * environment keys (CONTRACT CHANGE REQUEST in the Phase 2 api report); until then these
 * defaults are the single place they live, and tests pass their own.
 */
export interface ApiLimits {
  /** Largest JSON body of every route except complete (requested key: API_JSON_BODY_MAX_BYTES). */
  jsonBodyMaxBytes: number;
  /**
   * Largest JSON body of `POST /uploads/:id/complete`: up to 10,000 parts with their ETags
   * (requested key: UPLOAD_COMPLETE_BODY_MAX_BYTES).
   */
  completeBodyMaxBytes: number;
  /** `POST /uploads/init` per photographer (requested keys: UPLOAD_INIT_RATE_PER_USER, ..._WINDOW_SECONDS). */
  uploadInitRate: { limit: number; windowSeconds: number };
}

export const DEFAULT_API_LIMITS: ApiLimits = {
  jsonBodyMaxBytes: 64 * 1024,
  completeBodyMaxBytes: 1024 * 1024,
  // Folder drag-and-drop starts one init per file, 4-6 at a time.
  uploadInitRate: { limit: 600, windowSeconds: 60 },
};

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
    limits: DEFAULT_API_LIMITS,
  };
}

/** Key prefix of every Redis key the API writes: `shotx:<stage>:api:`. */
export function redisKeyPrefix(config: Pick<ApiConfig, 'app'>): string {
  return `shotx:${config.app.stage}:api:`;
}
