import type { App } from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { z } from 'zod';
import {
  CONTEXT_KEY,
  FACE_DEFAULTS_FOR_VISIBILITY_CHECK,
  FACES_MIN_VISIBILITY_TIMEOUT_SECONDS,
  SCHEDULED_JOB_TYPES,
} from './constants';

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
  visibilityTimeoutSeconds: int(0, 43_200),
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
      faces: queueSchema,
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
      sharePathPrefixes: z.array(str.pipe(z.string().startsWith('/'))).min(1),
      /** Face search is POST <faceSearchPathPrefix><token><faceSearchPathSuffix>. */
      faceSearchPathPrefix: str.pipe(z.string().startsWith('/')),
      faceSearchPathSuffix: str.pipe(z.string().startsWith('/')),
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
    const visibility = c.queues.faces.visibilityTimeoutSeconds;
    const required = facesVisibilityFloorSeconds(c.services.env);
    if (visibility < required) {
      ctx.addIssue({
        code: 'custom',
        path: ['queues', 'faces', 'visibilityTimeoutSeconds'],
        message: `must be >= ${required}s: a faces job can wait (1 + FACE_TILE_GRID^2) x FACE_REKOGNITION_MAX_WAIT_MS for rate-limit tokens`,
      });
    }
  });

export type PlatformConfig = z.output<typeof configSchema>;

/**
 * Minimum visibility timeout for the faces queue: the worst-case Rekognition rate-limit wait for
 * one photo (full image plus FACE_TILE_GRID^2 tiles) plus 30 s of processing, and never below the
 * agreed 180 s floor.
 */
export function facesVisibilityFloorSeconds(env: PlatformConfig['services']['env']): number {
  const pick = (key: keyof typeof FACE_DEFAULTS_FOR_VISIBILITY_CHECK): number => {
    const raw = env.worker[key] ?? env.backend[key] ?? env.common[key];
    const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);
    return Number.isFinite(parsed) ? parsed : FACE_DEFAULTS_FOR_VISIBILITY_CHECK[key];
  };
  const grid = pick('FACE_TILE_GRID');
  const maxWaitSeconds = pick('FACE_REKOGNITION_MAX_WAIT_MS') / 1000;
  const processingMarginSeconds = 30;
  return Math.max(
    FACES_MIN_VISIBILITY_TIMEOUT_SECONDS,
    Math.ceil((1 + grid * grid) * maxWaitSeconds + processingMarginSeconds),
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
