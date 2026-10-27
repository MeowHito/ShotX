import {
  AUTH_SIGNING_KEY_ENV,
  AWS_CLIENT_ENV,
  BULLMQ_QUEUE_ENV,
  PAYMENT_GATEWAY_SECRET_NAMES,
  SCHEDULE_TIMEZONE_ENV,
  SCHEDULED_JOB_ENV,
  STORAGE_LIFECYCLE_ENV,
} from '@shotx/shared';

/**
 * Fixed platform facts. These are decisions from the platform spec, not tunables: changing one
 * means changing application code too. Everything tunable lives in the `shotx` CDK context
 * (cdk.json), see lib/config.ts.
 */

/** Everything runs in Singapore: Rekognition only reads S3 objects in its own region. */
export const PRIMARY_REGION = 'ap-southeast-1';

/** CloudFront-scoped WAF web ACLs, CloudFront ACM certificates and PricingPlanManager live here. */
export const EDGE_REGION = 'us-east-1';

/** The production stage: payments and email must be real there (no `fake` adapters). */
export const PRODUCTION_STAGE = 'prod';

/** Context key that holds the platform configuration object. */
export const CONTEXT_KEY = 'shotx';

/** CloudFront path contracts shared with the apps. */
export const PATHS = {
  /** API behaviour. The API serves every route under this prefix (CloudFront forwards paths as-is). */
  api: '/api',
  /** Media behaviour. A CloudFront Function strips this prefix before the request reaches S3. */
  media: '/media',
  /** Next.js build assets, cached at the edge for both web and admin. */
  nextStatic: '/_next/static',
} as const;

/**
 * Origin header CloudFront adds to every request so the ALB can tell the web and admin
 * distributions apart. CloudFront overwrites any viewer-supplied header with the same name.
 */
export const APP_ROUTING_HEADER = 'X-ShotX-App';

/**
 * The client address (`ip:port`) CloudFront adds to origin requests when the origin request policy
 * asks for it. CloudFront sets it from the TCP connection, never from a viewer-supplied header, and
 * the ALB only accepts CloudFront (origin-facing prefix list) plus the web and admin tasks. The
 * api reads it in apps/api/src/http/client.ts.
 */
export const VIEWER_ADDRESS_HEADER = 'CloudFront-Viewer-Address';

