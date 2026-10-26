import {
  apiPath,
  BILLING_ROUTES,
  CONSENT_POLICY_VERSIONS,
  CONTENT_DISPOSITION_QUERY_PARAM,
  EMAIL_PROVIDERS,
  type FaceConfig,
  loadEmailConfig,
  LOCAL_DEV_APP_STAGE,
  loadUploadConfig,
  PAYMENT_GATEWAY_SECRET_ENV,
  PAYMENT_GATEWAYS,
  type QueueName,
  S3_PREFIXES,
  SCHEDULED_JOB_TYPES,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
  TMP_LIFECYCLE_MAX_DAYS,
  type WorkerSettings,
} from '@shotx/shared';
import type { App } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { z } from 'zod';
import {
  CONTEXT_KEY,
  FACES_MIN_VISIBILITY_TIMEOUT_SECONDS,
  INFRA_OWNED_ENV,
  MIN_VISIBILITY_TIMEOUT_SECONDS,
  PRODUCTION_STAGE,
} from './constants';
import {
  type FaceSearchBodyLimits,
  faceSearchBodyLimits,
  facesJobWorstCase,
  type FacesJobWorstCase,
  heartbeatQueueIssues,
  minOrphanGraceMs,
  serviceFaceConfig,
} from './face-limits';
import {
  describeZipLifetime,
  minReconcileExpirationDays,
  minZipExpirationDays,
  serviceShareConfig,
  serviceWorkerSettings,
  workerStopTimeoutIssue,
  zipJobWorstCaseSeconds,
  zipObjectLifetime,
  type ZipObjectLifetime,
} from './worker-limits';

// Values from cdk.json arrive typed; values from `-c shotx:<path>=<value>` arrive as strings.
// These helpers accept both.
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const str = z.coerce.string();
const nonEmpty = str.pipe(z.string().min(1));
const hostname = str.pipe(
  z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, {
    error: 'must be a lowercase DNS name',
  }),
);
const cidr = str.pipe(
  z.string().regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, { error: 'must be an IPv4 CIDR' }),
);
/** CloudFront only accepts ACM certificates from us-east-1. Empty means "create one". */
const optionalEdgeCertificateArn = str.pipe(
  z.string().regex(/^$|^arn:aws:acm:us-east-1:\d{12}:certificate\/[0-9a-f-]+$/, {
    error: 'must be empty or an ACM certificate ARN in us-east-1',
  }),
);
const logRetention = z.coerce
  .number()
  .int()
  .refine((v) => (Object.values(RetentionDays) as unknown[]).includes(v), {
    error:
      'must be a CloudWatch Logs retention value (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, ...)',
  });
/** Days of a tmp/ lifecycle rule: the spec's 1-3 days (ADR 0006). */
const tmpDays = int(1, TMP_LIFECYCLE_MAX_DAYS);
/** Secrets Manager secret names: letters, digits and /_+=.@- (AWS rule). */
const SECRET_NAME = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
/** An email address at a lowercase DNS domain, which becomes the SES domain identity. */
const EMAIL_AT_DNS_DOMAIN =
  /^[^@\s]+@(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const envMap = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), str);
/** WAF lowercases the URI path before matching, so configured paths must be lowercase too. */
const lowercasePath = str.pipe(
  z
    .string()
    .startsWith('/')
    .refine((p) => p === p.toLowerCase(), { error: 'must be lowercase (WAF lowercases the path)' }),
);

const albServiceSchema = z.object({
  cpu: int(256, 16384),
  memoryMiB: int(512, 122880),
  minCapacity: int(1, 100),
  maxCapacity: int(1, 200),
  containerPort: int(1, 65535),
  healthCheckPath: str.pipe(z.string().startsWith('/')),
  cpuTargetUtilizationPercent: int(10, 95),
});

const scalingStepSchema = z
  .object({
    lower: z.coerce.number().min(0).optional(),
    upper: z.coerce.number().min(0).optional(),
    change: z.coerce.number().int(),
  })
  .refine((s) => s.lower !== undefined || s.upper !== undefined, {
    error: 'a scaling step needs lower or upper',
  });

const workerSchema = z.object({
  cpu: int(256, 16384),
  memoryMiB: int(512, 122880),
  minCapacity: int(0, 100),
  maxCapacity: int(1, 200),
  ephemeralStorageGiB: int(21, 200),
  /**
   * The container's stopTimeout is WORKER_SHUTDOWN_GRACE_SECONDS plus this, so messages still
   * running after the grace get their visibility reset before ECS kills the task. At most 120 s
   * in total (Fargate's limit).
   */
  stopTimeoutMarginSeconds: int(1, 120),
  queueDepthScaling: z.object({
    periodSeconds: int(60, 3600),
    cooldownSeconds: int(0, 3600),
    steps: z.array(scalingStepSchema).min(2),
  }),
});

/**
 * Every queue is consumed with heartbeats: the worker extends a message's visibility every third
 * of the timeout until the job ends. The timeout is how long a crashed worker's message stays
 * hidden, not how long a job may run (see heartbeatQueueIssues in lib/face-limits.ts).
 */
