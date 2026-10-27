import { z } from 'zod';
import { loadAwsConfig } from './aws';
import { type Env, parseEnv } from './env';
import { awsRegion, httpUrl, secret, SECONDS_PER_DAY } from './fields';
import { inRange, isPrivateHost, parseIp, parseRange } from './ip';
import { LOCAL_DEV_APP_STAGE } from './stage-gate';

// Object storage and media URLs (ADR 0008 sections 1 and 2).
//
// Invariant (ADR 0008 section 2, replacing "never hand out S3 URLs"): never hand out an unsigned
// or non-expiring media URL; the bucket is never public (no r2.dev URL, no custom domain, Block
// Public Access on AWS); file bytes never pass through the API. Media URLs are either CloudFront
// signed URLs (MEDIA_URL_SIGNER=cloudfront, until infra/ is removed) or SigV4 presigned GETs on
// the storage endpoint (`s3-presign`, R2 and local), and the API signs only keys it built
// (parseS3Key).
//
// Endpoints and credentials are explicit per client (ADR 0008 section 1): the api and worker
// pass storageS3ClientOptions() to their S3 clients, never relying on AWS_ENDPOINT_URL (which AWS
// SDK v3 applies to every client, so Rekognition would go to R2) or on the default credential
// chain, whenever STORAGE_ENDPOINT_URL is set. Without it, storage is AWS S3 exactly as before:
// AWS_REGION, AWS_ENDPOINT_URL (LocalStack only) and the default chain (the ECS task role).
//
// To verify against a real R2 bucket before launch (ADR 0008 "To verify against real R2"; keep
// this list and the ADR's in step):
// - `response-content-disposition` on presigned GETs (the fallback is Content-Disposition stored
//   at write time, which goes stale on rename);
// - presigned `UploadPart` from a browser with CORS, `ETag` exposed;
// - ListMultipartUploads / ListParts / AbortMultipartUpload;
// - lifecycle rules (abort-incomplete-multipart, per-prefix tmp/ expiry, about a day late);
// - DeleteObjects with the checksum the AWS SDK sends (with `requestChecksumCalculation:
//   'WHEN_REQUIRED'` DeleteObjects still needs one: CRC32 by default, not Content-MD5);
// - CORS responses carry `Vary: Origin`, so a cached response for one origin (or a no-CORS
//   request) is never served to another.

/** Storage classes the api may write originals with (STORAGE_ORIGINALS_CLASS). */
export const ORIGINALS_STORAGE_CLASSES = [
  'INTELLIGENT_TIERING',
  'STANDARD',
  'STANDARD_IA',
] as const;
export type OriginalsStorageClass = (typeof ORIGINALS_STORAGE_CLASSES)[number];

/** The storage classes Cloudflare R2 accepts (no INTELLIGENT_TIERING). */
export const R2_STORAGE_CLASSES = [
  'STANDARD',
  'STANDARD_IA',
] as const satisfies readonly OriginalsStorageClass[];

/** Region name R2 expects (`STORAGE_REGION=auto`). */
export const R2_REGION = 'auto';

/** Longest X-Amz-Expires of a SigV4 presigned URL (AWS S3 and R2): 7 days. */
export const S3_PRESIGN_MAX_EXPIRES_SECONDS = 7 * SECONDS_PER_DAY;

/** Host suffix of R2's S3 API endpoints (`<account-id>.r2.cloudflarestorage.com`, also `.eu.`). */
const R2_HOST_SUFFIX = '.r2.cloudflarestorage.com';

/** True for an R2 S3 API endpoint host. */
export function isR2Host(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(R2_HOST_SUFFIX);
}

/** Unspecified and carrier-grade NAT ranges, on top of isPrivateHost's. */
const NON_PUBLIC_EXTRA_RANGES = ['0.0.0.0/8', '100.64.0.0/10', '::/128'].map((text) => {
  const range = parseRange(text);
  if (range === null) throw new Error(`bad built-in range ${text}`);
  return range;
});

