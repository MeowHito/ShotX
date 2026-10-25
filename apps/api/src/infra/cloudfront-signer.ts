import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import {
  CONTENT_DISPOSITION_QUERY_PARAM,
  type CloudFrontSigningConfig,
  parseS3Key,
} from '@shotx/shared';
import type { MediaUrlSigner } from '../tokens';

/** `<CLOUDFRONT_MEDIA_BASE_URL>/<key>` with every key segment URL-encoded. */
export function mediaUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * CloudFront signed URLs (canned policy) for objects under `/media` (the distribution strips the
 * prefix before S3). Only keys this platform built are signed: never anything else, and never an
 * S3 URL. The canned-policy signature (RSA-SHA1, PKCS#1 v1.5) is deterministic, so the same key,
 * query and expiry always give byte-identical URLs: callers pass bucketed expiries (see
 * SignedUrls) so browsers and CloudFront get cache hits.
 */
export class CloudFrontMediaUrlSigner implements MediaUrlSigner {
  constructor(private readonly config: CloudFrontSigningConfig) {}

  sign(key: string, expiresAt: Date, options: { contentDisposition?: string } = {}): string {
    if (parseS3Key(key) === null)
      throw new RangeError('Refusing to sign a key the platform did not build');
    let url = mediaUrl(this.config.mediaBaseUrl, key);
    if (options.contentDisposition !== undefined) {
      url += `?${CONTENT_DISPOSITION_QUERY_PARAM}=${encodeURIComponent(options.contentDisposition)}`;
    }
    return getSignedUrl({
      url,
      keyPairId: this.config.keyPairId,
      privateKey: this.config.privateKey,
      // Whole seconds: CloudFront's policy is in epoch seconds anyway.
      dateLessThan: new Date(Math.floor(expiresAt.getTime() / 1000) * 1000).toISOString(),
    });
  }
}
