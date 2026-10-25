import { Stack } from 'aws-cdk-lib';
import type * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

export interface PrefixScopedOacOriginProps extends cloudfront.OriginProps {
  readonly originAccessControl: cloudfront.S3OriginAccessControl;
  /** Key prefixes CloudFront may read, each ending in "/". */
  readonly readablePrefixes: readonly string[];
}

/**
 * S3 origin using Origin Access Control (never OAI: flat-rate plans don't support OAI).
 *
 * `S3BucketOrigin.withOriginAccessControl` grants s3:GetObject on the whole bucket. This origin
 * grants it only on the listed prefixes and only to this distribution (AWS:SourceArn), so the
 * face-index scratch images under tmp/index/ can't be served even with a valid signed URL.
 */
export class PrefixScopedOacOrigin extends origins.S3BucketOrigin {
  private readonly mediaBucket: s3.IBucket;
  private readonly oac: cloudfront.S3OriginAccessControl;
  private readonly prefixes: readonly string[];

  constructor(bucket: s3.IBucket, props: PrefixScopedOacOriginProps) {
    const { originAccessControl, readablePrefixes, ...originProps } = props;
    super(bucket, originProps);
    if (readablePrefixes.length === 0) throw new Error('readablePrefixes must not be empty');
    this.mediaBucket = bucket;
    this.oac = originAccessControl;
    this.prefixes = readablePrefixes;
  }

  public override bind(
    scope: Construct,
    options: cloudfront.OriginBindOptions,
  ): cloudfront.OriginBindConfig {
    if (options.distributionId === undefined) {
      throw new Error('PrefixScopedOacOrigin needs the distribution id to scope the bucket policy');
    }
    const distributionArn = Stack.of(scope).formatArn({
      service: 'cloudfront',
      region: '',
      resource: 'distribution',
      resourceName: options.distributionId,
    });
    const { statementAdded } = this.mediaBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'CloudFrontOacRead',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: this.prefixes.map((prefix) => this.mediaBucket.arnForObjects(`${prefix}*`)),
        conditions: { StringEquals: { 'AWS:SourceArn': distributionArn } },
      }),
    );
    if (!statementAdded) {
      throw new Error(
        'Could not add the OAC statement: the media bucket must be owned by this app',
      );
    }

    const config = this._bind(scope, options);
    if (config.originProperty === undefined) throw new Error('S3 origin did not render');
    return {
      ...config,
      originProperty: {
        ...config.originProperty,
        originAccessControlId: this.oac.originAccessControlId,
      },
    };
  }
}
