import {
  type ApiLimitsConfig,
  type AppConfig,
  type AuthPool,
  type AuthProviderConfig,
  type AwsConfig,
  type BillingConfig,
  type CloudFrontSigningConfig,
  type CognitoPoolConfig,
  type ConsentConfig,
  type DriveConfig,
  type EmailConfig,
  type Env,
  type FaceConfig,
  type FaceSearchUploadConfig,
  type FeatureFlags,
  type MediaUrlSignerConfig,
  loadApiLimitsConfig,
  loadAppConfig,
  loadAuthProviderConfig,
  loadAwsConfig,
  loadBillingConfig,
  loadCloudFrontSigningConfig,
  loadCognitoConfig,
  loadConsentConfig,
  loadDriveConfig,
  loadEmailConfig,
  loadFaceConfig,
  loadFaceSearchUploadConfig,
  loadFeatureFlags,
  loadMediaStorageConfig,
  loadMediaUrlSignerConfig,
  loadPaymentGatewayConfig,
  loadQueueUrls,
  loadRedisConfig,
  loadRetentionConfig,
  loadSentryConfig,
  loadServerConfig,
  loadShareConfig,
  loadSharePasswordHashConfig,
  loadUploadConfig,
  type MediaStorageConfig,
  type PaymentGatewayConfig,
  type RedisConfig,
  type RetentionConfig,
  type SentryConfig,
  type ServerConfig,
  type ShareConfig,
  type SharePasswordHashConfig,
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
  /** `s3-presign` only on APP_STAGE=local (LocalStack has no CloudFront). */
  mediaUrls: MediaUrlSignerConfig;
  /** Set with MEDIA_URL_SIGNER=cloudfront; null with `s3-presign`. */
  cloudFront: CloudFrontSigningConfig | null;
  /** `local` only on APP_STAGE=local (loadAuthProviderConfig refuses it anywhere else). */
  auth: AuthProviderConfig;
  /** Both pools with AUTH_PROVIDER=cognito; null with `local`, which needs no Cognito. */
  cognito: Record<AuthPool, CognitoPoolConfig> | null;
  sentry: SentryConfig;
  limits: ApiLimits;
  features: FeatureFlags;
  consent: ConsentConfig;
  face: FaceConfig;
  faceUpload: FaceSearchUploadConfig;
  queues: Record<ApiQueue, string>;
  /** argon2id parameters of new share password hashes. */
  password: SharePasswordHashConfig;
  billing: BillingConfig;
  /** Secret (gateway keys): never log it. `fake` is refused in production by the loader. */
  paymentGateway: PaymentGatewayConfig;
  /** `fake` is refused in production by the loader. */
  email: EmailConfig;
}

/** Everything the API reads from the environment, through the shared loaders only. */
export function loadApiConfig(env: Env): ApiConfig {
  const auth = loadAuthProviderConfig(env);
  const mediaUrls = loadMediaUrlSignerConfig(env);
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
    mediaUrls,
    cloudFront: mediaUrls.signer === 'cloudfront' ? loadCloudFrontSigningConfig(env) : null,
    auth,
    cognito: auth.provider === 'cognito' ? loadCognitoConfig(env, ['users', 'admins']) : null,
    sentry: loadSentryConfig(env),
    limits: loadApiLimitsConfig(env),
    features: loadFeatureFlags(env),
    consent: loadConsentConfig(env),
    face: loadFaceConfig(env),
    faceUpload: loadFaceSearchUploadConfig(env),
    queues: loadQueueUrls(env, API_QUEUES),
    password: loadSharePasswordHashConfig(env),
    billing: loadBillingConfig(env),
    paymentGateway: loadPaymentGatewayConfig(env),
    email: loadEmailConfig(env),
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
