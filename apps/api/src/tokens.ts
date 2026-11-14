import type { AuthMethod, AuthPool, QUEUE_MESSAGE_SCHEMAS } from '@shotx/shared';
import type { z } from 'zod';
import type { ApiQueue } from './config';

// Injection tokens and the interfaces behind them. Production wires real clients in main.ts;
// tests pass fakes to createApiApp. Constructor parameters always use @Inject(TOKEN).

export const API_CONFIG = Symbol('API_CONFIG');
export const DATABASE = Symbol('DATABASE');
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const MEDIA_URL_SIGNER = Symbol('MEDIA_URL_SIGNER');
export const RATE_LIMITER = Symbol('RATE_LIMITER');
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const CLOCK = Symbol('CLOCK');
export const KEY_VALUE_STORE = Symbol('KEY_VALUE_STORE');
export const QUEUE_SENDER = Symbol('QUEUE_SENDER');
export const FACE_PROVIDER = Symbol('FACE_PROVIDER');
/** The app's LoggerService, for structured warnings (alerts infra turns into alarms). */
export const API_LOGGER = Symbol('API_LOGGER');
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');
/** Structured operational events (infra/events): JSON lines with a top-level `event`. */
export const EVENT_LOG = Symbol('EVENT_LOG');
export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');
/** ADR 0025: account emails (password-reset links); auth/account-email AccountMailer. */
export const ACCOUNT_MAILER = Symbol('ACCOUNT_MAILER');

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

/**
 * The S3 operations of the upload pipeline on the private media bucket. File bytes never pass
 * through the API: it creates, inspects, completes and aborts multipart uploads and presigns part
 * URLs the client PUTs to directly.
 */
