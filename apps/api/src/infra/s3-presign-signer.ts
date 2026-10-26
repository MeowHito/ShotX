import { createHash, createHmac } from 'node:crypto';
import { CONTENT_DISPOSITION_QUERY_PARAM, parseS3Key } from '@shotx/shared';
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

/** SigV4 presigned URLs live at most 7 days. */
const MAX_EXPIRES_SECONDS = 7 * 24 * 60 * 60;

export interface S3PresignSignerOptions {
  /** AWS_ENDPOINT_URL (LocalStack), without a trailing slash. */
  endpointUrl: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  now?: () => Date;
}

/**
 * Path-style S3 presigned GET URLs (SigV4, synchronous) for local development only: there is no
 * CloudFront on a laptop, and LocalStack refuses anonymous reads of the private bucket. The config
 * loader allows MEDIA_URL_SIGNER=s3-presign only on APP_STAGE=local; deployed stages always use
 * CloudFrontMediaUrlSigner. Like it, only keys this platform built are signed. Long-lived keys
 * only (no X-Amz-Security-Token): fine for LocalStack's static test credentials.
 */
export class S3PresignMediaUrlSigner implements MediaUrlSigner {
  private readonly origin: URL;

  constructor(private readonly options: S3PresignSignerOptions) {
    this.origin = new URL(options.endpointUrl);
  }

  sign(key: string, expiresAt: Date, options: { contentDisposition?: string } = {}): string {
    if (parseS3Key(key) === null)
      throw new RangeError('Refusing to sign a key the platform did not build');
    const now = (this.options.now ?? (() => new Date()))();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const scope = `${day}/${this.options.region}/s3/aws4_request`;
    const expires = Math.min(
      MAX_EXPIRES_SECONDS,
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
