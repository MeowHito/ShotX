import type { AuthPool, QUEUE_MESSAGE_SCHEMAS } from '@shotx/shared';
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
}

/** CloudFront signed URLs for media keys. Never S3 URLs. */
export interface MediaUrlSigner {
  /**
   * A signed URL of `key` that expires at `expiresAt`. `contentDisposition` is added as the
   * `response-content-disposition` query parameter before signing (downloads).
   */
  sign(key: string, expiresAt: Date, options?: { contentDisposition?: string }): string;
}

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets (for Retry-After). */
  retryAfterSeconds: number;
}

/** Fixed-window counters. Implementations fail closed: an error means not allowed. */
export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult>;
}

/** A verified Cognito identity: the pool comes from the verified issuer, never the request. */
export interface VerifiedIdentity {
  pool: AuthPool;
  sub: string;
  tokenUse: 'id' | 'access';
  /**
   * From a verified ID token with `email_verified`; null otherwise (Cognito access tokens carry
   * none). Exception: AUTH_PROVIDER=local mints access tokens with the profile too (LocalTokenVerifier).
   */
  email: string | null;
  /** From an ID token's `name` claim; null otherwise. */
  name: string | null;
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
}

/** A message body as serializeQueueMessage accepts it. */
export type QueueMessageInput<Q extends ApiQueue> = z.input<(typeof QUEUE_MESSAGE_SCHEMAS)[Q]>;

/** Sends validated messages to the API's SQS queues (serializeQueueMessage). */
export interface QueueSender {
  send<Q extends ApiQueue>(queue: Q, message: QueueMessageInput<Q>): Promise<void>;
}
