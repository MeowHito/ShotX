import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import { S3_PREFIXES } from '../constants';

export interface MediaStorageProps {
  readonly config: PlatformConfig;
}

/**
 * The private media bucket and the CloudFront log bucket.
 *
 * Neither bucket is ever public: Block Public Access is fully on, ACLs are disabled on the media
 * bucket, and objects are only readable through CloudFront OAC (see PrefixScopedOacOrigin).
 * Uploads use presigned multipart URLs, which are authenticated requests and work with BPA on.
 */
export class MediaStorage extends Construct {
  readonly bucket: s3.Bucket;
  readonly logBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: MediaStorageProps) {
    super(scope, id);
    const { config } = props;
    const { storage, domain } = config;

    this.bucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      // SSE-S3: CloudFront OAC and Rekognition can read without KMS key grants.
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
      cors: [
        {
          // Browser multipart upload with presigned part URLs (Uppy @uppy/aws-s3).
          allowedOrigins: [`https://${domain.main}`],
          allowedMethods: [s3.HttpMethods.PUT],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: storage.uploadCorsMaxAgeSeconds,
        },
      ],
      lifecycleRules: [
        {
          id: 'abort-incomplete-multipart-uploads',
          abortIncompleteMultipartUploadAfter: Duration.days(
            storage.abortIncompleteMultipartUploadDays,
          ),
        },
        {
          id: 'expire-tmp',
          prefix: S3_PREFIXES.tmp,
          expiration: Duration.days(storage.tmpExpirationDays),
        },
        {
          id: 'originals-intelligent-tiering',
          prefix: S3_PREFIXES.originals,
          transitions: [
            {
              storageClass: s3.StorageClass.INTELLIGENT_TIERING,
              transitionAfter: Duration.days(storage.originalsIntelligentTieringAfterDays),
            },
          ],
        },
      ],
    });

    // CloudFront standard (legacy) access logs need ACLs enabled on the target bucket. The grant
    // goes to the CloudFront log-delivery account, which is not public, so BPA stays fully on.
    this.logBucket = new s3.Bucket(this, 'CloudFrontLogBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'expire-cloudfront-logs',
          expiration: Duration.days(storage.cloudFrontLogExpirationDays),
        },
      ],
    });
  }
}