/** Name suffixes that public DNS never resolves (RFC 6762, RFC 8375, ICANN `.internal`). */
const NON_PUBLIC_SUFFIXES = ['.local', '.internal', '.home.arpa', '.lan'];

/**
 * True for a storage endpoint host that is not on the internet: loopback, private, link-local,
 * unspecified or CGNAT addresses, `localhost`, single-label names (compose services such as
 * `localstack` or `minio`) and `.local`/`.internal`/`.home.arpa`/`.lan` names. Signed URLs on such
 * a host can't work for browsers, so outside APP_STAGE=local the storage loaders refuse it.
 */
export function isNonPublicStorageHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (host === '') return true;
  if (isPrivateHost(host)) return true;
  const ip = parseIp(host);
  if (ip !== null) return NON_PUBLIC_EXTRA_RANGES.some((range) => inRange(ip, range));
  const name = host.replace(/\.$/, '');
  return NON_PUBLIC_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// --- Storage endpoint (api, worker; web reads only the endpoint, never the keys) ----------------

const storageRegion = () =>
  z.union([z.literal(R2_REGION), awsRegion()], {
    error: `must be ${R2_REGION} or an AWS region name`,
  });

const storageEndpointEnvSchema = z.object({
  APP_STAGE: z.string().optional(),
  /** S3 API endpoint origin, e.g. https://<account-id>.r2.cloudflarestorage.com. */
  STORAGE_ENDPOINT_URL: httpUrl().optional(),
  STORAGE_REGION: storageRegion().optional(),
});

const storageKeysEnvSchema = z.object({
  /** Storage access key id (an R2 API token's). */
  STORAGE_ACCESS_KEY_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/, { error: 'must be an access key id ([A-Za-z0-9_-], 1-128)' })
    .optional(),
  /** Secret: never log it. */
  STORAGE_SECRET_ACCESS_KEY: secret()
    .refine((v) => v.length <= 256 && !/\s/.test(v), {
      error: 'must be 1-256 characters without whitespace',
    })
    .optional(),
});

/** An explicit storage endpoint (STORAGE_ENDPOINT_URL), validated for the stage. */
interface ExplicitEndpoint {
  url: string;
  region: string;
}

/**
 * Reads STORAGE_ENDPOINT_URL and STORAGE_REGION. Returns null when the endpoint is unset (AWS S3
 * as before); STORAGE_REGION alone is an error. Outside APP_STAGE=local the endpoint must be https
 * on a public host. The stage check reads APP_STAGE only (not NODE_ENV), so production images can
 * run locally against LocalStack or MinIO; deployed stages never have APP_STAGE=local.
 */
function readExplicitEndpoint(env: Env, name: string): ExplicitEndpoint | null {
  const e = parseEnv(storageEndpointEnvSchema, env, name);
  if (e.STORAGE_ENDPOINT_URL === undefined) {
    if (e.STORAGE_REGION !== undefined) {
      throw new Error(`Invalid ${name} configuration: STORAGE_REGION needs STORAGE_ENDPOINT_URL`);
    }
    return null;
  }
  if (e.STORAGE_REGION === undefined) {
    throw new Error(
      `Invalid ${name} configuration: STORAGE_REGION is required with STORAGE_ENDPOINT_URL (${R2_REGION} for R2)`,
    );
  }
  if (e.APP_STAGE !== LOCAL_DEV_APP_STAGE) {
    const url = new URL(e.STORAGE_ENDPOINT_URL);
    if (isNonPublicStorageHost(url.hostname)) {
      throw new Error(
        `Invalid ${name} configuration: STORAGE_ENDPOINT_URL must not be a localhost, loopback or private host outside APP_STAGE=${LOCAL_DEV_APP_STAGE}`,
      );
    }
    if (url.protocol !== 'https:') {
      throw new Error(
        `Invalid ${name} configuration: STORAGE_ENDPOINT_URL must be https outside APP_STAGE=${LOCAL_DEV_APP_STAGE}`,
      );
    }
  }
  return { url: e.STORAGE_ENDPOINT_URL, region: e.STORAGE_REGION };
}

