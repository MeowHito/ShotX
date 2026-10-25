import type { AuthPool } from '@shotx/shared';

// Injection tokens and the interfaces behind them. Production wires real clients in main.ts;
// tests pass fakes to createApiApp. Constructor parameters always use @Inject(TOKEN).

export const API_CONFIG = Symbol('API_CONFIG');
export const DATABASE = Symbol('DATABASE');
export const OBJECT_STORAGE = Symbol('OBJECT_STORAGE');
export const MEDIA_URL_SIGNER = Symbol('MEDIA_URL_SIGNER');
export const RATE_LIMITER = Symbol('RATE_LIMITER');
export const TOKEN_VERIFIER = Symbol('TOKEN_VERIFIER');
export const CLOCK = Symbol('CLOCK');
export const REDIS = Symbol('REDIS');

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
  sign(key: string, expiresAt: Date): string;
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
}

export interface TokenVerifier {
  /** Rejects with ApiError UNAUTHENTICATED for anything that isn't a valid token of a pool. */
  verify(token: string): Promise<VerifiedIdentity>;
}
