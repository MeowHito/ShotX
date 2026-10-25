/**
 * Fixed platform facts. These are decisions from the platform spec, not tunables: changing one
 * means changing application code too. Everything tunable lives in the `shotx` CDK context
 * (cdk.json), see lib/config.ts.
 */

/** Everything runs in Singapore: Rekognition only reads S3 objects in its own region. */
export const PRIMARY_REGION = 'ap-southeast-1';

/** CloudFront-scoped WAF web ACLs, CloudFront ACM certificates and PricingPlanManager live here. */
export const EDGE_REGION = 'us-east-1';

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

/** S3 key prefixes (see "Upload and processing pipeline" in the platform spec). */
export const S3_PREFIXES = {
  originals: 'originals/',
  derived: 'derived/',
  tmp: 'tmp/',
  tmpIndex: 'tmp/index/',
  tmpZips: 'tmp/zips/',
} as const;

/**
 * Origin header CloudFront adds to every request so the ALB can tell the web and admin
 * distributions apart. CloudFront overwrites any viewer-supplied header with the same name.
 */
export const APP_ROUTING_HEADER = 'X-ShotX-App';

/** SQS queues. Each one gets a dead-letter queue. `jobs` receives EventBridge Scheduler messages. */
export const QUEUE_NAMES = ['media', 'faces', 'zip', 'jobs'] as const;
export type QueueName = (typeof QUEUE_NAMES)[number];

/**
 * Scheduled job types sent to the `jobs` queue as `{ "type": ..., "scheduledTime": ... }`.
 * The worker routes on `type`; contracts should mirror these strings in packages/shared.
 */
export const SCHEDULED_JOB_TYPES = [
  'stats.rollup.hourly',
  'subscriptions.transition.daily',
  'trash.purge.daily',
  'faces.expire.daily',
  'quota.reconcile.nightly',
] as const;
export type ScheduledJobType = (typeof SCHEDULED_JOB_TYPES)[number];

/** ECS services. web, admin and api sit behind the ALB; worker consumes SQS. */
export const ALB_SERVICES = ['web', 'admin', 'api'] as const;
export type AlbServiceName = (typeof ALB_SERVICES)[number];
export const SERVICE_NAMES = [...ALB_SERVICES, 'worker'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

/**
 * Defaults from packages/shared/src/config/face.ts, used only to check that the faces queue
 * visibility timeout covers the worst-case rate-limit wait when cdk.json doesn't override them.
 */
export const FACE_DEFAULTS_FOR_VISIBILITY_CHECK = {
  FACE_TILE_GRID: 2,
  FACE_REKOGNITION_MAX_WAIT_MS: 30_000,
} as const;

/** Hard floor for the faces queue visibility timeout agreed with face-poc. */
export const FACES_MIN_VISIBILITY_TIMEOUT_SECONDS = 180;