export interface ObjectStorage {
  /** CreateMultipartUpload (Intelligent-Tiering); returns the UploadId. */
  createMultipartUpload(input: { key: string; contentType: string }): Promise<string>;
  /** A presigned UploadPart URL. */
  presignUploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<string>;
  /**
   * A presigned single PUT of `key` (design images, ADR 0013) whose signature covers Content-Type
   * and Content-Length, so the browser must send exactly `contentType` and `contentLength` bytes.
   */
  presignPutObject(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string>;
  /** Every part S3 has, ascending; null when the upload doesn't exist (NoSuchUpload). */
  listParts(input: { key: string; uploadId: string }): Promise<UploadedPart[] | null>;
  /** CompleteMultipartUpload; false when the upload doesn't exist (NoSuchUpload). */
  completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<boolean>;
  /** AbortMultipartUpload; a missing upload is not an error. */
  abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void>;
  /** HeadObject; null when the object doesn't exist. */
  headObject(key: string): Promise<{ size: number } | null>;
  /**
   * Counts the whole bucket with ListObjectsV2 (admin overview, ADR 0016), by top-level prefix.
   * Optional: storages that can't list leave it out, and the overview shows no bucket.
   */
  bucketUsage?(): Promise<BucketUsage>;
}

export interface BucketUsage {
  bucket: string;
  objectCount: number;
  totalBytes: number;
  prefixes: { prefix: string; objectCount: number; bytes: number }[];
}

/** CloudFront signed URLs for media keys. Never S3 URLs. */
export interface MediaUrlSigner {
  /**
   * A signed URL of `key` that expires at `expiresAt`. `contentDisposition` is added as the
   * `response-content-disposition` query parameter before signing (downloads). `cacheable` asks
   * the storage to answer with a private Cache-Control lasting as long as the URL (view URLs:
   * thumbnails and previews are immutable per key), where the signer supports it.
   */
  sign(
    key: string,
    expiresAt: Date,
    options?: { contentDisposition?: string; cacheable?: boolean },
  ): string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSeconds: number;
}

/** Fixed-window counters. Implementations fail closed: an error means not allowed. */
export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /**
   * Whether one more hit would still be allowed, without counting one: `allowed` while the
   * window's count is below `limit` (for limits that count failures only, e.g. admin sign-in).
   */
  peek(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
  /** Ends the window of `key` (e.g. after a completed admin sign-in). */
  reset(key: string): Promise<void>;
}

/**
 * A verified identity (Cognito or ShotX-issued token): the pool comes from the verified issuer and
 * key, never the request.
 */
export interface VerifiedIdentity {
  pool: AuthPool;
  /** `users.auth_subject`: a raw Cognito `sub`, or a prefixed ShotX subject (`line:...`). */
  sub: string;
  tokenUse: 'id' | 'access';
  /**
   * From a verified ID token with `email_verified`; null otherwise (Cognito access tokens carry
   * none). Exception: AUTH_PROVIDER=local mints access tokens with the profile too (LocalTokenVerifier).
   */
  email: string | null;
  /** From an ID token's `name` claim; null otherwise. */
  name: string | null;
  /**
   * Who issued the token. Cognito enforces admin MFA in the pool itself; ShotX-issued admins
   * tokens prove it with `amr` (AdminGuard, ADMIN_REQUIRED_AMR). Absent means `cognito`.
   */
  issuer?: 'cognito' | 'shotx';
  /** `amr` of a ShotX-issued token; absent for Cognito tokens. */
  amr?: readonly AuthMethod[];
  /** `sid` of a ShotX-issued token (auth_sessions.family_id); absent for Cognito tokens. */
  sessionId?: string;
  /**
   * PASSWORD_CHANGE_CLAIM (ADR 0010): a restricted photographer session that must change its
   * temporary password; only PASSWORD_CHANGE_ALLOWED_ROUTES work (the user guards enforce it).
   */
  passwordChange?: boolean;
}

export interface TokenVerifier {
  /** Rejects with ApiError UNAUTHENTICATED for anything that isn't a valid token of a pool. */
  verify(token: string): Promise<VerifiedIdentity>;
}

/**
 * The Redis operations of the share routes (face-scan results, unlock proofs, viewer sessions).
 * Keys are the builders' keys from @shotx/shared; implementations add the service prefix. Every
 * write sets a TTL (ADR 0005), and every error propagates, so callers fail closed.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  /** SET with EX. */
  setWithTtl(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** HGETALL; `{}` when the key doesn't exist. */
  hashGetAll(key: string): Promise<Record<string, string>>;
  /** HSET the fields (if any) and EXPIRE the key, atomically (MULTI). */
  hashSetWithTtl(key: string, fields: Record<string, string>, ttlSeconds: number): Promise<void>;
  /**
   * Atomically (one Lua script in Redis): for each field, HSET it only when the key lacks it or
   * holds a smaller number (values are decimal numbers, e.g. similarities), then EXPIRE the key.
   * Concurrent merges into the same key never lose each other's fields, and each field keeps the
   * maximum. With no fields only the TTL is reset, and only when the key exists.
   */
  hashMergeMaxWithTtl(
    key: string,
    fields: Record<string, string>,
    ttlSeconds: number,
  ): Promise<void>;
  /** HGET and HDEL one field atomically; null when the field (or key) doesn't exist. */
  hashTake(key: string, field: string): Promise<string | null>;
  /** GETDEL: read a string key and delete it in one step (one-time values); null when missing. */
  take(key: string): Promise<string | null>;
  /**
   * Atomically (one Lua script in Redis): when the key holds a number above 0, DECR it (the TTL
   * stays) and return the new value; otherwise null (missing, expired or used up). Counted
   * allowances such as captcha grants.
   */
  decrementIfPositive(key: string): Promise<number | null>;
}

/** A message body as serializeQueueMessage accepts it. */
export type QueueMessageInput<Q extends ApiQueue> = z.input<(typeof QUEUE_MESSAGE_SCHEMAS)[Q]>;

/** Sends validated messages to the API's queues (serializeQueueMessage): SQS or BullMQ. */
export interface QueueSender {
  send<Q extends ApiQueue>(queue: Q, message: QueueMessageInput<Q>): Promise<void>;
}
