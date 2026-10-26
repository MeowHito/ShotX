import {
  type FaceConfig,
  S3_PREFIXES,
  type ShareConfig,
  TMP_LIFECYCLE_MAX_DAYS,
  type WorkerSettings,
} from '@shotx/shared';
import { z } from 'zod';

// Pure rule building and ADR 0006 checks for the R2 media bucket (ADR 0008 section 2). No I/O:
// setup-bucket.ts reads the inputs and talks to the bucket.

// Not exported by packages/shared (infra/lib/worker-limits.ts defines them the same way).
const SECONDS_PER_DAY = 86_400;
const MS_PER_SECOND = 1000;

/**
 * tmp/reconcile/: the worker's reconciliation scan files. packages/shared has no constant for it
 * yet (ADR 0006); built from S3_PREFIXES.tmp exactly as infra's TMP_RECONCILE_PREFIX.
 */
export const TMP_RECONCILE_PREFIX = `${S3_PREFIXES.tmp}reconcile/`;

/**
 * The orphan-face reconciliation job runs once a day (`faces.reconcile.daily`); a scan written by
 * one run is acted on by a later one once FACE_ORPHAN_GRACE_MS has passed.
 */
export const RECONCILE_RUN_INTERVAL_SECONDS = SECONDS_PER_DAY;

/** Roughly how late R2 deletes objects after their lifecycle age (Cloudflare docs). */
export const R2_LIFECYCLE_DELAY_DAYS = 1;

/** Lifecycle rule ids, the same as the AWS bucket's in infra/ so the two read alike. */
export const RULE_IDS = {
  abortMultipart: 'abort-incomplete-multipart-uploads',
  tmpZips: 'expire-tmp-zips',
  tmpReconcile: 'expire-tmp-reconcile',
  tmpOther: 'expire-tmp-other',
} as const;

const days = (max: number) => z.number().int().min(1).max(max);

/**
 * The `storage` block of infra/cdk.json (`context.shotx.storage`), the single source of these
 * values while infra/ exists. Bounds as in infra/lib/config.ts. tmpIndexExpirationDays and
 * originalsIntelligentTieringAfterDays are AWS-only and ignored: the VPS has no tmp/index/ rule
 * (ADR 0008 section 5) and R2 has no Intelligent-Tiering.
 */
export const storageSettingsSchema = z.object({
  abortIncompleteMultipartUploadDays: days(7),
  tmpZipsExpirationDays: days(TMP_LIFECYCLE_MAX_DAYS),
  tmpReconcileExpirationDays: days(TMP_LIFECYCLE_MAX_DAYS),
  tmpOtherExpirationDays: days(TMP_LIFECYCLE_MAX_DAYS),
  uploadCorsMaxAgeSeconds: z.number().int().min(0).max(86_400),
});
export type StorageSettings = z.output<typeof storageSettingsSchema>;

