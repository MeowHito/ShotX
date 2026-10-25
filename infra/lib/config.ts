import type { FaceConfig } from '@shotx/shared';
import type { App } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { z } from 'zod';
import { CONTEXT_KEY, SCHEDULED_JOB_TYPES, SQS_MAX_VISIBILITY_TIMEOUT_SECONDS } from './constants';
import {
  type FaceSearchBodyLimits,
  faceSearchBodyLimits,
  facesJobWorstCase,
  type FacesJobWorstCase,
  serviceFaceConfig,
} from './face-limits';

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
  queueDepthScaling: z.object({
    periodSeconds: int(60, 3600),
    cooldownSeconds: int(0, 3600),
    steps: z.array(scalingStepSchema).min(2),
  }),
});

const queueSchema = z.object({
  visibilityTimeoutSeconds: int(0, SQS_MAX_VISIBILITY_TIMEOUT_SECONDS),
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
 * The faces queue also carries the inputs of its visibility floor (see facesJobWorstCase in
 * lib/face-limits.ts). The rest of the worst case comes from the worker's FACE_* configuration.
 */
const facesQueueSchema = queueSchema.extend({
  visibilityFloor: z.object({
    /** Upper bound on one Rekognition request. The worker sets its SDK request timeout to this. */
    rekognitionCallTimeoutSeconds: int(1, 300),
    /** Collection calls a faces job may make before indexing (CreateCollection + Describe). */
    collectionCallsPerJob: int(0, 10),
    /** Non-Rekognition work for one photo: decode, tile encodes, S3 temp objects, DB writes. */
    processingSeconds: int(0, 3600),
  }),
});

const scheduleSchema = z.object({
  expression: str.pipe(
    z.string().regex(/^(cron|rate)\(.+\)$/, { error: 'must be cron(...) or rate(...)' }),
  ),
  enabled: bool,
});

export const configSchema = z
  .object({
    stage: str.pipe(z.string().regex(/^[a-z][a-z0-9-]{1,15}$/)),
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
      /** Redis ACL rules for that user, e.g. "on ~* &* +@all". */
      accessString: str.pipe(z.string().startsWith('on ', { error: 'must start with "on "' })),
    }),

    storage: z.object({
      abortIncompleteMultipartUploadDays: int(1, 7),
      tmpExpirationDays: int(1, 3),
      originalsIntelligentTieringAfterDays: int(0, 3650),
      uploadCorsMaxAgeSeconds: int(0, 86_400),
      cloudFrontLogExpirationDays: int(1, 3650),
    }),

    queues: z.object({
      media: queueSchema,
      faces: facesQueueSchema,
      zip: queueSchema,
      jobs: queueSchema,
    }),

    alarms: z.object({
      /** Optional email subscribed to the alarm topic. Empty means no subscription. */
      email: str.pipe(z.union([z.literal(''), z.email()])),
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
       * named groups to one service. Later groups win.
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
        /** Query strings forwarded to S3 and part of the cache key (S3 response overrides). */
        cacheQueryStrings: z.array(nonEmpty),
        /** S3 prefixes CloudFront may read. tmp/index/ must never be listed. */
        readablePrefixes: z
          .array(str.pipe(z.string().regex(/^[a-z0-9/_-]+\/$/)))
          .min(1)
          .refine((p) => !p.some((x) => 'tmp/index/'.startsWith(x)), {
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
              }),
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
      faceSearchBlockRateLimit: int(10, 2_000_000_000),
      faceSearchCaptchaRateLimit: int(10, 2_000_000_000),
      captchaImmunitySeconds: int(60, 259_200),
      /** Path prefixes of the public share page and its API. */
      sharePathPrefixes: z.array(lowercasePath).min(1),
      /** Face search is POST <faceSearchPathPrefix><token><faceSearchPathSuffix>[/]. */
      faceSearchPathPrefix: lowercasePath,
      faceSearchPathSuffix: lowercasePath,
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
    const workerFace = faceConfig('worker');
    if (workerFace !== undefined) {
      const worst = facesJobWorstCase(workerFace, c.queues.faces.visibilityFloor);
      if (c.queues.faces.visibilityTimeoutSeconds < worst.floorSeconds) {
        ctx.addIssue({
          code: 'custom',
          path: ['queues', 'faces', 'visibilityTimeoutSeconds'],
          message: `must be >= ${worst.floorSeconds}s: ${describeFacesWorstCase(worst)}`,
        });
      }
    }
    // The api's FACE_* values size the face-search body limit (WAF rule and api env).
    faceConfig('api');
  });

export type PlatformConfig = z.output<typeof configSchema>;

/** One-line explanation of the faces queue visibility floor, used in validation errors. */
export function describeFacesWorstCase(w: FacesJobWorstCase): string {
  return (
    `one faces job makes up to ${w.totalCalls} Rekognition calls ` +
    `(${w.collectionCalls} collection + ${w.indexFacesCalls} IndexFaces + ` +
    `${w.deleteFacesCalls} DeleteFaces), each up to ${w.perCallSeconds}s with retries and ` +
    `rate-limit waits, plus ${w.processingSeconds}s of processing`
  );
}

/** The faces queue worst case for this configuration (the worker's FACE_* values). */
export function facesQueueWorstCase(config: PlatformConfig): FacesJobWorstCase {
  return facesJobWorstCase(
    serviceFaceConfig(config.services.env, 'worker'),
    config.queues.faces.visibilityFloor,
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
