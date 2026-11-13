import { Inject, Injectable } from '@nestjs/common';
import { bucketedExpiry, contentDispositionAttachment } from '@shotx/shared';
import type { ApiConfig } from '../config';
import { API_CONFIG, CLOCK, type Clock, MEDIA_URL_SIGNER, type MediaUrlSigner } from '../tokens';

export interface SignedDownloadUrl {
  url: string;
  expiresAt: Date;
}

/**
 * Every CloudFront signed URL the API issues goes through here. Expiries are bucketed
 * (bucketedExpiry with SIGNED_URL_EXPIRY_BUCKET_SECONDS), so all URLs for one object issued in
 * the same window are byte-identical and browsers and CloudFront answer them from cache.
 */
@Injectable()
export class SignedUrls {
  constructor(
    @Inject(MEDIA_URL_SIGNER) private readonly signer: MediaUrlSigner,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Expiry of view URLs (thumbnails, previews, posters) issued now. */
  viewExpiry(): Date {
    const { signedUrlTtlSeconds, signedUrlExpiryBucketSeconds } = this.config.share;
    return bucketedExpiry(this.clock.now(), signedUrlTtlSeconds.view, signedUrlExpiryBucketSeconds);
  }

  /** Expiry of download URLs issued now. */
  downloadExpiry(): Date {
    const { signedUrlTtlSeconds, signedUrlExpiryBucketSeconds } = this.config.share;
    return bucketedExpiry(
      this.clock.now(),
      signedUrlTtlSeconds.download,
      signedUrlExpiryBucketSeconds,
    );
  }

  /** A view URL; pass one `expiresAt` (viewExpiry) for all URLs of a response. */
  view(key: string, expiresAt: Date): string {
    return this.signer.sign(key, expiresAt, { cacheable: true });
  }

  /**
   * A download URL: `response-content-disposition` = attachment with `fileName` (RFC 6266, Thai
   * names kept), download TTL.
   */
  download(key: string, fileName: string): SignedDownloadUrl {
    const expiresAt = this.downloadExpiry();
    return {
      url: this.signer.sign(key, expiresAt, {
        contentDisposition: contentDispositionAttachment(fileName),
      }),
      expiresAt,
    };
  }
}