/** Reads `context.shotx.storage` from the parsed infra/cdk.json. */
export function storageSettingsFromCdkJson(cdkJson: unknown): StorageSettings {
  const storage = z
    .object({ context: z.object({ shotx: z.object({ storage: z.unknown() }) }) })
    .parse(cdkJson).context.shotx.storage;
  const parsed = storageSettingsSchema.safeParse(storage);
  if (!parsed.success) {
    throw new Error(`Invalid cdk.json context.shotx.storage:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

// --- ADR 0006 checks ---------------------------------------------------------------------------

/** How long a finished zip may still be downloaded, measured from its upload's initiation. */
export interface ZipObjectLifetime {
  maxProcessingSeconds: number;
  resultTtlSeconds: number;
  downloadTtlSeconds: number;
  expiryBucketSeconds: number;
  seconds: number;
}

/**
 * WORKER_ZIP_MAX_PROCESSING_SECONDS (a multipart object is dated from its initiation) +
 * ZIP_RESULT_TTL_SECONDS + SIGNED_URL_DOWNLOAD_TTL_SECONDS + SIGNED_URL_EXPIRY_BUCKET_SECONDS,
 * each the largest of the given share configs (api and worker, when their env differs).
 */
export function zipObjectLifetime(
  worker: Pick<WorkerSettings, 'maxProcessingMs'>,
  shares: readonly Pick<
    ShareConfig,
    'zip' | 'signedUrlTtlSeconds' | 'signedUrlExpiryBucketSeconds'
  >[],
): ZipObjectLifetime {
  if (shares.length === 0) throw new RangeError('at least one share config is needed');
  const max = (pick: (s: (typeof shares)[number]) => number) => Math.max(...shares.map(pick));
  const maxProcessingSeconds = worker.maxProcessingMs.zip / MS_PER_SECOND;
  const resultTtlSeconds = max((s) => s.zip.resultTtlSeconds);
  const downloadTtlSeconds = max((s) => s.signedUrlTtlSeconds.download);
  const expiryBucketSeconds = max((s) => s.signedUrlExpiryBucketSeconds);
  return {
    maxProcessingSeconds,
    resultTtlSeconds,
    downloadTtlSeconds,
    expiryBucketSeconds,
    seconds: maxProcessingSeconds + resultTtlSeconds + downloadTtlSeconds + expiryBucketSeconds,
  };
}

/** Smallest tmpZipsExpirationDays that keeps every downloadable zip. */
export function minZipExpirationDays(lifetime: ZipObjectLifetime): number {
  return Math.ceil(lifetime.seconds / SECONDS_PER_DAY);
}

/** Smallest tmpReconcileExpirationDays: one orphan grace plus one daily run. */
export function minReconcileExpirationDays(orphanGraceMs: number): number {
  return Math.ceil(
    (orphanGraceMs / MS_PER_SECOND + RECONCILE_RUN_INTERVAL_SECONDS) / SECONDS_PER_DAY,
  );
}

/** The runtime settings the checks need, read with the shared loaders from the VPS env. */
export interface RuntimeSettings {
  worker: Pick<WorkerSettings, 'maxProcessingMs'>;
  shares: readonly Pick<
    ShareConfig,
    'zip' | 'signedUrlTtlSeconds' | 'signedUrlExpiryBucketSeconds'
  >[];
  face: { index: Pick<FaceConfig['index'], 'orphanGraceMs'> };
}

/**
 * ADR 0006's checks, which infra runs at CDK synth for the AWS bucket. Returns one message per
 * problem; empty when the rules are safe to apply.
 */
export function lifecycleIssues(storage: StorageSettings, runtime: RuntimeSettings): string[] {
  const issues: string[] = [];
  const lifetime = zipObjectLifetime(runtime.worker, runtime.shares);
  const minZips = minZipExpirationDays(lifetime);
  if (storage.tmpZipsExpirationDays < minZips) {
    issues.push(
      `storage.tmpZipsExpirationDays (${storage.tmpZipsExpirationDays}) must be >= ${minZips}: ` +
        `a zip may still be downloaded at age WORKER_ZIP_MAX_PROCESSING_SECONDS ` +
        `${lifetime.maxProcessingSeconds}s + ZIP_RESULT_TTL_SECONDS ${lifetime.resultTtlSeconds}s ` +
        `+ SIGNED_URL_DOWNLOAD_TTL_SECONDS ${lifetime.downloadTtlSeconds}s + ` +
        `SIGNED_URL_EXPIRY_BUCKET_SECONDS ${lifetime.expiryBucketSeconds}s = ${lifetime.seconds}s`,
    );
  }
  const graceMs = runtime.face.index.orphanGraceMs;
  const minReconcile = minReconcileExpirationDays(graceMs);
  if (storage.tmpReconcileExpirationDays < minReconcile) {
    issues.push(
      `storage.tmpReconcileExpirationDays (${storage.tmpReconcileExpirationDays}) must be >= ` +
        `${minReconcile}: a reconciliation scan must survive FACE_ORPHAN_GRACE_MS (${graceMs} ms) ` +
        `plus one daily run`,
    );
  }
  const longest = Math.max(storage.tmpZipsExpirationDays, storage.tmpReconcileExpirationDays);
  if (storage.tmpOtherExpirationDays < longest) {
    issues.push(
      `storage.tmpOtherExpirationDays (${storage.tmpOtherExpirationDays}) must be >= ${longest} ` +
        `(the longest per-prefix tmp/ rule): the shortest matching expiration applies`,
    );
  }
  return issues;
}

// --- Rules -------------------------------------------------------------------------------------

/** S3 API shapes (the subset PutBucketCors / PutBucketLifecycleConfiguration take). */
export interface CorsRule {
  ID: string;
  AllowedOrigins: string[];
  AllowedMethods: string[];
  AllowedHeaders?: string[];
  ExposeHeaders?: string[];
  MaxAgeSeconds: number;
}

export interface LifecycleRule {
  ID: string;
  Status: 'Enabled';
  Filter: { Prefix: string };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation: number };
  Expiration?: { Days: number };
}

/**
 * The main origin of PUBLIC_BASE_URL (scheme, host and port; no path). Throws for anything that
 * is not an http(s) URL; the shared loader has already required https outside local hosts.
 */
export function mainOrigin(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`PUBLIC_BASE_URL must be an http(s) URL, got ${url.protocol}`);
  }
  return url.origin;
}

/**
 * CORS for the main origin only (ADR 0008 section 2):
 * - PUT: browser multipart upload with presigned part URLs. The browser sends the part's
 *   Content-Type (not CORS-safelisted for media types), and Uppy reads each part's ETag.
 * - GET/HEAD: `navigator.share({ files })` fetches signed downloads. Simple requests without
 *   credentials, so no headers to allow.
 * Never a wildcard origin and never credentials.
 */
export function buildCorsRules(origin: string, maxAgeSeconds: number): CorsRule[] {
  if (origin === '*' || origin === 'null' || origin.endsWith('/')) {
    throw new Error(`CORS origin must be one exact origin, got ${origin}`);
  }
  return [
    {
      ID: 'upload-parts',
      AllowedOrigins: [origin],
      AllowedMethods: ['PUT'],
      AllowedHeaders: ['content-type'],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: maxAgeSeconds,
    },
    {
      ID: 'share-downloads',
      AllowedOrigins: [origin],
      AllowedMethods: ['GET', 'HEAD'],
      MaxAgeSeconds: maxAgeSeconds,
    },
  ];
}

/**
 * Abort incomplete multipart uploads on the whole bucket, and one expiration per tmp/ prefix
 * (ADR 0006). No tmp/index/ rule (ADR 0008 section 5: index images are no longer written; any
 * leftover falls under the tmp/ catch-all) and no storage-class transition (R2 has no
 * Intelligent-Tiering).
 */
export function buildLifecycleRules(storage: StorageSettings): LifecycleRule[] {
  const expire = (ID: string, Prefix: string, Days: number): LifecycleRule => ({
    ID,
    Status: 'Enabled',
    Filter: { Prefix },
    Expiration: { Days },
  });
  return [
    {
      ID: RULE_IDS.abortMultipart,
      Status: 'Enabled',
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: {
        DaysAfterInitiation: storage.abortIncompleteMultipartUploadDays,
      },
    },
    expire(RULE_IDS.tmpZips, S3_PREFIXES.tmpZips, storage.tmpZipsExpirationDays),
    expire(RULE_IDS.tmpReconcile, TMP_RECONCILE_PREFIX, storage.tmpReconcileExpirationDays),
    expire(RULE_IDS.tmpOther, S3_PREFIXES.tmp, storage.tmpOtherExpirationDays),
  ];
}

// --- Comparing with what the bucket has --------------------------------------------------------

const sortedLower = (values: readonly string[] | undefined) =>
  [...(values ?? [])].map((v) => v.toLowerCase()).sort();

/**
 * A canonical form of CORS rules for comparison: ids dropped (R2 may not return them), header
 * names and methods case-folded, lists sorted, rules sorted.
 */
export function canonicalCors(rules: readonly Partial<CorsRule>[]): string[] {
  return rules
    .map((r) =>
      JSON.stringify({
        origins: [...(r.AllowedOrigins ?? [])].sort(),
        methods: sortedLower(r.AllowedMethods),
        headers: sortedLower(r.AllowedHeaders),
        expose: sortedLower(r.ExposeHeaders),
        maxAge: r.MaxAgeSeconds ?? null,
      }),
    )
    .sort();
}

/** What a lifecycle rule read back from a bucket may look like (S3 and R2 differ slightly). */
export interface ReadLifecycleRule {
  ID?: string;
  Status?: string;
  Prefix?: string;
  Filter?: { Prefix?: string };
  AbortIncompleteMultipartUpload?: { DaysAfterInitiation?: number };
  Expiration?: { Days?: number };
  Transitions?: unknown[];
}

/** A canonical form of lifecycle rules: prefix, status and actions, sorted by prefix and action. */
export function canonicalLifecycle(rules: readonly ReadLifecycleRule[]): string[] {
  return rules
    .map((r) =>
      JSON.stringify({
        prefix: r.Filter?.Prefix ?? r.Prefix ?? '',
        status: r.Status ?? null,
        abort: r.AbortIncompleteMultipartUpload?.DaysAfterInitiation ?? null,
        expire: r.Expiration?.Days ?? null,
        transitions: (r.Transitions ?? []).length,
      }),
    )
    .sort();
}

export function sameCors(a: readonly Partial<CorsRule>[], b: readonly Partial<CorsRule>[]) {
  return JSON.stringify(canonicalCors(a)) === JSON.stringify(canonicalCors(b));
}

export function sameLifecycle(a: readonly ReadLifecycleRule[], b: readonly ReadLifecycleRule[]) {
  return JSON.stringify(canonicalLifecycle(a)) === JSON.stringify(canonicalLifecycle(b));
}

/** Human-readable lifetime of every tmp/ prefix on R2, including R2's deletion delay. */
export function describeLifecycle(storage: StorageSettings): string[] {
  const late = (d: number) =>
    `${d} day(s), deleted by R2 up to ~${R2_LIFECYCLE_DELAY_DAYS} day late`;
  return [
    `incomplete multipart uploads: aborted after ${storage.abortIncompleteMultipartUploadDays} day(s)`,
    `${S3_PREFIXES.tmpZips}: ${late(storage.tmpZipsExpirationDays)}`,
    `${TMP_RECONCILE_PREFIX}: ${late(storage.tmpReconcileExpirationDays)}`,
    `${S3_PREFIXES.tmp} (rest, including any leftover ${S3_PREFIXES.tmpIndex}): ${late(storage.tmpOtherExpirationDays)}`,
  ];
}