const queueSchema = z.object({
  visibilityTimeoutSeconds: int(MIN_VISIBILITY_TIMEOUT_SECONDS, SQS_MAX_VISIBILITY_TIMEOUT_SECONDS),
  retentionDays: int(1, 14),
  dlqRetentionDays: int(1, 14),
  maxReceiveCount: int(1, 1000),
  receiveWaitSeconds: int(0, 20),
  alarms: z.object({
    dlqVisibleMessagesThreshold: int(1, 1_000_000),
    oldestMessageAgeSeconds: int(60, 1_209_600),
    /** Consecutive 1-minute periods above the age threshold before the alarm fires. */
    oldestMessageAgeEvaluationPeriods: int(1, 60),
  }),
});

/**
 * The faces queue also carries the inputs of its worst-case job that FaceConfig doesn't have (see
 * facesJobWorstCase in lib/face-limits.ts). The rest comes from the worker's FACE_* values,
 * including FACE_REKOGNITION_REQUEST_TIMEOUT_MS.
 */
const facesQueueSchema = queueSchema.extend({
  visibilityTimeoutSeconds: int(
    FACES_MIN_VISIBILITY_TIMEOUT_SECONDS,
    SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
  ),
  jobBudget: z.object({
    /** Collection calls a faces job may make before indexing (CreateCollection + Describe). */
    collectionCallsPerJob: int(0, 10),
    /** Non-Rekognition work for one photo: decode, tile encodes, S3 temp objects, DB writes. */
    processingSeconds: int(0, 3600),
  }),
});

/**
 * The zip queue carries the inputs of its worst-case job that ShareConfig doesn't have (see
 * zipJobWorstCaseSeconds in lib/worker-limits.ts); ZIP_MAX_BYTES comes from the worker's env.
 */
const zipQueueSchema = queueSchema.extend({
  jobBudget: z.object({
    minThroughputBytesPerSecond: int(64 * 1024, 10 * 1024 * 1024 * 1024),
    processingSeconds: int(0, 3600),
  }),
});

/** Redis ACL rules, split into tokens. */
const aclTokens = (rules: string) => rules.trim().split(/\s+/);

const scheduleSchema = z.object({
  expression: str.pipe(
    z.string().regex(/^(cron|rate)\(.+\)$/, { error: 'must be cron(...) or rate(...)' }),
  ),
  enabled: bool,
});