/** ECS services. web, admin and api sit behind the ALB; worker consumes SQS. */
export const ALB_SERVICES = ['web', 'admin', 'api'] as const;
export type AlbServiceName = (typeof ALB_SERVICES)[number];
export const SERVICE_NAMES = [...ALB_SERVICES, 'worker'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/**
 * Queue names, scheduled job types, S3 prefixes, queue env var names, SQS's 12-hour visibility cap
 * and Rekognition's inline image limit are contracts owned by packages/shared: import them from
 * `@shotx/shared`, never copy them here.
 */

/** Smallest visibility timeout of any queue. The worker heartbeats every third of it. */
export const MIN_VISIBILITY_TIMEOUT_SECONDS = 60;

/** Hard floor for the faces queue visibility timeout agreed with face-poc. */
export const FACES_MIN_VISIBILITY_TIMEOUT_SECONDS = 180;

/**
 * Most face ids one DeleteFaces call accepts (an AWS limit). packages/face has the same value
 * (REKOGNITION_DELETE_FACES_BATCH); infra doesn't import @shotx/face because that pulls in sharp
 * and the AWS SDK.
 */
export const REKOGNITION_DELETE_FACES_BATCH = 4096;

/** Header names the WAF inspects on face-search uploads. */
export const HTTP_HEADERS = {
  contentType: 'content-type',
  contentLength: 'content-length',
} as const;

/** Face search posts selfies as multipart form data (never JSON or base64). */
export const FACE_SEARCH_CONTENT_TYPE = 'multipart/form-data';

/** Fargate's largest container stopTimeout (seconds between SIGTERM and SIGKILL). */
export const ECS_MAX_STOP_TIMEOUT_SECONDS = 120;

/**
 * Environment variables infra sets from typed context values, stack resources or secrets.
 * `services.env` must not set them, so each has exactly one source.
 */
export const INFRA_OWNED_ENV = [
  'FACE_SEARCH_ENABLED',
  'CONSENT_POLICY_VERSION',
  'IP_HASH_SECRET',
  'MEDIA_BUCKET',
  'PAYMENT_GATEWAY',
  ...PAYMENT_GATEWAY_SECRET_NAMES,
  'EMAIL_PROVIDER',
  'EMAIL_FROM_ADDRESS',
  'EMAIL_FROM_NAME',
  // Runtime identity: always production and the configured stage.
  'NODE_ENV',
  'APP_STAGE',
  // Local development stand-ins (packages/shared local-dev): never on a deployed stage, where
  // auth is Cognito, media URLs are CloudFront and AWS credentials come from the task role.
  'AUTH_PROVIDER',
  'MEDIA_URL_SIGNER',
  'AWS_ENDPOINT_URL',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  // Queues are SQS on AWS (ADR 0008 keeps them there until infra/ is removed): `bullmq` would
  // send api and worker to Redis while infra wires, alarms and scales on SQS. The BullMQ settings
  // and schedules have their AWS source in cdk.json (`queues`, `schedules` on EventBridge), so a
  // value here would be ignored and only look like it changed something.
  'QUEUE_BACKEND',
  ...Object.values(BULLMQ_QUEUE_ENV).flatMap((names) => Object.values(names)),
  SCHEDULE_TIMEZONE_ENV,
  ...Object.values(SCHEDULED_JOB_ENV).flatMap((names) => Object.values(names)),
  // API-issued sign-in (AUTH_PROVIDER=shotx, ADR 0008): AWS stacks stay on Cognito and have no
  // Secrets Manager wiring for these, so a value here would be a plaintext secret in the task
  // definition. Google and LINE client ids come from cdk.json `auth` (the Cognito identity
  // providers) and are refused with their secrets so each has one source.
  'AUTH_BFF_KEY',
  ...Object.values(AUTH_SIGNING_KEY_ENV).flatMap((names) => Object.values(names)),
  'ADMIN_TOTP_ENCRYPTION_KEY',
  'LINE_LOGIN_CHANNEL_ID',
  'LINE_LOGIN_CHANNEL_SECRET',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  // The VPS reverse proxy whose X-Forwarded-For the api trusts. On AWS the client address is
  // CloudFront-Viewer-Address (VIEWER_ADDRESS_HEADER); the ALB appends to a viewer-supplied
  // X-Forwarded-For instead of replacing it, so trusting it there would let viewers pick their IP
  // and dodge the per-IP rate limits.
  'TRUSTED_PROXY_ADDRESSES',
  // Redis credentials over plain redis:// to a private host (the VPS compose network). AWS
  // ElastiCache is TLS only (rediss://), so the credentials must never travel in the clear.
  'REDIS_ALLOW_PLAINTEXT_AUTH',
  // Media storage outside AWS S3 (R2 on the VPS, ADR 0008 section 2). AWS stacks use S3 through
  // AWS_REGION and the task role: an endpoint here would move media off the OAC bucket CloudFront
  // serves, the keys would be plaintext secrets in the task definition, and originals stay
  // INTELLIGENT_TIERING as the platform spec requires.
  'STORAGE_ENDPOINT_URL',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_ORIGINALS_CLASS',
  // The read-only signing token of MEDIA_URL_SIGNER=s3-presign (R2). AWS signs with CloudFront.
  'STORAGE_SIGNING_ACCESS_KEY_ID',
  'STORAGE_SIGNING_SECRET_ACCESS_KEY',
  // Bucket lifecycle and CORS of the R2 deploy script (deploy/r2). The AWS bucket's come from
  // cdk.json `storage`; a value here would be ignored.
  ...Object.values(STORAGE_LIFECYCLE_ENV),
  // Rekognition and SES clients off AWS (static keys, endpoint, region). The AWS stacks use the
  // task role and the stack region; keys here would be plaintext secrets in the task definition.
  ...Object.values(AWS_CLIENT_ENV).flatMap((names) => Object.values(names)),
] as const;
