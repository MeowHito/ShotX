import { utf8ByteLength } from '../s3-keys';

/**
 * Expiry of a signed URL issued at `now`: `ceil(now / bucket) * bucket + ttl`, on whole seconds.
 * Every URL for the same object issued within one bucket window gets the same expiry, so the
 * signed URL is byte-identical and browsers and CloudFront answer it from cache. The URL lives
 * between `ttl` and `ttl + bucket` seconds. Use SIGNED_URL_EXPIRY_BUCKET_SECONDS as the bucket.
 */
export function bucketedExpiry(now: Date, ttlSeconds: number, bucketSeconds: number): Date {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new RangeError(`ttlSeconds must be a positive integer, got ${ttlSeconds}`);
  }
  if (!Number.isInteger(bucketSeconds) || bucketSeconds < 1) {
    throw new RangeError(`bucketSeconds must be a positive integer, got ${bucketSeconds}`);
  }
  const ms = now.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('now must be a valid date');
  const nowSeconds = ms / 1000;
  const windowEnd = Math.ceil(nowSeconds / bucketSeconds) * bucketSeconds;
  return new Date((windowEnd + ttlSeconds) * 1000);
}

/**
 * SigV4 signing date (X-Amz-Date) of a presigned media URL issued at `now`:
 * `floor(now / bucket) * bucket`, on whole seconds (ADR 0008 section 2). The date is part of a
 * presigned URL, so with {@link bucketedExpiry} every URL for one key issued within one bucket
 * window is byte-identical. X-Amz-Expires is `bucketedExpiry - bucketedSigningDate` (at most
 * ttl + 2 x bucket), capped at S3_PRESIGN_MAX_EXPIRES_SECONDS. Use
 * SIGNED_URL_EXPIRY_BUCKET_SECONDS as the bucket. CloudFront URLs carry no signing date.
 */
export function bucketedSigningDate(now: Date, bucketSeconds: number): Date {
  if (!Number.isInteger(bucketSeconds) || bucketSeconds < 1) {
    throw new RangeError(`bucketSeconds must be a positive integer, got ${bucketSeconds}`);
  }
  const ms = now.getTime();
  if (!Number.isFinite(ms)) throw new RangeError('now must be a valid date');
  return new Date(Math.floor(ms / 1000 / bucketSeconds) * bucketSeconds * 1000);
}

/**
 * The query parameter CloudFront forwards to S3 (through OAC) to set the response's
 * Content-Disposition. infra's `/media/*` behavior must forward it to the origin and include it
 * in the cache key; the API adds it to the URL before signing.
 */
export const CONTENT_DISPOSITION_QUERY_PARAM = 'response-content-disposition';

/**
 * S3 / R2 GetObject override of the answer's Cache-Control, signed into view URLs so browsers
 * keep thumbnails and previews for as long as the URL lives (R2 objects carry no Cache-Control).
 */
export const CACHE_CONTROL_QUERY_PARAM = 'response-cache-control';

// RFC 5987 attr-char: ALPHA / DIGIT / "!" / "#" / "$" / "&" / "+" / "-" / "." / "^" / "_" / "`" / "|" / "~"
function encodeRfc5987(value: string): string {
  return Array.from(new TextEncoder().encode(value), (b) => {
    const c = String.fromCharCode(b);
    return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(c)
      ? c
      : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

/**
 * `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>` (RFC 6266), so
 * a download keeps its Thai name in modern browsers and gets a safe ASCII name elsewhere. Quotes,
 * backslashes, control characters and anything non-ASCII become `_` in the fallback.
 */
export function contentDispositionAttachment(fileName: string): string {
  if (fileName === '' || utf8ByteLength(fileName) > 1024) {
    throw new RangeError('fileName must be 1 to 1024 UTF-8 bytes');
  }
  const fallback = fileName.normalize('NFC').replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName.normalize('NFC'))}`;
}
