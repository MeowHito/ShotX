import {
  type ApiLimitsConfig,
  type AppConfig,
  type AuthPool,
  type AuthProviderConfig,
  type AwsConfig,
  type BffAuthConfig,
  type BillingConfig,
  type CaptchaConfig,
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
  apiIssuesTokens,
  type AwsClientConfig,
  loadAwsConfig,
  loadBffAuthConfig,
  loadBillingConfig,
  loadCaptchaConfig,
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
  loadQueueBackendConfig,
  loadRedisConfig,
  loadRekognitionClientConfig,
  loadSesClientConfig,
  loadRetentionConfig,
  loadSentryConfig,
  loadServerConfig,
  loadShareConfig,
  loadSharePasswordHashConfig,
  loadShotxAuthConfig,
  loadTrustedProxyConfig,
  loadUploadConfig,
  type MediaStorageConfig,
  type PaymentGatewayConfig,
  type QueueBackendConfig,
  type RedisConfig,
  type RetentionConfig,
  type SentryConfig,
  type ServerConfig,
  type ShareConfig,
  type SharePasswordHashConfig,
  type ShotxAuthConfig,
  type TrustedProxyConfig,
  type UploadConfig,
  runsOffAws,
} from '@shotx/shared';

/** Port the API listens on when PORT is unset (infra sets 4000 too; health is `/api/health`). */
export const API_DEFAULT_PORT = 4000;

/** Request limits of the API (loadApiLimitsConfig). */
export type ApiLimits = ApiLimitsConfig;

/**
 * The queues the API may send to: `original.completed` after an upload completes (ADR 0008
 * section 2; BullMQ only, see API_SQS_QUEUES), face index/unindex/deletion jobs and zip jobs.
 */
export const API_QUEUES = ['media', 'faces', 'zip'] as const;
export type ApiQueue = (typeof API_QUEUES)[number];

/**
 * The queues the API sends to on SQS (AWS stacks): S3 ObjectCreated notifications feed `media`
 * there, and the api task has neither MEDIA_QUEUE_URL nor a send grant on it, so `media` is not
 * an SQS destination of the api.
 */
export const API_SQS_QUEUES = ['faces', 'zip'] as const satisfies readonly ApiQueue[];
export type ApiSqsQueue = (typeof API_SQS_QUEUES)[number];

/** QUEUE_BACKEND of the api: SQS URLs of API_SQS_QUEUES, or BullMQ settings of API_QUEUES. */
export type ApiQueueConfig =
  | Extract<QueueBackendConfig<ApiSqsQueue>, { backend: 'sqs' }>
  | Extract<QueueBackendConfig<ApiQueue>, { backend: 'bullmq' }>;

function loadApiQueueConfig(env: Env): ApiQueueConfig {
  const sqs = loadQueueBackendConfig(env, API_SQS_QUEUES);
  if (sqs.backend === 'sqs') return sqs;
  const bullmq = loadQueueBackendConfig(env, API_QUEUES);
  if (bullmq.backend !== 'bullmq') throw new Error('QUEUE_BACKEND changed while loading');
  return bullmq;
}

/**
 * True when the api starts the media pipeline itself (`original.completed` to `media`): with
 * BullMQ (R2 has no bucket notifications). On SQS, S3 ObjectCreated does it.
 */
export function apiSendsMediaJobs(config: Pick<ApiConfig, 'queues'>): boolean {
  return config.queues.backend === 'bullmq';
}

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
  /** Both pools with AUTH_PROVIDER=cognito; null with `shotx` and `local`, which need no Cognito. */
  cognito: Record<AuthPool, CognitoPoolConfig> | null;
  /**
   * The API's own token issuer (keys, OIDC clients, admin sign-in) with AUTH_PROVIDER=shotx or
   * local; null with `cognito`. Secret: never log it.
   */
  shotxAuth: ShotxAuthConfig | null;
  /**
   * AUTH_BFF_KEY: required on the `bff` sign-in routes and to trust BFF_CLIENT_IP_HEADER. Null
   * when unset (only allowed with `cognito`). Secret: never log it.
   */
  bff: BffAuthConfig | null;
  /** TRUSTED_PROXY_ADDRESSES: reverse proxies whose X-Forwarded-For is trusted. */
  trustedProxies: TrustedProxyConfig;
  /**
   * runsOffAws: AUTH_PROVIDER=shotx/local or STORAGE_ENDPOINT_URL set (the VPS, and local runs
   * like it). There is no task role then: every AWS client gets explicit keys, and nothing may use
   * AWS_ENDPOINT_URL or the default credential chain (wiring refuses SQS and AWS S3 there).
   */
  offAws: boolean;
  /** Rekognition (face search and deletion): REKOGNITION_* (explicit keys off AWS). Secret. */
  rekognitionClient: AwsClientConfig;
  /**
   * SES with EMAIL_PROVIDER=ses (SES_*), else null. Validated here; the api builds no SES client
   * yet (SesEmailProvider is wired without one). Secret.
   */
  sesClient: AwsClientConfig | null;
  /**
   * CAPTCHA_PROVIDER: `turnstile` (the VPS) verifies a token after a FACE_SEARCH_RATE_* hit and
   * grants more attempts; `waf` (AWS: the edge challenges) and `none` only rate-limit. Secret.
   */
  captcha: CaptchaConfig;
  sentry: SentryConfig;
  limits: ApiLimits;
  features: FeatureFlags;
  consent: ConsentConfig;
  face: FaceConfig;
  faceUpload: FaceSearchUploadConfig;
  /** QUEUE_BACKEND: SQS queue URLs, or BullMQ prefix and per-queue job settings. */
  queues: ApiQueueConfig;
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
    shotxAuth: apiIssuesTokens(auth.provider) ? loadShotxAuthConfig(env) : null,
    bff: loadBffAuthConfig(env),
    trustedProxies: loadTrustedProxyConfig(env),
    offAws: runsOffAws(env),
    rekognitionClient: loadRekognitionClientConfig(env),
    sesClient: loadSesClientConfig(env),
    captcha: loadCaptchaConfig(env),
    sentry: loadSentryConfig(env),
    limits: loadApiLimitsConfig(env),
    features: loadFeatureFlags(env),
    consent: loadConsentConfig(env),
    face: loadFaceConfig(env),
    faceUpload: loadFaceSearchUploadConfig(env),
    queues: loadApiQueueConfig(env),
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

/** Which callers may tell the API the client address (http/client clientIp). */
export function clientIpTrust(config: Pick<ApiConfig, 'bff' | 'trustedProxies'>) {
  return { bffKey: config.bff?.key ?? null, proxies: config.trustedProxies };
}

/** Cookies get `Secure` unless the site itself is plain http (localhost development). */
export function secureCookies(config: Pick<ApiConfig, 'app'>): boolean {
  return config.app.publicBaseUrl.startsWith('https://');
}
