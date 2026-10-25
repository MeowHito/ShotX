import { getSignedUrl } from '@aws-sdk/cloudfront-signer';
import { type CloudFrontSigningConfig, parseS3Key } from '@shotx/shared';
import type { MediaUrlSigner } from '../tokens';

/** `<CLOUDFRONT_MEDIA_BASE_URL>/<key>` with every key segment URL-encoded. */
export function mediaUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

/**
 * CloudFront signed URLs (canned policy) for objects under `/media` (the distribution strips the
 * prefix before S3). Only keys this platform built are signed: never anything else, and never an
 * S3 URL.
 */
export class CloudFrontMediaUrlSigner implements MediaUrlSigner {
  constructor(private readonly config: CloudFrontSigningConfig) {}

  sign(key: string, expiresAt: Date): string {
    if (parseS3Key(key) === null)
      throw new RangeError('Refusing to sign a key the platform did not build');
    return getSignedUrl({
      url: mediaUrl(this.config.mediaBaseUrl, key),
      keyPairId: this.config.keyPairId,
      privateKey: this.config.privateKey,
      dateLessThan: expiresAt.toISOString(),
    });
  }
}
