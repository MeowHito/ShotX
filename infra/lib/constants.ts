import { PAYMENT_GATEWAY_SECRET_NAMES, S3_PREFIXES } from '@shotx/shared';

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
 * Scan files of the reconciliation jobs (worker only). packages/shared has no constant for this
 * prefix yet, so it is built from S3_PREFIXES.tmp here; the worker must write under exactly this
 * prefix, the only part of tmp/ it may read back and delete besides tmp/index/.
 */
export const TMP_RECONCILE_PREFIX = `${S3_PREFIXES.tmp}reconcile/`;

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
] as const;