export const configSchema = z
  .object({
    // `local` is reserved for laptops: the shared loaders allow the local stand-ins only there.
    stage: str.pipe(
      z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,15}$/)
        .refine((stage) => stage !== LOCAL_DEV_APP_STAGE, {
          error: `"${LOCAL_DEV_APP_STAGE}" is reserved for local development`,
        }),
    ),
    account: str.pipe(z.string().regex(/^\d{12}$/, { error: 'must be a 12-digit AWS account id' })),
    tags: z.record(z.string(), str),

    domain: z.object({
      main: hostname,
      admin: hostname,
      /** Route 53 hosted zone. Leave both empty when DNS is managed outside Route 53. */
      hostedZoneId: str,
      hostedZoneName: str,
      /** Existing us-east-1 ACM certificates. Empty means the Edge stack creates DNS-validated ones. */
      certificateArn: optionalEdgeCertificateArn,
      adminCertificateArn: optionalEdgeCertificateArn,
    }),

    network: z.object({
      cidr,
      /** AZs used (Multi-AZ RDS and Redis need at least 2). Picked with Fn::GetAZs at deploy. */
      azCount: int(2, 3),
      natGateways: int(1, 3),
      subnetCidrMasks: z.object({ public: int(16, 28), app: int(16, 28), data: int(16, 28) }),
      /** Interface endpoint service names, e.g. "ecr.api", "logs", "sqs", "rekognition". */
      interfaceEndpoints: z.array(nonEmpty),
      /** Managed prefix list com.amazonaws.global.cloudfront.origin-facing in ap-southeast-1. */
      cloudFrontOriginFacingPrefixListId: str.pipe(z.string().regex(/^pl-[0-9a-f]+$/)),
    }),

    registry: z.object({ keepImages: int(1, 1000) }),

    database: z.object({
      engineVersion: str.pipe(z.string().regex(/^\d+\.\d+$/, { error: 'must be <major>.<minor>' })),
      instanceType: nonEmpty,
      databaseName: str.pipe(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)),
      username: str.pipe(z.string().regex(/^[a-z][a-z0-9_]{0,62}$/)),
      port: int(1150, 65535),
      allocatedStorageGiB: int(20, 65_536),
      maxAllocatedStorageGiB: int(20, 65_536),
      backupRetentionDays: int(1, 35),
      deletionProtection: bool,
      monitoringIntervalSeconds: z.coerce
        .number()
        .pipe(z.union([0, 1, 5, 10, 15, 30, 60].map((n) => z.literal(n)))),
      performanceInsights: bool,
      logRetentionDays: logRetention,
    }),

    redis: z.object({
      engine: z.enum(['redis', 'valkey']),
      engineVersion: nonEmpty,
      nodeType: str.pipe(z.string().startsWith('cache.')),
      /** Primary plus replicas. At least 2 for Multi-AZ automatic failover. */
      numCacheClusters: int(2, 6),
      port: int(1024, 65535),
      snapshotRetentionDays: int(0, 35),
      /** RBAC user api and worker authenticate as. The `default` user is always disabled. */
      username: str.pipe(
        z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9-]{0,39}$/)
          .refine((u) => u !== 'default', { error: 'the default user is disabled' }),
      ),
      /**
       * Redis ACL rules for that user, e.g. "on ~* &* +@all -@dangerous". `-@dangerous` (FLUSHALL,
       * FLUSHDB, KEYS, CONFIG, DEBUG, INFO, ...) is required, and no rule after it may allow a
       * command again.
       */
      accessString: str.pipe(
        z
          .string()
          .startsWith('on ', { error: 'must start with "on "' })
          .refine(
            (rules) => {
              const tokens = aclTokens(rules);
              const i = tokens.lastIndexOf('-@dangerous');
              return (
                i >= 0 &&
                tokens.slice(i + 1).every((t) => !t.startsWith('+') && t !== 'allcommands')
              );
            },
            { error: 'must deny -@dangerous, with no +rule or allcommands after it' },
          ),
      ),
      /**
       * maxmemory-policy is noeviction (ADR 0005): writes fail when memory is full, so this alarm
       * is the early warning. DatabaseMemoryUsagePercentage, highest node.
       */
      alarms: z.object({
        memoryUsagePercentThreshold: z.coerce.number().gt(0).lt(100),
        periodSeconds: z.coerce.number().pipe(z.union([60, 300].map((n) => z.literal(n)))),
        evaluationPeriods: int(1, 60),
      }),
    }),

    storage: z.object({
      abortIncompleteMultipartUploadDays: int(1, 7),
      /**
       * tmp/ has one lifecycle rule per prefix (S3 applies the shortest matching expiration, so a
       * single tmp/ rule would cut zips short). Every tmp/ rule stays within the spec's 1-3 days
       * (TMP_LIFECYCLE_MAX_DAYS, ADR 0006). tmp/index/ holds face-index scratch images that are
       * deleted right after IndexFaces: keep it short.
       */
      tmpIndexExpirationDays: tmpDays,
      /** tmp/zips/: at least ZIP_RESULT_TTL_SECONDS plus the margins in minZipExpirationDays. */
      tmpZipsExpirationDays: tmpDays,
      /**
       * tmp/reconcile/: the worker's reconciliation scan files. A scan must survive one orphan
       * grace (FACE_ORPHAN_GRACE_MS) plus one daily run (minReconcileExpirationDays).
       */
      tmpReconcileExpirationDays: tmpDays,
      /**
       * Anything else under tmp/. Must be at least every per-prefix value above, or it would
       * expire those objects first.
       */
      tmpOtherExpirationDays: tmpDays,
      originalsIntelligentTieringAfterDays: int(0, 3650),
      uploadCorsMaxAgeSeconds: int(0, 86_400),
      cloudFrontLogExpirationDays: int(1, 3650),
    }),

    queues: z.object({
      media: queueSchema,
      faces: facesQueueSchema,
      zip: zipQueueSchema,
      jobs: queueSchema,
    }),

    alarms: z.object({
      /** Optional email subscribed to the alarm topic. Empty means no subscription. */
      email: str.pipe(z.union([z.literal(''), z.email()])),
      /**
       * Period of the alarm on the api's FACE_DELETION_ALERT_EVENT log line (ADR 0007): it fires
       * when any such line is logged in a period.
       */
      faceDeletionAlertPeriodSeconds: z.coerce
        .number()
        .pipe(z.union([60, 300, 900, 3600].map((n) => z.literal(n)))),
    }),

    services: z.object({
      imageTag: nonEmpty,
      cpuArchitecture: z.enum(['ARM64', 'X86_64']),
      containerInsights: z.enum(['enabled', 'enhanced', 'disabled']),
      logRetentionDays: logRetention,
      albIdleTimeoutSeconds: int(1, 4000),
      targetDeregistrationDelaySeconds: int(0, 3600),
      healthCheckGracePeriodSeconds: int(0, 2_147_483_647),
      web: albServiceSchema,
      admin: albServiceSchema,
      api: albServiceSchema,
      worker: workerSchema,
      /**
       * Extra environment variables. `common` goes to every service, `backend` to api and worker
       * (FACE_* keys, which must match because both share the Redis rate-limit buckets), and the
       * named groups to one service. Later groups win. UPLOAD_* keys read by loadUploadConfig
       * belong in `common` only (web and api must agree on part size and limits), and the
       * INFRA_OWNED_ENV keys can't be set here at all.
       */
      env: z.object({
        common: envMap,
        backend: envMap,
        web: envMap,
        admin: envMap,
        api: envMap,
        worker: envMap,
      }),
    }),

    cdn: z.object({
      priceClass: z.enum(['PriceClass_100', 'PriceClass_200', 'PriceClass_All']),
      adminPriceClass: z.enum(['PriceClass_100', 'PriceClass_200', 'PriceClass_All']),
      /** RSA public key (PEM) for the CloudFront key group. The private key stays in Secrets Manager. */
      signingPublicKeyPem: str.pipe(z.string().includes('-----BEGIN PUBLIC KEY-----')),
      originReadTimeoutSeconds: int(1, 180),
      originKeepaliveSeconds: int(1, 180),
      media: z.object({
        minTtlSeconds: int(0, 31_536_000),
        defaultTtlSeconds: int(0, 31_536_000),
        maxTtlSeconds: int(0, 31_536_000),
        /**
         * Query strings forwarded to S3 and part of the cache key (S3 response overrides). Must
         * include response-content-disposition: downloads are signed URLs with
         * `Content-Disposition: attachment; filename=...` as an S3 override, and without it in
         * the cache key a download and an inline view of the same object would share one entry.
         */
        cacheQueryStrings: z
          .array(nonEmpty)
          .refine((q) => q.includes(CONTENT_DISPOSITION_QUERY_PARAM), {
            error: `must include ${CONTENT_DISPOSITION_QUERY_PARAM} (attachment downloads)`,
          }),
        /** S3 prefixes CloudFront may read. tmp/index/ must never be listed. */
        readablePrefixes: z
          .array(str.pipe(z.string().regex(/^[a-z0-9/_-]+\/$/)))
          .min(1)
          .refine((p) => !p.some((x) => S3_PREFIXES.tmpIndex.startsWith(x)), {
            error: 'CloudFront must not be able to read tmp/index/ (face-index scratch images)',
          }),
        /**
         * Response headers on /media/*. User uploads are served from the main origin, so a file
         * with an HTML or SVG content type must never run as an active document there.
         */
        responseHeaders: z.object({
          contentSecurityPolicy: str.pipe(
            z
              .string()
              .refine((v) => /(^|;)\s*default-src 'none'\s*(;|$)/.test(v), {
                error: "must contain default-src 'none'",
              })
              .refine((v) => /(^|;)\s*sandbox\s*(;|$)/.test(v), {
                error: 'must contain a bare sandbox directive (no allow-* tokens)',
              })
              .refine(
                (v) => !/(^|;)\s*media-src\b/.test(v) || /(^|;)\s*media-src 'self'\s*(;|$)/.test(v),
                {
                  error: "media-src may only be 'self' (the media document loading its own URL)",
                },
              ),
          ),
          /**
           * Access-Control-Allow-Origin on /media/*. A media file opened in its own tab becomes a
           * sandboxed document with an opaque origin, and Chromium fetches the video again in
           * CORS mode from that origin (`Origin: null`), so direct playback needs "*". Never
           * with credentials: media URLs are signed, no cookies are involved. Empty: no CORS.
           */
          corsAllowOrigins: z.array(
            str.pipe(
              z.string().regex(/^\*$|^https:\/\/[a-z0-9.-]+(:\d+)?$/, {
                error: 'must be "*" or an https origin (never "null")',
              }),
            ),
          ),
          referrerPolicy: z.enum([
            'no-referrer',
            'no-referrer-when-downgrade',
            'origin',
            'origin-when-cross-origin',
            'same-origin',
            'strict-origin',
            'strict-origin-when-cross-origin',
            'unsafe-url',
          ]),
          hstsMaxAgeSeconds: int(0, 63_072_000),
          hstsIncludeSubdomains: bool,
          hstsPreload: bool,
        }),
      }),
      flatRatePlan: z.object({
        enabled: bool,
        tier: z.enum(['PRO', 'BUSINESS', 'PREMIUM']),
        attachHostedZone: bool,
      }),
    }),

    waf: z.object({
      evaluationWindowSeconds: z.coerce
        .number()
        .pipe(z.union([60, 120, 300, 600].map((n) => z.literal(n)))),
      globalRateLimit: int(10, 2_000_000_000),
      shareBlockRateLimit: int(10, 2_000_000_000),
      shareCaptchaRateLimit: int(10, 2_000_000_000),
      /** Face search and face deletion together, per IP: the same limits as the API. */
      faceSearchBlockRateLimit: int(10, 2_000_000_000),
      faceSearchCaptchaRateLimit: int(10, 2_000_000_000),
      /** POST /api/s/:token/unlock per IP (password guessing across shares). */
      unlockBlockRateLimit: int(10, 2_000_000_000),
      /** POST /api/s/:token/downloads per IP (signed download URLs and zip jobs). */
      downloadsBlockRateLimit: int(10, 2_000_000_000),
      captchaImmunitySeconds: int(60, 259_200),
      /** Path prefixes of the public share page and its API. */
      sharePathPrefixes: z.array(lowercasePath).min(1),
      /**
       * Public share API routes are POST <shareApiPathPrefix><token><suffix>[/]. Face search and
       * face deletion take selfie uploads and share the face-search rules.
       */
      shareApiPathPrefix: lowercasePath,
      faceSearchPathSuffix: lowercasePath,
      faceDeletionPathSuffix: lowercasePath,
      unlockPathSuffix: lowercasePath,
      downloadsPathSuffix: lowercasePath,
      /**
       * How much of a request body CloudFront forwards to WAF for inspection. KB_16 is included in
       * the WAF price; each larger step is billed per request.
       */
      bodyInspectionLimit: z.enum(['KB_16', 'KB_32', 'KB_48', 'KB_64']),
      /** Size budget of a face-search upload (see faceSearchBodyLimits in lib/face-limits.ts). */
      faceSearchBody: z.object({
        jpegBytesPerPixel: z.coerce.number().positive().max(8),
        multipartOverheadBytes: int(0, 1_048_576),
      }),
      /** AWSManagedRulesCommonRuleSet rules switched to Count (e.g. body size for uploads). */
      commonRuleSetCountOverrides: z.array(nonEmpty),
      /**
       * POST /api/billing/webhooks/<PAYMENT_GATEWAY> per IP. Generous: a gateway retries and sends
       * bursts from a few addresses. The route skips CAPTCHA and the body-inspecting managed rules
       * (signatures are computed over the raw body).
       */
      webhookRateLimit: int(10, 2_000_000_000),
      /**
       * The gateway's published webhook source ranges. Empty (the default) accepts any IP: the API
       * verifies every webhook signature anyway.
       */
      webhookAllowedIpv4Cidrs: z.array(cidr),
      adminRateLimit: int(10, 2_000_000_000),
      /** Empty allows any IP (MFA still applies); otherwise only these IPv4 CIDRs reach admin. */
      adminAllowedIpv4Cidrs: z.array(cidr),
      logRetentionDays: logRetention,
    }),

    auth: z.object({
      domainPrefix: str.pipe(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
      adminDomainPrefix: str.pipe(z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/)),
      callbackPath: str.pipe(z.string().startsWith('/')),
      logoutPath: str.pipe(z.string().startsWith('/')),
      adminCallbackPath: str.pipe(z.string().startsWith('/')),
      adminLogoutPath: str.pipe(z.string().startsWith('/')),
      /** Extra callback/logout URLs, e.g. http://localhost:3000/... for a dev pool. */
      extraCallbackUrls: z.array(z.url()),
      extraLogoutUrls: z.array(z.url()),
      passwordMinLength: int(8, 99),
      adminPasswordMinLength: int(12, 99),
      accessTokenMinutes: int(5, 1440),
      idTokenMinutes: int(5, 1440),
      refreshTokenDays: int(1, 3650),
      adminRefreshTokenHours: int(1, 87_600),
      deletionProtection: bool,
      google: z.object({ clientId: nonEmpty, clientSecretName: nonEmpty }),
      line: z.object({
        channelId: nonEmpty,
        channelSecretName: nonEmpty,
        issuerUrl: z.url(),
        scopes: z.array(nonEmpty).min(1),
      }),
    }),

    secrets: z.object({
      /** Secrets Manager secret holding the CloudFront signing private key (PEM). */
      cloudFrontSigningPrivateKeyName: nonEmpty,
      /** Length of the generated IP_HASH_SECRET (api; HMAC key of consents.ip_hash). */
      ipHashSecretLength: int(32, 4096),
    }),

    /** Feature flags passed to api and worker. */
    features: z.object({
      /** FACE_SEARCH_ENABLED. Stays false until a real-event Phase 0 evaluation passes. */
      faceSearchEnabled: bool,
    }),

    consent: z.object({
      /** CONSENT_POLICY_VERSION (api): one of CONSENT_POLICY_VERSIONS in packages/shared. */
      policyVersion: z.enum(CONSENT_POLICY_VERSIONS),
    }),

    /** Payments (api: checkout and webhooks; worker: auto-renew charges). */
    billing: z.object({
      /**
       * PAYMENT_GATEWAY. `fake` (the default, for non-production stages) signs webhooks with a
       * generated secret; the `prod` stage must name a real gateway.
       */
      paymentGateway: z.enum(PAYMENT_GATEWAYS).default('fake'),
      /**
       * Secrets Manager secret (ap-southeast-1) the operator creates before deploy: a JSON object
       * with one key per PAYMENT_GATEWAY_SECRET_ENV[paymentGateway] name, e.g.
       * {"PAYMENT_OMISE_PUBLIC_KEY": "...", "PAYMENT_OMISE_SECRET_KEY": "...", ...}. Ignored for
       * `fake`, whose webhook secret infra generates.
       */
      gatewaySecretName: str.default(''),
      /** Length of the generated PAYMENT_FAKE_WEBHOOK_SECRET (fake gateway only). */
      fakeWebhookSecretLength: int(16, 4096),
    }),

    /** Transactional email (api and worker): reminders, receipts, grace and purge notices. */
    email: z.object({
      /** EMAIL_PROVIDER. `fake` (the default, for non-production stages); `prod` must use `ses`. */
      provider: z.enum(EMAIL_PROVIDERS).default('fake'),
      /** EMAIL_FROM_ADDRESS. Infra creates an SES domain identity for its domain. */
      fromAddress: str,
      /** EMAIL_FROM_NAME. */
      fromName: str,
    }),

    rekognition: z.object({
      /** Must match faceCollectionId() in packages/face (`pg-{photographerId}`). */
      collectionPrefix: str.pipe(z.string().regex(/^[a-zA-Z0-9_.-]+$/)),
    }),

    schedules: z.object({
      timezone: nonEmpty,
      retryAttempts: int(0, 185),
      maxEventAgeSeconds: int(60, 86_400),
      jobs: z.object(
        Object.fromEntries(SCHEDULED_JOB_TYPES.map((t) => [t, scheduleSchema])) as Record<
          (typeof SCHEDULED_JOB_TYPES)[number],
          typeof scheduleSchema
        >,
      ),
    }),
  })
  .superRefine((c, ctx) => {
    for (const name of ['web', 'admin', 'api', 'worker'] as const) {
      const s = c.services[name];
      if (s.minCapacity > s.maxCapacity) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', name],
          message: 'minCapacity > maxCapacity',
        });
      }
    }
    if (c.database.maxAllocatedStorageGiB < c.database.allocatedStorageGiB) {
      ctx.addIssue({
        code: 'custom',
        path: ['database', 'maxAllocatedStorageGiB'],
        message: 'must be >= allocatedStorageGiB',
      });
    }
    const m = c.cdn.media;
    if (!(m.minTtlSeconds <= m.defaultTtlSeconds && m.defaultTtlSeconds <= m.maxTtlSeconds)) {
      ctx.addIssue({
        code: 'custom',
        path: ['cdn', 'media'],
        message: 'need minTtl <= defaultTtl <= maxTtl',
      });
    }
    if (c.waf.shareCaptchaRateLimit > c.waf.shareBlockRateLimit) {
      ctx.addIssue({
        code: 'custom',
        path: ['waf'],
        message: 'shareCaptchaRateLimit must be <= shareBlockRateLimit',
      });
    }
    if (c.waf.faceSearchCaptchaRateLimit > c.waf.faceSearchBlockRateLimit) {
      ctx.addIssue({
        code: 'custom',
        path: ['waf'],
        message: 'faceSearchCaptchaRateLimit must be <= faceSearchBlockRateLimit',
      });
    }
    if ((c.domain.hostedZoneId === '') !== (c.domain.hostedZoneName === '')) {
      ctx.addIssue({
        code: 'custom',
        path: ['domain'],
        message: 'set both hostedZoneId and hostedZoneName, or neither',
      });
    }
    if (
      c.domain.hostedZoneId === '' &&
      (c.domain.certificateArn === '' || c.domain.adminCertificateArn === '')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['domain'],
        message: 'without a Route 53 hosted zone, provide certificateArn and adminCertificateArn',
      });
    }
    const headers = c.cdn.media.responseHeaders;
    if (
      /(^|;)\s*media-src\b/.test(headers.contentSecurityPolicy) &&
      !headers.corsAllowOrigins.includes('*')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cdn', 'media', 'responseHeaders', 'corsAllowOrigins'],
        message:
          'must include "*" when the CSP allows media-src: the sandboxed media document has an ' +
          'opaque origin and fetches the video in CORS mode',
      });
    }
    if (
      headers.hstsPreload &&
      !(headers.hstsIncludeSubdomains && headers.hstsMaxAgeSeconds >= 31_536_000)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['cdn', 'media', 'responseHeaders'],
        message: 'hstsPreload needs hstsIncludeSubdomains and hstsMaxAgeSeconds >= 31536000',
      });
    }

    // FACE_* values are parsed exactly as api and worker parse them at runtime.
    const faceConfig = (service: 'api' | 'worker'): FaceConfig | undefined => {
      try {
        return serviceFaceConfig(c.services.env, service);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', 'env'],
          message: `${service}: ${error instanceof Error ? error.message : String(error)}`,
        });
        return undefined;
      }
    };
    const envIssue = (message: string) =>
      ctx.addIssue({ code: 'custom', path: ['services', 'env'], message });
    const queueIssues = (q: QueueName, issues: ReturnType<typeof heartbeatQueueIssues>) => {
      for (const issue of issues) {
        ctx.addIssue({
          code: 'custom',
          path: ['queues', q, ...issue.path],
          message: issue.message,
        });
      }
    };
    const parsed = <T>(what: string, load: () => T): T | undefined => {
      try {
        return load();
      } catch (error) {
        envIssue(`${what}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };

    // Keys infra sets itself, and upload settings web and api must agree on.
    const groups = c.services.env;
    for (const [group, vars] of Object.entries(groups)) {
      for (const key of Object.keys(vars)) {
        if ((INFRA_OWNED_ENV as readonly string[]).includes(key)) {
          envIssue(
            `${group}: ${key} is set by infra (runtime, features, consent, billing, email, secrets, buckets, queues, schedules) or doesn't apply to AWS stacks (local development, ADR 0008 VPS settings)`,
          );
        }
        if (group !== 'common' && readsUploadKey(key)) {
          envIssue(
            `${group}: ${key} must be in services.env.common so web and api use the same value`,
          );
        }
      }
    }

    const worker = parsed('worker', () => serviceWorkerSettings(groups));
    const shares = (['api', 'worker'] as const).map((service) =>
      parsed(service, () => serviceShareConfig(groups, service)),
    );
    if (worker !== undefined) {
      const stop = workerStopTimeoutIssue(worker, c.services.worker.stopTimeoutMarginSeconds);
      if (stop !== undefined) {
        ctx.addIssue({ code: 'custom', path: ['services', 'worker'], message: stop });
      }
      // Media and jobs have no modelled worst case: their caps only have to fit SQS and the
      // retention period.
      for (const q of ['media', 'jobs'] as const) {
        queueIssues(q, heartbeatQueueIssues(c.queues[q], 0, q, capSeconds(worker, q)));
      }
      const workerShare = shares[1];
      if (workerShare !== undefined) {
        const zipWorst = zipJobWorstCaseSeconds(workerShare, c.queues.zip.jobBudget);
        const describeZip =
          `one zip job streams up to ZIP_MAX_BYTES (${workerShare.zip.maxBytes}) at ` +
          `${c.queues.zip.jobBudget.minThroughputBytesPerSecond} B/s plus ` +
          `${c.queues.zip.jobBudget.processingSeconds}s of processing`;
        queueIssues(
          'zip',
          heartbeatQueueIssues(c.queues.zip, zipWorst, describeZip, capSeconds(worker, 'zip')),
        );
        if (capSeconds(worker, 'zip') < zipWorst) {
          envIssue(
            `worker: WORKER_ZIP_MAX_PROCESSING_SECONDS (${capSeconds(worker, 'zip')}) must be >= ` +
              `the zip worst case of ${zipWorst}s (${describeZip}), or healthy zips are cut off`,
          );
        }
      }
      if (shares.every((s) => s !== undefined)) {
        const lifetime = zipObjectLifetime(worker, shares);
        const minDays = minZipExpirationDays(lifetime);
        if (c.storage.tmpZipsExpirationDays < minDays) {
          ctx.addIssue({
            code: 'custom',
            path: ['storage', 'tmpZipsExpirationDays'],
            message:
              `must be >= ${minDays} days: a zip may still be downloaded at age ` +
              `${describeZipLifetime(lifetime)}`,
          });
        }
      }
    }
    const s = c.storage;
    const longestTmp = Math.max(
      s.tmpIndexExpirationDays,
      s.tmpZipsExpirationDays,
      s.tmpReconcileExpirationDays,
    );
    if (s.tmpOtherExpirationDays < longestTmp) {
      ctx.addIssue({
        code: 'custom',
        path: ['storage', 'tmpOtherExpirationDays'],
        message:
          `must be >= ${longestTmp} (the longest per-prefix tmp/ rule): S3 applies the ` +
          `shortest matching expiration`,
      });
    }

    const workerFace = faceConfig('worker');
    if (workerFace !== undefined) {
      const worst = facesJobWorstCase(workerFace, c.queues.faces.jobBudget);
      const facesCap = worker === undefined ? worst.seconds : capSeconds(worker, 'faces');
      queueIssues(
        'faces',
        heartbeatQueueIssues(
          c.queues.faces,
          worst.seconds,
          describeFacesWorstCase(worst),
          facesCap,
        ),
      );
      if (facesCap < worst.seconds) {
        envIssue(
          `worker: WORKER_FACES_MAX_PROCESSING_SECONDS (${facesCap}) must be >= the faces worst ` +
            `case of ${worst.seconds}s (${describeFacesWorstCase(worst)}), or healthy indexing ` +
            `attempts are cut off`,
        );
      }
      const minReconcile = minReconcileExpirationDays(workerFace.index.orphanGraceMs);
      if (c.storage.tmpReconcileExpirationDays < minReconcile) {
        ctx.addIssue({
          code: 'custom',
          path: ['storage', 'tmpReconcileExpirationDays'],
          message:
            `must be >= ${minReconcile} days: a reconciliation scan must survive ` +
            `FACE_ORPHAN_GRACE_MS (${workerFace.index.orphanGraceMs} ms) plus one daily run`,
        });
      }
      const minGrace = minOrphanGraceMs(worst);
      if (workerFace.index.orphanGraceMs < minGrace) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', 'env'],
          message:
            `worker: FACE_ORPHAN_GRACE_MS (${workerFace.index.orphanGraceMs}) must be >= ` +
            `${minGrace}, twice the longest faces attempt (${worst.seconds}s: ` +
            `${describeFacesWorstCase(worst)}); an attempt must commit its faces within half ` +
            `the grace or reconciliation may delete them`,
        });
      }
    }
    // The api's FACE_* values size the face-search body limit (WAF rule and api env).
    faceConfig('api');

    // Billing and email. The shared loaders refuse `fake` in production; so does synth for the
    // production stage.
    if (c.stage === PRODUCTION_STAGE) {
      if (c.billing.paymentGateway === 'fake') {
        ctx.addIssue({
          code: 'custom',
          path: ['billing', 'paymentGateway'],
          message: `must not be fake on the ${PRODUCTION_STAGE} stage`,
        });
      }
      if (c.email.provider === 'fake') {
        ctx.addIssue({
          code: 'custom',
          path: ['email', 'provider'],
          message: `must not be fake on the ${PRODUCTION_STAGE} stage`,
        });
      }
    }
    if (c.billing.paymentGateway !== 'fake' && !SECRET_NAME.test(c.billing.gatewaySecretName)) {
      ctx.addIssue({
        code: 'custom',
        path: ['billing', 'gatewaySecretName'],
        message:
          `must name the Secrets Manager secret holding ` +
          `${PAYMENT_GATEWAY_SECRET_ENV[c.billing.paymentGateway].join(', ')}`,
      });
    }
    // The address and name are parsed exactly as api and worker parse them.
    try {
      loadEmailConfig({
        EMAIL_PROVIDER: c.email.provider,
        EMAIL_FROM_ADDRESS: c.email.fromAddress,
        EMAIL_FROM_NAME: c.email.fromName,
      });
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (!EMAIL_AT_DNS_DOMAIN.test(c.email.fromAddress)) {
      ctx.addIssue({
        code: 'custom',
        path: ['email', 'fromAddress'],
        message: 'must be an address at a lowercase DNS domain (the SES identity)',
      });
    }
  });

