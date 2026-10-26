import { createHash, createHmac } from 'node:crypto';
import {
  bucketedSigningDate,
  CONTENT_DISPOSITION_QUERY_PARAM,
  parseS3Key,
  S3_PRESIGN_MAX_EXPIRES_SECONDS,
} from '@shotx/shared';
import type { MediaUrlSigner } from '../tokens';

/** RFC 3986 encoding, as SigV4 canonical requests need it. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');
const hmac = (key: Buffer | string, value: string) =>
  createHmac('sha256', key).update(value).digest();

export interface S3PresignSignerOptions {
  /** STORAGE_ENDPOINT_URL (an origin): R2's S3 API endpoint, LocalStack or MinIO. */
  endpointUrl: string;
  /** STORAGE_REGION (`auto` for R2): the credential scope's region. */
  region: string;
  bucket: string;
  /** STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY (a read-capable R2 token). */
  accessKeyId: string;
  secretAccessKey: string;
  /** SIGNED_URL_EXPIRY_BUCKET_SECONDS: the signing date is rounded down to a multiple of it. */
  signingDateBucketSeconds: number;
  now?: () => Date;
}

/**
 * Path-style SigV4 presigned GET URLs (synchronous) of the private media bucket on an
 * S3-compatible endpoint (MEDIA_URL_SIGNER=s3-presign): Cloudflare R2 on the VPS (ADR 0008
 * section 2), LocalStack or MinIO locally. Never an unsigned or non-expiring URL; only keys this
 * platform built are signed (parseS3Key).
 *
 * The signing date (X-Amz-Date) is bucketedSigningDate(now, SIGNED_URL_EXPIRY_BUCKET_SECONDS), and
 * callers pass a bucketed expiry (SignedUrls), so every URL for one key (and disposition) issued
 * in one window is byte-identical and browsers get cache hits. X-Amz-Expires is the expiry minus
 * the signing date, capped at S3_PRESIGN_MAX_EXPIRES_SECONDS (7 days, R2's and S3's limit).
 * Long-lived keys only (no X-Amz-Security-Token).
 */
export class S3PresignMediaUrlSigner implements MediaUrlSigner {
  private readonly origin: URL;

  constructor(private readonly options: S3PresignSignerOptions) {
    this.origin = new URL(options.endpointUrl);
  }

  sign(key: string, expiresAt: Date, options: { contentDisposition?: string } = {}): string {
    if (parseS3Key(key) === null)
      throw new RangeError('Refusing to sign a key the platform did not build');
    const now = bucketedSigningDate(
      (this.options.now ?? (() => new Date()))(),
      this.options.signingDateBucketSeconds,
    );
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const scope = `${day}/${this.options.region}/s3/aws4_request`;
    const expires = Math.min(
      S3_PRESIGN_MAX_EXPIRES_SECONDS,
      Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000)),
    );

    const path = `/${[this.options.bucket, ...key.split('/')].map(rfc3986).join('/')}`;
    const params: [string, string][] = [
      ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
      ['X-Amz-Content-Sha256', 'UNSIGNED-PAYLOAD'],
      ['X-Amz-Credential', `${this.options.accessKeyId}/${scope}`],
      ['X-Amz-Date', amzDate],
      ['X-Amz-Expires', String(expires)],
      ['X-Amz-SignedHeaders', 'host'],
    ];
    if (options.contentDisposition !== undefined) {
      params.push([CONTENT_DISPOSITION_QUERY_PARAM, options.contentDisposition]);
    }
    const query = params
      .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const canonicalRequest = [
      'GET',
      path,
      query,
      `host:${this.origin.host}`,
      '',
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join(
      '\n',
    );
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.options.secretAccessKey}`, day), this.options.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
    return `${this.origin.origin}${path}?${query}&X-Amz-Signature=${signature}`;
  }
}
