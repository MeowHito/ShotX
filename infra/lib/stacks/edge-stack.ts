import { Stack, type StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { ArnFormat } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { faceSearchLimits, type PlatformConfig, webhookPath } from '../config';
import { FACE_SEARCH_CONTENT_TYPE, HTTP_HEADERS } from '../constants';
import {
  allOf,
  anyOf,
  blockRule,
  blockUnlessIpInSet,
  customResponseBodies,
  escapeRegex,
  headerIntegerGreaterThan,
  headerStartsWith,
  managedRuleGroup,
  methodIs,
  not,
  payloadTooLargeRule,
  rateRule,
  tokenPathRegex,
  uriMatches,
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
 *
 * Path matching URL-decodes and lowercases the path first, because the API routes
 * case-insensitively and decodes percent-escapes: `/api/s/<t>/FACE-SEARCH/` and
 * `/api/s/<t>/face%2Dsearch` must hit the same limits as `/api/s/<t>/face-search`.
 *
 * Face-search and face-deletion uploads (multipart POSTs of up to FACE_MAX_SELFIES JPEG
 * selfies, rate-limited together) skip the managed
 * rule groups, whose body rules (XSS, LFI, RFI, SSRF, size, Java/Log4j payloads) would read
 * JPEG bytes as text and block real scans. They get a Content-Length limit sized from the face
 * configuration instead. WAF only ever sees the first `waf.bodyInspectionLimit` of a body (16 KB
 * by default, 64 KB at most), less than one selfie, so body inspection can't protect that route
 * anyway; the API enforces the same byte limits while it reads the upload.
 *
 * Payment webhooks (POST /api/billing/webhooks/<PAYMENT_GATEWAY>) skip the same managed groups:
 * the gateway signs the raw body, and a JSON payload with a URL or HTML in it must not be blocked.
 * They are outside the share paths (no CAPTCHA, which a gateway can't solve), get their own
 * generous per-IP rate rule, and optionally a source IP allowlist (waf.webhookAllowedIpv4Cidrs).
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
    const shareApiPath = (suffix: string) =>
      uriMatches(tokenPathRegex(waf.shareApiPathPrefix, suffix));
    // Face search and "delete my face" both take selfie uploads and share one per-IP budget, as
    // they share the API's FACE_SEARCH_RATE_* limits.
    const faceSearchPath = anyOf([
      shareApiPath(waf.faceSearchPathSuffix),
      shareApiPath(waf.faceDeletionPathSuffix),
    ]);
    const faceSearch = allOf([methodIs('POST'), faceSearchPath]);
    const faceSearchUpload = allOf([
      methodIs('POST'),
      faceSearchPath,
      headerStartsWith(HTTP_HEADERS.contentType, FACE_SEARCH_CONTENT_TYPE),
    ]);
    const unlock = allOf([methodIs('POST'), shareApiPath(waf.unlockPathSuffix)]);
    const downloads = allOf([methodIs('POST'), shareApiPath(waf.downloadsPathSuffix)]);
    const sharePaths = anyOf(waf.sharePathPrefixes.map(uriStartsWith));
    // POST /api/billing/webhooks/<PAYMENT_GATEWAY>: the gateway signs the raw body, so no rule may
    // block it for what the body looks like, and a gateway can't solve a CAPTCHA.
    const webhook = allOf([
      methodIs('POST'),
      uriMatches(`^${escapeRegex(webhookPath(config))}/?$`),
    ]);
    const { maxBodyBytes } = faceSearchLimits(config);
    // Managed groups with body rules see every request except face-search uploads and payment
    // webhooks.
    const managed = (name: string, priority: number, countOverrides: string[] = []) =>
      managedRuleGroup(name, priority, {
        countOverrides,
        scopeDown: not(anyOf([faceSearchUpload, webhook])),
      });
    const associationConfig = {
      requestBody: { CLOUDFRONT: { defaultSizeInspectionLimit: waf.bodyInspectionLimit } },
    };

    const webhookAllowList =
      waf.webhookAllowedIpv4Cidrs.length === 0
        ? []
        : [
            blockRule(
              'webhook-ip-allowlist',
              1,
              allOf([
                webhook,
                not({
                  ipSetReferenceStatement: {
                    arn: new wafv2.CfnIPSet(this, 'WebhookAllowList', {
                      name: `${prefix}-webhook-allow`,
                      scope: 'CLOUDFRONT',
                      ipAddressVersion: 'IPV4',
                      addresses: waf.webhookAllowedIpv4Cidrs,
                    }).attrArn,
                  },
                }),
              ]),
            ),
          ];

    const mainAcl = new wafv2.CfnWebACL(this, 'MainWebAcl', {
      name: `${prefix}-main`,
      description: 'Main distribution - rate limits and CAPTCHA on share pages and face search',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: wafVisibility(`${prefix}-main`),
      captchaConfig: { immunityTimeProperty: { immunityTime: waf.captchaImmunitySeconds } },
      customResponseBodies,
      associationConfig,
      rules: [
        managedRuleGroup('AWSManagedRulesAmazonIpReputationList', 0),
        ...webhookAllowList,
        rateRule({
          name: 'global-rate-block',
          priority: 10,
          limit: waf.globalRateLimit,
          evaluationWindowSec: window,
          action: 'block',
        }),
        rateRule({
          name: 'webhook-rate-block',
          priority: 15,
          limit: waf.webhookRateLimit,
          evaluationWindowSec: window,
          action: 'block',
          scopeDown: webhook,
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
        // After the face-search rate rules, so oversized posts still count towards them.
        payloadTooLargeRule(
          'face-search-body-too-large',
          25,
          allOf([
            methodIs('POST'),
            faceSearchPath,
            headerIntegerGreaterThan(HTTP_HEADERS.contentLength, maxBodyBytes),
          ]),
        ),
        rateRule({
          name: 'share-unlock-rate-block',
          priority: 26,
          limit: waf.unlockBlockRateLimit,
          evaluationWindowSec: window,
          action: 'block',
          scopeDown: unlock,
        }),
        rateRule({
          name: 'share-downloads-rate-block',
          priority: 27,
          limit: waf.downloadsBlockRateLimit,
          evaluationWindowSec: window,
          action: 'block',
          scopeDown: downloads,
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
        managed('AWSManagedRulesCommonRuleSet', 40, waf.commonRuleSetCountOverrides),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 50),
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
      // The admin distribution forwards /api/* to the same API. Share pages and face search are
      // served on the main domain only, where their rate limits and CAPTCHA apply.
      blockRule('public-share-paths-block', 20, sharePaths),
      managedRuleGroup('AWSManagedRulesCommonRuleSet', 40, {
        countOverrides: waf.commonRuleSetCountOverrides,
      }),
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
      customResponseBodies,
      associationConfig,
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
