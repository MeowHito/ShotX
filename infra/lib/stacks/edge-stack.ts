import { Stack, type StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { ArnFormat } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import {
  allOf,
  anyOf,
  blockUnlessIpInSet,
  managedRuleGroup,
  methodIs,
  rateLimitedResponseBodies,
  rateRule,
  uriEndsWith,
  uriStartsWith,
  wafVisibility,
} from '../constructs/waf-rules';

export interface EdgeStackProps extends StackProps {
  readonly config: PlatformConfig;
}

/**
 * us-east-1: everything CloudFront needs from that region. CloudFront-scoped WAF web ACLs and
 * CloudFront ACM certificates can only be created here. The App stack in ap-southeast-1 reads
 * these through cross-region references.
 *
 * The main and admin distributions get separate web ACLs: a web ACL attached to a distribution
 * on a flat-rate plan can't be shared with another distribution.
 */
export class EdgeStack extends Stack {
  readonly mainCertificate: acm.ICertificate;
  readonly adminCertificate: acm.ICertificate;
  readonly mainWebAclArn: string;
  readonly adminWebAclArn: string;

  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    const { config } = props;
    const { domain, waf } = config;

    const zone =
      domain.hostedZoneId === ''
        ? undefined
        : route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
            hostedZoneId: domain.hostedZoneId,
            zoneName: domain.hostedZoneName,
          });

    const certificate = (cid: string, arn: string, domainName: string): acm.ICertificate =>
      arn !== ''
        ? acm.Certificate.fromCertificateArn(this, cid, arn)
        : new acm.Certificate(this, cid, {
            domainName,
            validation: acm.CertificateValidation.fromDns(zone),
          });
    this.mainCertificate = certificate('MainCertificate', domain.certificateArn, domain.main);
    this.adminCertificate = certificate(
      'AdminCertificate',
      domain.adminCertificateArn,
      domain.admin,
    );

    const prefix = `shotx-${config.stage}`;
    const window = waf.evaluationWindowSeconds;
    const faceSearch = allOf([
      methodIs('POST'),
      uriStartsWith(waf.faceSearchPathPrefix),
      uriEndsWith(waf.faceSearchPathSuffix),
    ]);
    const sharePaths = anyOf(waf.sharePathPrefixes.map(uriStartsWith));

    const mainAcl = new wafv2.CfnWebACL(this, 'MainWebAcl', {
      name: `${prefix}-main`,
      description: 'Main distribution - rate limits and CAPTCHA on share pages and face search',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: wafVisibility(`${prefix}-main`),
      captchaConfig: { immunityTimeProperty: { immunityTime: waf.captchaImmunitySeconds } },
      customResponseBodies: rateLimitedResponseBodies,
      rules: [
        managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 0),
        rateRule({
          name: 'global-rate-block',
          priority: 10,
          limit: waf.globalRateLimit,
          evaluationWindowSec: window,
          action: 'block',
        }),
        rateRule({
          name: 'face-search-rate-block',
          priority: 20,
          limit: waf.faceSearchBlockRateLimit,
          evaluationWindowSec: window,
          action: 'block',
          scopeDown: faceSearch,
        }),
        rateRule({
          name: 'face-search-rate-captcha',
          priority: 21,
          limit: waf.faceSearchCaptchaRateLimit,
          evaluationWindowSec: window,
          action: 'captcha',
          scopeDown: faceSearch,
        }),
        rateRule({
          name: 'share-rate-block',
          priority: 30,
          limit: waf.shareBlockRateLimit,
          evaluationWindowSec: window,
          action: 'block',
          scopeDown: sharePaths,
        }),
        rateRule({
          name: 'share-rate-captcha',
          priority: 31,
          limit: waf.shareCaptchaRateLimit,
          evaluationWindowSec: window,
          action: 'captcha',
          scopeDown: sharePaths,
        }),
        managedRuleGroup('AWSManagedRulesCommonRuleSet', 40, waf.commonRuleSetCountOverrides),
        managedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 50),
      ],
    });

    const adminRules: wafv2.CfnWebACL.RuleProperty[] = [
      managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 0),
      rateRule({
        name: 'admin-rate-block',
        priority: 10,
        limit: waf.adminRateLimit,
        evaluationWindowSec: window,
        action: 'block',
      }),
      managedRuleGroup('AWSManagedRulesCommonRuleSet', 40, waf.commonRuleSetCountOverrides),
      managedRuleGroup('AWSManagedRulesKnownBadInputsRuleSet', 50),
    ];
    if (waf.adminAllowedIpv4Cidrs.length > 0) {
      const allowList = new wafv2.CfnIPSet(this, 'AdminAllowList', {
        name: `${prefix}-admin-allow`,
        scope: 'CLOUDFRONT',
        ipAddressVersion: 'IPV4',
        addresses: waf.adminAllowedIpv4Cidrs,
      });
      adminRules.push(blockUnlessIpInSet('admin-ip-allowlist', 5, allowList.attrArn));
    }
    const adminAcl = new wafv2.CfnWebACL(this, 'AdminWebAcl', {
      name: `${prefix}-admin`,
      description: 'Admin distribution - pay-as-you-go',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: wafVisibility(`${prefix}-admin`),
      customResponseBodies: rateLimitedResponseBodies,
      rules: adminRules.sort((a, b) => a.priority - b.priority),
    });

    // WAF logs. Cookies and Authorization headers are redacted; WAF never logs request bodies, so
    // selfies posted to face search never reach these logs.
    for (const [lid, acl] of [
      ['Main', mainAcl],
      ['Admin', adminAcl],
    ] as const) {
      const logGroupName = `aws-waf-logs-${prefix}-${lid.toLowerCase()}`;
      const logGroup = new logs.LogGroup(this, `${lid}WafLogs`, {
        logGroupName,
        retention: waf.logRetentionDays,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      const logging = new wafv2.CfnLoggingConfiguration(this, `${lid}WafLogging`, {
        resourceArn: acl.attrArn,
        // WAF wants the log group ARN without the trailing ":*" that LogGroup.logGroupArn has.
        logDestinationConfigs: [
          this.formatArn({
            service: 'logs',
            resource: 'log-group',
            resourceName: logGroupName,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
        redactedFields: [
          { singleHeader: { Name: 'cookie' } },
          { singleHeader: { Name: 'authorization' } },
        ],
      });
      logging.node.addDependency(logGroup);
    }

    this.mainWebAclArn = mainAcl.attrArn;
    this.adminWebAclArn = adminAcl.attrArn;

    new CfnOutput(this, 'MainWebAclArn', { value: mainAcl.attrArn });
    new CfnOutput(this, 'AdminWebAclArn', { value: adminAcl.attrArn });
  }
}