/** Access keys of the storage endpoint. Secret: never log it. */
export interface StorageCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY: both required with an explicit endpoint,
 * both refused without one (they would be silently ignored by the default chain).
 */
function readStorageKeys(
  env: Env,
  endpoint: ExplicitEndpoint | null,
  name: string,
): StorageCredentials | null {
  const e = parseEnv(storageKeysEnvSchema, env, name);
  if (endpoint === null) {
    if (e.STORAGE_ACCESS_KEY_ID !== undefined || e.STORAGE_SECRET_ACCESS_KEY !== undefined) {
      throw new Error(
        `Invalid ${name} configuration: STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY need STORAGE_ENDPOINT_URL`,
      );
    }
    return null;
  }
  if (e.STORAGE_ACCESS_KEY_ID === undefined || e.STORAGE_SECRET_ACCESS_KEY === undefined) {
    throw new Error(
      `Invalid ${name} configuration: STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY are required with STORAGE_ENDPOINT_URL`,
    );
  }
  return { accessKeyId: e.STORAGE_ACCESS_KEY_ID, secretAccessKey: e.STORAGE_SECRET_ACCESS_KEY };
}

/**
 * S3 bucket naming rules for general purpose buckets: 3–63 characters of lowercase letters,
 * digits, dots and hyphens, starting and ending with a letter or digit. (Dots are allowed by S3
 * but break virtual-hosted TLS; infra never uses them.) R2's rules are a subset.
 */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

const bucketName = () =>
  z
    .string()
    .regex(BUCKET_NAME, { error: 'must be a valid S3 bucket name' })
    .refine((name) => !name.includes('..'), { error: 'must be a valid S3 bucket name' });

const mediaStorageEnvSchema = z.object({
  MEDIA_BUCKET: bucketName(),
  /** LocalStack needs path-style requests. `true`/`false` (also 1/0, yes/no, on/off). */
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
  /**
   * Storage class of originals (CreateMultipartUpload). Today's default; R2 accepts only
   * STANDARD and STANDARD_IA, so set STANDARD there (the loader refuses INTELLIGENT_TIERING on an
   * R2 endpoint). Derivatives and tmp/ objects are always STANDARD (no StorageClass sent).
   */
  STORAGE_ORIGINALS_CLASS: z.enum(ORIGINALS_STORAGE_CLASSES).default('INTELLIGENT_TIERING'),
});

/** What the api and worker pass to their media S3 clients. */
export interface StorageClientConfig {
  /**
   * STORAGE_ENDPOINT_URL. Null when it is unset: AWS S3's regional endpoint, or AWS_ENDPOINT_URL
   * (LocalStack) as before; then `credentials` is null too.
   */
  endpointUrl: string | null;
  /** STORAGE_REGION with an explicit endpoint (`auto` for R2), else AWS_REGION. */
  region: string;
  /**
   * STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY: always set with STORAGE_ENDPOINT_URL. Null:
   * the AWS SDK default credential chain (ECS task role), only on the AWS path. Secret.
   */
  credentials: StorageCredentials | null;
  /** S3_FORCE_PATH_STYLE. */
  forcePathStyle: boolean;
  /** True when STORAGE_ENDPOINT_URL is set (R2, MinIO, LocalStack through STORAGE_*). */
  explicit: boolean;
}

export interface MediaStorageConfig {
  /** The private media bucket: originals/, derived/ and tmp/ (see s3-keys). */
  bucket: string;
  /** S3_FORCE_PATH_STYLE (same as client.forcePathStyle; kept for existing callers). */
  forcePathStyle: boolean;
  /** Endpoint, region and credentials of the S3 client. Contains secrets: never log it. */
  client: StorageClientConfig;
  /** STORAGE_ORIGINALS_CLASS: the StorageClass of CreateMultipartUpload for originals. */
  originalsStorageClass: OriginalsStorageClass;
}

