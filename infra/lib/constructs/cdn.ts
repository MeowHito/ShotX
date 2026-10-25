import { Duration } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import { APP_ROUTING_HEADER, PATHS } from '../constants';
import { PrefixScopedOacOrigin } from './prefix-scoped-oac-origin';
import { ROUTING_HEADER_VALUES } from './services';

export interface CdnProps {
  readonly config: PlatformConfig;
  readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  readonly mediaBucket: s3.IBucket;
  readonly logBucket: s3.IBucket;
  readonly signingKey: cloudfront.IPublicKey;
  readonly mainCertificate: acm.ICertificate;
  readonly adminCertificate: acm.ICertificate;
  readonly mainWebAclArn: string;
  readonly adminWebAclArn: string;
}

/**
 * Two distributions:
 *
 * main (flat-rate plan, see PricingPlanStack)
 *   /api/*            -> ALB (api), no caching, all viewer headers/cookies/query forwarded
 *   /media/*          -> S3 via OAC, signed URLs (key group), long cache, /media prefix stripped
 *   /_next/static/*   -> ALB (web), cached
 *   default           -> ALB (web), no caching
 *
 * admin (pay-as-you-go)
 *   /api/*            -> ALB (api)
 *   /_next/static/*   -> ALB (admin), cached
 *   default           -> ALB (admin)
 *
 * Only plan-compatible features are used on main: OAC (not OAI), cache and origin request
 * policies (no legacy ForwardedValues), standard access logs (no real-time logs), and resources
 * (web ACL, CloudFront Function) that are not shared with any other distribution.
 */
export class Cdn extends Construct {
  readonly mainDistribution: cloudfront.Distribution;
  readonly adminDistribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: CdnProps) {
    super(scope, id);
    const { config } = props;
    const { cdn, domain } = config;
    const prefix = `shotx-${config.stage}`;

    // One VPC origin (CloudFront -> internal ALB over the AWS network), used by both
    // distributions. The routing header tells the ALB which app a request is for.
    const vpcOrigin = new cloudfront.VpcOrigin(this, 'AlbVpcOrigin', {
      vpcOriginName: `${prefix}-alb`,
      endpoint: cloudfront.VpcOriginEndpoint.applicationLoadBalancer(props.loadBalancer),
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      httpPort: 80,
    });
    const albOrigin = (app: keyof typeof ROUTING_HEADER_VALUES) =>
      origins.VpcOrigin.withVpcOrigin(vpcOrigin, {
        domainName: props.loadBalancer.loadBalancerDnsName,
        readTimeout: Duration.seconds(cdn.originReadTimeoutSeconds),
        keepaliveTimeout: Duration.seconds(cdn.originKeepaliveSeconds),
        customHeaders: { [APP_ROUTING_HEADER]: ROUTING_HEADER_VALUES[app] },
      });

    const dynamic: Omit<cloudfront.BehaviorOptions, 'origin'> = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      compress: true,
    };
    const staticAssets: Omit<cloudfront.BehaviorOptions, 'origin'> = {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      compress: true,
    };

    // --- main -------------------------------------------------------------------------------
    const webOrigin = albOrigin('web');
    const mediaOrigin = new PrefixScopedOacOrigin(props.mediaBucket, {
      originAccessControl: new cloudfront.S3OriginAccessControl(this, 'MediaOac', {
        originAccessControlName: `${prefix}-media`,
        signing: cloudfront.Signing.SIGV4_ALWAYS,
      }),
      readablePrefixes: cdn.media.readablePrefixes,
    });
    const mediaCachePolicy = new cloudfront.CachePolicy(this, 'MediaCachePolicy', {
      cachePolicyName: `${prefix}-media`,
      comment: 'Signed media from S3; immutable keys, long TTL',
      minTtl: Duration.seconds(cdn.media.minTtlSeconds),
      defaultTtl: Duration.seconds(cdn.media.defaultTtlSeconds),
      maxTtl: Duration.seconds(cdn.media.maxTtlSeconds),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      queryStringBehavior:
        cdn.media.cacheQueryStrings.length > 0
          ? cloudfront.CacheQueryStringBehavior.allowList(...cdn.media.cacheQueryStrings)
          : cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: false,
      enableAcceptEncodingBrotli: false,
    });
    // S3 keys don't carry the /media prefix (originals/..., derived/..., tmp/zips/...).
    const stripMediaPrefix = new cloudfront.Function(this, 'StripMediaPrefix', {
      functionName: `${prefix}-strip-media-prefix`,
      comment: `Strip ${PATHS.media} before the request reaches S3`,
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        [
          'function handler(event) {',
          '  var request = event.request;',
          `  var prefix = ${JSON.stringify(PATHS.media)};`,
          '  if (request.uri.indexOf(prefix + "/") === 0) {',
          '    request.uri = request.uri.substring(prefix.length);',
          '  }',
          '  return request;',
          '}',
        ].join('\n'),
      ),
    });

    this.mainDistribution = new cloudfront.Distribution(this, 'MainDistribution', {
      comment: `${prefix} main (flat-rate plan)`,
      domainNames: [domain.main],
      certificate: props.mainCertificate,
      webAclId: props.mainWebAclArn,
      priceClass: cdn.priceClass as cloudfront.PriceClass,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableIpv6: true,
      enableLogging: true,
      logBucket: props.logBucket,
      logFilePrefix: 'cloudfront/main/',
      logIncludesCookies: false,
      defaultBehavior: { origin: webOrigin, ...dynamic },
      additionalBehaviors: {
        [`${PATHS.api}/*`]: { origin: webOrigin, ...dynamic },
        [`${PATHS.media}/*`]: {
          origin: mediaOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: mediaCachePolicy,
          trustedKeyGroups: [
            new cloudfront.KeyGroup(this, 'MediaKeyGroup', {
              keyGroupName: `${prefix}-media`,
              items: [props.signingKey],
            }),
          ],
          functionAssociations: [
            { function: stripMediaPrefix, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          ],
          compress: false,
        },
        [`${PATHS.nextStatic}/*`]: { origin: webOrigin, ...staticAssets },
      },
    });

    // --- admin ------------------------------------------------------------------------------
    const adminOrigin = albOrigin('admin');
    this.adminDistribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      comment: `${prefix} admin (pay-as-you-go)`,
      domainNames: [domain.admin],
      certificate: props.adminCertificate,
      webAclId: props.adminWebAclArn,
      priceClass: cdn.adminPriceClass as cloudfront.PriceClass,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableIpv6: true,
      enableLogging: true,
      logBucket: props.logBucket,
      logFilePrefix: 'cloudfront/admin/',
      logIncludesCookies: false,
      defaultBehavior: { origin: adminOrigin, ...dynamic },
      additionalBehaviors: {
        [`${PATHS.api}/*`]: { origin: adminOrigin, ...dynamic },
        [`${PATHS.nextStatic}/*`]: { origin: adminOrigin, ...staticAssets },
      },
    });

    // --- DNS --------------------------------------------------------------------------------
    if (domain.hostedZoneId !== '') {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: domain.hostedZoneId,
        zoneName: domain.hostedZoneName,
      });
      for (const [rid, recordName, distribution] of [
        ['Main', domain.main, this.mainDistribution],
        ['Admin', domain.admin, this.adminDistribution],
      ] as const) {
        const target = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));
        new route53.ARecord(this, `${rid}A`, { zone, recordName, target });
        new route53.AaaaRecord(this, `${rid}Aaaa`, { zone, recordName, target });
      }
    }
  }
}