export type PlatformConfig = z.output<typeof configSchema>;

/** The worker's per-message processing cap for a queue, in seconds. */
export function capSeconds(worker: WorkerSettings, q: QueueName): number {
  return worker.maxProcessingMs[q] / 1000;
}

/** True when loadUploadConfig reads `key` (an invalid value makes it throw). */
function readsUploadKey(key: string): boolean {
  try {
    loadUploadConfig({ [key]: '\u0000 not a valid value' });
    return false;
  } catch {
    return true;
  }
}

/** The webhook path of the configured gateway, e.g. `/api/billing/webhooks/omise`. */
export function webhookPath(config: PlatformConfig): string {
  return apiPath(BILLING_ROUTES.webhook, { gateway: config.billing.paymentGateway });
}

/** The SES domain identity: the domain of `email.fromAddress`. */
export function emailIdentityDomain(config: PlatformConfig): string {
  return config.email.fromAddress.slice(config.email.fromAddress.lastIndexOf('@') + 1);
}

/** The worker's WORKER_* settings for this configuration. */
export function workerSettings(config: PlatformConfig): WorkerSettings {
  return serviceWorkerSettings(config.services.env);
}

/** How long a zip object must outlive its creation for this configuration. */
export function zipLifetime(config: PlatformConfig): ZipObjectLifetime {
  return zipObjectLifetime(
    workerSettings(config),
    (['api', 'worker'] as const).map((s) => serviceShareConfig(config.services.env, s)),
  );
}