function storageClientConfig(env: Env, forcePathStyle: boolean, name: string): StorageClientConfig {
  const endpoint = readExplicitEndpoint(env, name);
  const credentials = readStorageKeys(env, endpoint, name);
  if (endpoint === null) {
    const aws = loadAwsConfig(env);
    return {
      endpointUrl: aws.endpointUrl,
      region: aws.region,
      credentials: null,
      forcePathStyle,
      explicit: false,
    };
  }
  return {
    endpointUrl: endpoint.url,
    region: endpoint.region,
    credentials,
    forcePathStyle,
    explicit: true,
  };
}

/**
 * Reads the media storage settings (api and worker): MEDIA_BUCKET (required), S3_FORCE_PATH_STYLE
 * (default false), STORAGE_ORIGINALS_CLASS (default INTELLIGENT_TIERING) and the client:
 * - STORAGE_ENDPOINT_URL set: STORAGE_REGION, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY
 *   are required; outside APP_STAGE=local the endpoint must be https on a public host; on an R2
 *   endpoint STORAGE_ORIGINALS_CLASS must be STANDARD or STANDARD_IA;
 * - unset (AWS stacks): AWS_REGION and AWS_ENDPOINT_URL as before, the default credential chain;
 *   STORAGE_REGION and the STORAGE keys are refused.
 */
export function loadMediaStorageConfig(env: Env): MediaStorageConfig {
  const name = 'media storage';
  const e = parseEnv(mediaStorageEnvSchema, env, name);
  const client = storageClientConfig(env, e.S3_FORCE_PATH_STYLE, name);
  if (
    client.endpointUrl !== null &&
    client.explicit &&
    isR2Host(new URL(client.endpointUrl).hostname) &&
    !(R2_STORAGE_CLASSES as readonly string[]).includes(e.STORAGE_ORIGINALS_CLASS)
  ) {
    throw new Error(
      `Invalid ${name} configuration: STORAGE_ORIGINALS_CLASS must be ${R2_STORAGE_CLASSES.join(' or ')} on R2`,
    );
  }
  return {
    bucket: e.MEDIA_BUCKET,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    client,
    originalsStorageClass: e.STORAGE_ORIGINALS_CLASS,
  };
}

/** Plain options shaped like the AWS SDK's S3ClientConfig (shared does not depend on the SDK). */
export interface StorageS3ClientOptions {
  region: string;
  endpoint?: string;
  credentials?: StorageCredentials;
  forcePathStyle: boolean;
  requestChecksumCalculation: 'WHEN_REQUIRED';
  responseChecksumValidation: 'WHEN_REQUIRED';
}

/**
 * Options for `new S3Client(...)` of the media bucket (api and worker). With an explicit endpoint
 * both `endpoint` and `credentials` are set, so neither AWS_ENDPOINT_URL nor the default chain is
 * consulted. Checksums only when required: SDK defaults put `x-amz-checksum-*` into presigned part
 * URLs (browsers' PUTs then fail) and add CRC32 headers that S3-compatible stores may reject.
 * Contains the secret key: never log the result.
 */