/** One-line explanation of the faces job worst case, used in validation errors. */
export function describeFacesWorstCase(w: FacesJobWorstCase): string {
  return (
    `one faces job makes up to ${w.totalCalls} Rekognition calls ` +
    `(${w.collectionCalls} collection + ${w.indexFacesCalls} IndexFaces + ` +
    `${w.deleteFacesCalls} DeleteFaces), each up to ${w.perCallSeconds}s with retries, ` +
    `rate-limit waits and request timeouts, plus ${w.processingSeconds}s of processing`
  );
}

/** The faces job worst case for this configuration (the worker's FACE_* values). */
export function facesQueueWorstCase(config: PlatformConfig): FacesJobWorstCase {
  return facesJobWorstCase(
    serviceFaceConfig(config.services.env, 'worker'),
    config.queues.faces.jobBudget,
  );
}

/** Face-search upload limits for this configuration (the api's FACE_* values). */
export function faceSearchLimits(config: PlatformConfig): FaceSearchBodyLimits {
  return faceSearchBodyLimits(
    serviceFaceConfig(config.services.env, 'api'),
    config.waf.faceSearchBody,
  );
}

/** Sets `value` at a dotted path inside a plain object, creating objects on the way. */
function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let node: Record<string, unknown> = target;
  for (const [i, key] of path.entries()) {
    if (i === path.length - 1) {
      node[key] = value;
      return;
    }
    const next = node[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
}

/**
 * Reads the `shotx` context object and applies `shotx:<dotted.path>` overrides, e.g.
 * `cdk synth -c shotx:services.imageTag=sha-abc123 -c shotx:account=123456789012`.
 * Override values that look like JSON arrays or objects are parsed as JSON.
 */
export function resolveRawConfig(
  getContext: (key: string) => unknown,
  contextKeys: string[],
): unknown {
  const base: unknown = getContext(CONTEXT_KEY);
  if (typeof base !== 'object' || base === null) {
    throw new Error(
      `Missing CDK context "${CONTEXT_KEY}". Run cdk from infra/ so cdk.json is picked up.`,
    );
  }
  const merged = structuredClone(base) as Record<string, unknown>;
  const prefix = `${CONTEXT_KEY}:`;
  for (const key of contextKeys.filter((k) => k.startsWith(prefix)).sort()) {
    const raw = getContext(key);
    const value =
      typeof raw === 'string' && /^\s*[[{]/.test(raw) ? (JSON.parse(raw) as unknown) : raw;
    setPath(merged, key.slice(prefix.length).split('.'), value);
  }
  return merged;
}

export function parseConfig(raw: unknown): PlatformConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid "${CONTEXT_KEY}" CDK context:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function loadConfig(app: App): PlatformConfig {
  const contextKeys = Object.keys(app.node.getAllContext() as Record<string, unknown>);
  return parseConfig(resolveRawConfig((k) => app.node.tryGetContext(k), contextKeys));
}