export function storageS3ClientOptions(
  config: Pick<MediaStorageConfig, 'client'>,
): StorageS3ClientOptions {
  const { client } = config;
  return {
    region: client.region,
    ...(client.endpointUrl === null ? {} : { endpoint: client.endpointUrl }),
    ...(client.credentials === null ? {} : { credentials: { ...client.credentials } }),
    forcePathStyle: client.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

// --- Media URLs (api) ---------------------------------------------------------------------------

/**
 * `cloudfront`: CloudFront signed URLs under `/media` on the site (AWS stacks, until infra/ is
 * removed). `s3-presign`: SigV4 presigned GET URLs, path-style on STORAGE_ENDPOINT_URL (R2 on the
 * VPS, LocalStack locally), signed with the STORAGE_* keys.
 *
 * Signed URL rules for both (share config): expiries are rounded up to a multiple of
 * SIGNED_URL_EXPIRY_BUCKET_SECONDS; `s3-presign` also rounds its signing date (X-Amz-Date) down
 * to a multiple of it, so one key in one window gives byte-identical URLs and browsers get cache
 * hits. X-Amz-Expires is capped at S3_PRESIGN_MAX_EXPIRES_SECONDS (7 days, the R2 and S3 limit).
 */
export const MEDIA_URL_SIGNER_NAMES = ['cloudfront', 's3-presign'] as const;
export type MediaUrlSignerName = (typeof MEDIA_URL_SIGNER_NAMES)[number];

const mediaUrlSignerEnvSchema = z.object({
  MEDIA_URL_SIGNER: z.enum(MEDIA_URL_SIGNER_NAMES).default('cloudfront'),
  /**
   * Optional keys used only to sign GET URLs: an R2 API token with Object Read only on the media
   * bucket, so a leaked signing key can't write or delete. Both or neither; unset falls back to
   * STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY. A presigned URL embeds its access key id.
   */
  STORAGE_SIGNING_ACCESS_KEY_ID: storageKeysEnvSchema.shape.STORAGE_ACCESS_KEY_ID,
  /** Secret: never log it. */
  STORAGE_SIGNING_SECRET_ACCESS_KEY: storageKeysEnvSchema.shape.STORAGE_SECRET_ACCESS_KEY,
});

export type MediaUrlSignerConfig =
  | { signer: 'cloudfront' }
  | {
      signer: 's3-presign';
      /** STORAGE_ENDPOINT_URL (an origin); URLs are path-style: `<endpoint>/<bucket>/<key>`. */
      endpointUrl: string;
      /** STORAGE_REGION (`auto` for R2): the SigV4 credential scope's region. */
      region: string;
      /** STORAGE_SIGNING_ACCESS_KEY_ID when set, else STORAGE_ACCESS_KEY_ID. */
      accessKeyId: string;
      /** STORAGE_SIGNING_SECRET_ACCESS_KEY when set, else STORAGE_SECRET_ACCESS_KEY. Secret. */
      secretAccessKey: string;
      /** Which pair signs: `signing` (the read-only token) or `storage` (the api's own keys). */
      keySource: 'signing' | 'storage';
    };

const SIGNER_NAME = 'media URL signer';

/**
 * Reads MEDIA_URL_SIGNER (default `cloudfront`). `s3-presign` is allowed on every stage and needs
 * STORAGE_ENDPOINT_URL, STORAGE_REGION and keys: STORAGE_SIGNING_ACCESS_KEY_ID /
 * STORAGE_SIGNING_SECRET_ACCESS_KEY (a read-only token) when set, else STORAGE_ACCESS_KEY_ID /
 * STORAGE_SECRET_ACCESS_KEY (never AWS_ACCESS_KEY_ID: presigning with the AWS default chain would
 * hand out S3 URLs). Outside APP_STAGE=local the endpoint must be https on a public host. The
 * signing keys are refused with `cloudfront` (they would be silently unused).
 */
export function loadMediaUrlSignerConfig(env: Env): MediaUrlSignerConfig {
  const e = parseEnv(mediaUrlSignerEnvSchema, env, SIGNER_NAME);
  const signingId = e.STORAGE_SIGNING_ACCESS_KEY_ID;
  const signingSecret = e.STORAGE_SIGNING_SECRET_ACCESS_KEY;
  if ((signingId === undefined) !== (signingSecret === undefined)) {
    throw new Error(
      `Invalid ${SIGNER_NAME} configuration: set both STORAGE_SIGNING_ACCESS_KEY_ID and STORAGE_SIGNING_SECRET_ACCESS_KEY, or neither`,
    );
  }
  if (e.MEDIA_URL_SIGNER === 'cloudfront') {
    if (signingId !== undefined) {
      throw new Error(
        `Invalid ${SIGNER_NAME} configuration: STORAGE_SIGNING_ACCESS_KEY_ID needs MEDIA_URL_SIGNER=s3-presign`,
      );
    }
    return { signer: 'cloudfront' };
  }
  const endpoint = requirePresignEndpoint(env);
  if (signingId !== undefined && signingSecret !== undefined) {
    return {
      signer: 's3-presign',
      endpointUrl: endpoint.url,
      region: endpoint.region,
      accessKeyId: signingId,
      secretAccessKey: signingSecret,
      keySource: 'signing',
    };
  }
  const keys = readStorageKeys(env, endpoint, SIGNER_NAME);
  if (keys === null)
    throw new Error(`Invalid ${SIGNER_NAME} configuration: storage keys are missing`);
  return {
    signer: 's3-presign',
    endpointUrl: endpoint.url,
    region: endpoint.region,
    accessKeyId: keys.accessKeyId,
    secretAccessKey: keys.secretAccessKey,
    keySource: 'storage',
  };
}

function requirePresignEndpoint(env: Env): ExplicitEndpoint {
  const endpoint = readExplicitEndpoint(env, SIGNER_NAME);
  if (endpoint === null) {
    throw new Error(
      `Invalid ${SIGNER_NAME} configuration: MEDIA_URL_SIGNER=s3-presign needs STORAGE_ENDPOINT_URL (and STORAGE_REGION and keys)`,
    );
  }
  return endpoint;
}

/**
 * The browser-facing origin of signed media URLs besides the site, or null for `cloudfront`
 * (same-origin `/media`). For `s3-presign` it is the storage endpoint's origin (URLs are
 * path-style), which the CSP lists in `img-src`, `media-src` and `connect-src` (navigator.share
 * fetches downloads).
 */
export function mediaUrlOrigin(config: MediaUrlSignerConfig): string | null {
  return config.signer === 's3-presign' ? new URL(config.endpointUrl).origin : null;
}

// --- Browser origins (web CSP) ------------------------------------------------------------------

const browserOriginsEnvSchema = z.object({
  MEDIA_URL_SIGNER: z.enum(MEDIA_URL_SIGNER_NAMES).default('cloudfront'),
  MEDIA_BUCKET: bucketName().optional(),
  S3_FORCE_PATH_STYLE: z.stringbool().default(false),
});

export interface MediaBrowserOrigins {
  /** Origins the browser PUTs upload parts to (CSP `connect-src`). */
  upload: string[];
  /** Origins of signed media URLs (CSP `img-src`, `media-src`, `connect-src`); empty for cloudfront. */
  media: string[];
}

/**
 * The storage origins a browser talks to, from settings web has (no storage keys needed):
 * MEDIA_URL_SIGNER, STORAGE_ENDPOINT_URL (+ STORAGE_REGION), MEDIA_BUCKET (optional),
 * S3_FORCE_PATH_STYLE, AWS_REGION and AWS_ENDPOINT_URL. Same stage rules as the api's loaders.
 *
 * - upload, explicit endpoint: the endpoint origin when path-style, else `<bucket>.<host>` (or
 *   `*.<host>` without MEDIA_BUCKET). AWS path (as before): `<bucket>.s3.<region>.amazonaws.com`
 *   (or `*.s3.<region>.amazonaws.com`), plus AWS_ENDPOINT_URL's origin when set (LocalStack).
 * - media: mediaUrlOrigin of the signer (`s3-presign` needs STORAGE_ENDPOINT_URL).
 */
export function loadMediaBrowserOrigins(env: Env): MediaBrowserOrigins {
  const name = 'media origins';
  const e = parseEnv(browserOriginsEnvSchema, env, name);
  const endpoint = readExplicitEndpoint(env, name);
  const upload: string[] = [];
  if (endpoint !== null) {
    const url = new URL(endpoint.url);
    if (e.S3_FORCE_PATH_STYLE) upload.push(url.origin);
    else upload.push(`${url.protocol}//${e.MEDIA_BUCKET ?? '*'}.${url.host}`);
  } else {
    const aws = loadAwsConfig(env);
    upload.push(`https://${e.MEDIA_BUCKET ?? '*'}.s3.${aws.region}.amazonaws.com`);
    if (aws.endpointUrl !== null) upload.push(new URL(aws.endpointUrl).origin);
  }
  let media: string[] = [];
  if (e.MEDIA_URL_SIGNER === 's3-presign') {
    if (endpoint === null) requirePresignEndpoint(env);
    else media = [new URL(endpoint.url).origin];
  }
  return { upload: [...new Set(upload)], media };
}
