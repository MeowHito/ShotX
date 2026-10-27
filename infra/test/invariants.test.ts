import {
  CONTENT_DISPOSITION_QUERY_PARAM,
  LATEST_CONSENT_POLICY_VERSION,
  QUEUE_NAMES,
  QUEUE_VISIBILITY_TIMEOUT_ENV,
  S3_PREFIXES,
  SCHEDULED_JOB_TYPES,
  SQS_MAX_VISIBILITY_TIMEOUT_SECONDS,
  TMP_LIFECYCLE_MAX_DAYS,
} from '@shotx/shared';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { faceSearchLimits, facesQueueWorstCase, zipLifetime } from '../lib/config';
import { EDGE_REGION, PRIMARY_REGION } from '../lib/constants';
import { heartbeatQueueIssues } from '../lib/face-limits';
import { minZipExpirationDays } from '../lib/worker-limits';
import { collect, resourcesOfType, synthPlatform } from './helpers';

type Json = Record<string, unknown>;

// One synth for the whole file: CDK synthesis is the slow part.
const s = synthPlatform();
const { platform } = s;
const app = s.template(platform.app);
const edge = s.template(platform.edge);

const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad';

function mainDistributionConfig(): Json {
  const [dist] = Object.values(
    app.findResources('AWS::CloudFront::Distribution', {
      Properties: { DistributionConfig: { Aliases: [s.config.domain.main] } },
    }),
  );
  return ((dist as Json).Properties as Json).DistributionConfig as Json;
}

function behaviour(pathPattern: string): Json {
  const behaviours = mainDistributionConfig().CacheBehaviors as Json[];
  const b = behaviours.find((x) => x.PathPattern === pathPattern);
  if (b === undefined) throw new Error(`no ${pathPattern} behaviour`);
  return b;
}

function container(service: string): Json {
  const [td] = Object.values(
    app.findResources('AWS::ECS::TaskDefinition', {
      Properties: { Family: `shotx-prod-${service}` },
    }),
  );
  if (td === undefined) throw new Error(`no ${service} task definition`);
  return ((td.Properties as Json).ContainerDefinitions as Json[])[0] as Json;
}

type NameValue = { Name: string; Value?: unknown; ValueFrom?: unknown };
function containerEnv(service: string): Record<string, unknown> {
  const env = (container(service).Environment ?? []) as NameValue[];
  return Object.fromEntries(env.map((e) => [e.Name, e.Value]));
}
function containerSecrets(service: string): Record<string, unknown> {
  const secrets = (container(service).Secrets ?? []) as NameValue[];
  return Object.fromEntries(secrets.map((e) => [e.Name, e.ValueFrom]));
}

describe('regions', () => {
  it('deploys everything to ap-southeast-1 except the us-east-1 edge and pricing-plan stacks', () => {
    const edgeStacks = [platform.edge, platform.pricingPlan];
    for (const stack of s.stacks) {
      expect(stack.region, stack.stackName).toBe(
        edgeStacks.includes(stack) ? EDGE_REGION : PRIMARY_REGION,
      );
      expect(stack.account).toBe(s.config.account);
    }
    expect(platform.pricingPlan).toBeDefined();
  });

  it('creates CloudFront WAF web ACLs and ACM certificates only in us-east-1', () => {
    for (const [stackName] of [
      ...resourcesOfType(s, 'AWS::WAFv2::WebACL'),
      ...resourcesOfType(s, 'AWS::CertificateManager::Certificate'),
    ]) {
      expect(stackName).toBe(platform.edge.stackName);
    }
    edge.resourceCountIs('AWS::WAFv2::WebACL', 2);
    edge.allResourcesProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' });
  });

  it('reads edge resources through cross-region stack outputs', () => {
    const webAclIds = collect(app.toJSON(), 'WebACLId');
    expect(webAclIds).toHaveLength(2);
    for (const id of webAclIds) {
      expect(id).toMatchObject({
        'Fn::GetStackOutput': { Region: EDGE_REGION, StackName: platform.edge.stackName },
      });
    }
  });
});

describe('S3 buckets are never public', () => {
  const buckets = resourcesOfType(s, 'AWS::S3::Bucket');

  it('turns on every Block Public Access setting for every bucket', () => {
    expect(buckets.length).toBeGreaterThanOrEqual(2);
    for (const [, id, props] of buckets) {
      expect(props.PublicAccessBlockConfiguration, id).toEqual({
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      });
      expect(props.AccessControl, id).toBeUndefined();
      expect(props.WebsiteConfiguration, id).toBeUndefined();
    }
  });

  it('never allows a wildcard principal in a bucket policy', () => {
    for (const [, id, props] of resourcesOfType(s, 'AWS::S3::BucketPolicy')) {
      const statements = (props.PolicyDocument as { Statement: Json[] }).Statement;
      for (const st of statements.filter((x) => x.Effect === 'Allow')) {
        expect(JSON.stringify(st.Principal), id).not.toMatch(/"\*"/);
      }
    }
  });

  it('disables ACLs on the media bucket and encrypts it', () => {
    app.hasResourceProperties('AWS::S3::Bucket', {
      OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      BucketEncryption: Match.objectLike({}),
      LifecycleConfiguration: Match.anyValue(),
    });
  });
});

describe('S3 lifecycle rules', () => {
  const rules = (() => {
    const [bucket] = Object.values(
      app.findResources('AWS::S3::Bucket', {
        Properties: { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } },
      }),
    );
    return (((bucket as Json).Properties as Json).LifecycleConfiguration as { Rules: Json[] })
      .Rules;
  })();

  it('aborts incomplete multipart uploads after 2 days', () => {
    expect(rules).toContainEqual(
      expect.objectContaining({
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 },
        Status: 'Enabled',
      }),
    );
  });

  const expiry = (prefix: string): number => {
    const r = rules.find((x) => x.Prefix === prefix);
    expect(r?.Status, prefix).toBe('Enabled');
    return r?.ExpirationInDays as number;
  };

  it('has no tmp/index/ rule: IndexFaces gets bytes, nothing is written there', () => {
    expect(rules.some((r) => r.Prefix === 'tmp/index/')).toBe(false);
  });

  it('keeps tmp/zips/ for ZIP_RESULT_TTL_SECONDS plus the zip cap and the last download URL', () => {
    const lifetime = zipLifetime(s.config);
    expect(lifetime.resultTtlSeconds).toBe(86_400);
    expect(expiry('tmp/zips/') * 86_400).toBeGreaterThanOrEqual(lifetime.seconds);
    expect(expiry('tmp/zips/')).toBeGreaterThanOrEqual(minZipExpirationDays(lifetime));
  });

  it('expires tmp/reconcile/ (reconciliation scan files) after 3 days', () => {
    expect(S3_PREFIXES.tmpReconcile).toBe('tmp/reconcile/');
    expect(expiry('tmp/reconcile/')).toBe(3);
  });

  it('expires everything under tmp/ within the spec’s 1-3 days (ADR 0006)', () => {
    const tmpRules = rules.filter(
      (r) => typeof r.Prefix === 'string' && r.Prefix.startsWith('tmp/'),
    );
    expect(tmpRules).toHaveLength(3);
    for (const r of tmpRules) {
      expect(r.ExpirationInDays as number, String(r.Prefix)).toBeGreaterThanOrEqual(1);
      expect(r.ExpirationInDays as number, String(r.Prefix)).toBeLessThanOrEqual(
        TMP_LIFECYCLE_MAX_DAYS,
      );
    }
    expect(TMP_LIFECYCLE_MAX_DAYS).toBe(3);
  });

  it('has no tmp/ rule shorter than a more specific one (S3 applies the shortest match)', () => {
    const tmpRules = rules.filter(
      (r) => typeof r.Prefix === 'string' && r.Prefix.startsWith('tmp/'),
    );
    expect(tmpRules.map((r) => r.Prefix).sort()).toEqual(['tmp/', 'tmp/reconcile/', 'tmp/zips/']);
    for (const general of tmpRules) {
      for (const specific of tmpRules) {
        if ((specific.Prefix as string).startsWith(general.Prefix as string)) {
          expect(
            general.ExpirationInDays as number,
            `${String(general.Prefix)} vs ${String(specific.Prefix)}`,
          ).toBeGreaterThanOrEqual(specific.ExpirationInDays as number);
        }
      }
    }
  });

  it('moves originals/ to Intelligent-Tiering', () => {
    const originals = rules.find((r) => r.Prefix === 'originals/');
    expect(originals?.Transitions).toContainEqual(
      expect.objectContaining({ StorageClass: 'INTELLIGENT_TIERING' }),
    );
  });
});

describe('CloudFront', () => {
  it('uses Origin Access Control, never an Origin Access Identity', () => {
    app.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: { OriginAccessControlOriginType: 's3', SigningBehavior: 'always' },
    });
    for (const stack of s.stacks) {
      s.template(stack).resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
    }
    const s3Origins = (mainDistributionConfig().Origins as Json[]).filter(
      (o) => o.S3OriginConfig !== undefined,
    );
    expect(s3Origins).toHaveLength(1);
    expect(s3Origins[0]).toMatchObject({ S3OriginConfig: { OriginAccessIdentity: '' } });
    expect(s3Origins[0]?.OriginAccessControlId).toBeDefined();
  });

  it('lets only the main distribution read only the served prefixes', () => {
    const oacStatements = resourcesOfType(s, 'AWS::S3::BucketPolicy')
      .flatMap(([, , p]) => (p.PolicyDocument as { Statement: Json[] }).Statement)
      .filter((st) => JSON.stringify(st.Principal).includes('cloudfront.amazonaws.com'));
    expect(oacStatements).toHaveLength(1);
    const st = oacStatements[0] as Json;
    expect(st.Action).toBe('s3:GetObject');
    expect(JSON.stringify(st.Condition)).toContain('AWS:SourceArn');
    const resources = JSON.stringify(st.Resource);
    for (const prefix of s.config.cdn.media.readablePrefixes)
      expect(resources).toContain(`/${prefix}*`);
    expect(resources).not.toContain('tmp/reconcile');
    expect(resources).not.toMatch(/tmp\/\*/);
    expect(resources).not.toMatch(/"\/\*"/);
  });

  it('requires signed URLs on /media/* and strips the prefix', () => {
    const media = behaviour('/media/*');
    expect(media.TrustedKeyGroups).toHaveLength(1);
    expect(media.ViewerProtocolPolicy).toBe('https-only');
    expect(media.FunctionAssociations).toEqual([
      expect.objectContaining({ EventType: 'viewer-request' }),
    ]);
    app.resourceCountIs('AWS::CloudFront::KeyGroup', 1);
  });

  it('forwards response-content-disposition to S3 and keys the /media/* cache on it', () => {
    const media = behaviour('/media/*');
    // A cache policy's query strings are both in the cache key and forwarded to the origin; an
    // origin request policy is the only other way to forward one, and /media/* has none.
    expect(media.OriginRequestPolicyId).toBeUndefined();
    const [policyId] = collect(media.CachePolicyId, 'Ref') as string[];
    const policy = app.findResources('AWS::CloudFront::CachePolicy')[policyId as string];
    const params = ((policy?.Properties as Json).CachePolicyConfig as Json)
      .ParametersInCacheKeyAndForwardedToOrigin as Json;
    expect(params.QueryStringsConfig).toEqual({
      QueryStringBehavior: 'whitelist',
      QueryStrings: [CONTENT_DISPOSITION_QUERY_PARAM],
    });
    expect(CONTENT_DISPOSITION_QUERY_PARAM).toBe('response-content-disposition');
    // The viewer-request function rewrites the path only, never the query string.
    const [fn] = Object.values(app.findResources('AWS::CloudFront::Function'));
    expect(JSON.stringify(fn)).not.toMatch(/querystring/i);
  });

  it('never caches /api/* and sends the default behaviour to the web app', () => {
    expect(behaviour('/api/*').CachePolicyId).toBe(CACHING_DISABLED);
    const config = mainDistributionConfig();
    const defaultOrigin = (config.Origins as Json[]).find(
      (o) => o.Id === (config.DefaultCacheBehavior as Json).TargetOriginId,
    );
    expect(defaultOrigin?.VpcOriginConfig).toBeDefined();
    expect(defaultOrigin?.OriginCustomHeaders).toEqual([
      { HeaderName: 'X-ShotX-App', HeaderValue: 'web' },
    ]);
  });

  describe('client address (CloudFront-Viewer-Address)', () => {
    const distributions = Object.values(app.findResources('AWS::CloudFront::Distribution')).map(
      (d) => (d.Properties as Json).DistributionConfig as Json,
    );
    const policyConfig = (id: unknown): Json => {
      const [ref] = collect(id, 'Ref') as string[];
      const policy = app.findResources('AWS::CloudFront::OriginRequestPolicy')[ref as string];
      if (policy === undefined) throw new Error(`no origin request policy ${JSON.stringify(id)}`);
      return (policy.Properties as Json).OriginRequestPolicyConfig as Json;
    };
    const dynamicBehaviours = distributions.flatMap((d) => [
      ['default', d.DefaultCacheBehavior as Json] as const,
      [
        '/api/*',
        (d.CacheBehaviors as Json[]).find((b) => b.PathPattern === '/api/*') as Json,
      ] as const,
    ]);

    it('forwards it to the API and the apps, on both distributions', () => {
      expect(distributions).toHaveLength(2);
      expect(dynamicBehaviours).toHaveLength(4);
      for (const [label, b] of dynamicBehaviours) {
        const config = policyConfig(b.OriginRequestPolicyId);
        expect(config.HeadersConfig, label).toEqual({
          HeaderBehavior: 'allViewerAndWhitelistCloudFront',
          Headers: ['CloudFront-Viewer-Address'],
        });
        // Still every viewer cookie and query string, as with ALL_VIEWER.
        expect(config.CookiesConfig, label).toEqual({ CookieBehavior: 'all' });
        expect(config.QueryStringsConfig, label).toEqual({ QueryStringBehavior: 'all' });
      }
    });

    it('no longer uses the managed ALL_VIEWER policy, which omits it', () => {
      const ALL_VIEWER = '216adef6-5c7f-47e4-b989-5492eafa07d3';
      expect(JSON.stringify(app.toJSON())).not.toContain(ALL_VIEWER);
      expect(behaviour('/api/*').CachePolicyId).toBe(CACHING_DISABLED);
    });

    it('reaches the API only through CloudFront or the web and admin tasks', () => {
      const [albSgId] = Object.keys(
        app.findResources('AWS::EC2::SecurityGroup', {
          Properties: { GroupDescription: Match.stringLikeRegexp('Internal ALB') },
        }),
      );
      const sources = Object.values(app.findResources('AWS::EC2::SecurityGroupIngress'))
        .map((r) => r.Properties as Json)
        .filter((p) => JSON.stringify(p.GroupId).includes(`"${albSgId}"`))
        .map((p) =>
          p.SourcePrefixListId !== undefined
            ? `prefix-list ${p.SourcePrefixListId as string}`
            : `sg ${String(collect(p.SourceSecurityGroupId, 'Fn::GetAtt')[0]).split(',')[0]}`,
        )
        .sort();
      expect(sources).toEqual([
        `prefix-list ${s.config.network.cloudFrontOriginFacingPrefixListId}`,
        expect.stringMatching(/^sg ServicesadminSg/),
        expect.stringMatching(/^sg ServiceswebSg/),
      ]);
    });
  });

  it('only uses flat-rate compatible features', () => {
    const json = JSON.stringify(app.toJSON());
    expect(json).not.toContain('ForwardedValues');
    for (const stack of s.stacks)
      s.template(stack).resourceCountIs('AWS::CloudFront::RealtimeLogConfig', 0);
    for (const stack of s.stacks) s.template(stack).resourceCountIs('AWS::WAFv2::RuleGroup', 0);
    // Standard access logs on both distributions, without cookies.
    app.allResourcesProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        Logging: Match.objectLike({ IncludeCookies: false }),
      }),
    });
    // Each distribution has its own web ACL (plan resources can't be shared).
    const acls = collect(app.toJSON(), 'WebACLId').map((x) => JSON.stringify(x));
    expect(new Set(acls).size).toBe(2);
  });

  it('subscribes the main distribution to the Business flat-rate plan', () => {
    if (platform.pricingPlan === undefined) throw new Error('pricing plan stack missing');
    const plan = s.template(platform.pricingPlan);
    plan.hasResourceProperties('AWS::PricingPlanManager::Subscription', {
      PlanFamily: 'CloudFront',
      PlanTier: 'BUSINESS',
    });
    const [sub] = Object.values(plan.findResources('AWS::PricingPlanManager::Subscription'));
    const arns = JSON.stringify(((sub as Json).Properties as Json).ResourceArns);
    // The distribution comes from the App stack (ap-southeast-1), the web ACL from the Edge stack.
    expect(arns).toContain('arn:aws:cloudfront::');
    expect(arns).toContain(`"StackName":"${platform.app.stackName}"`);
    expect(arns).toContain(`"StackName":"${platform.edge.stackName}"`);
  });
});

// WAF rules are evaluated against request variants in waf.test.ts.

describe('/media/* response headers', () => {
  const media = behaviour('/media/*');
  const [policyId] = collect(media.ResponseHeadersPolicyId, 'Ref') as string[];
  const policy = (() => {
    const resources = app.findResources('AWS::CloudFront::ResponseHeadersPolicy');
    const r = policyId === undefined ? undefined : resources[policyId];
    if (r === undefined) throw new Error('/media/* has no custom response headers policy');
    return (r.Properties as Json).ResponseHeadersPolicyConfig as Json;
  })();
  const security = policy.SecurityHeadersConfig as Json;
  const expected = s.config.cdn.media.responseHeaders;

  it('sends nosniff, HSTS, a sandboxing CSP and a referrer policy', () => {
    expect(security.ContentTypeOptions).toEqual({ Override: true });
    expect(security.StrictTransportSecurity).toMatchObject({
      AccessControlMaxAgeSec: expected.hstsMaxAgeSeconds,
      Override: true,
    });
    expect(expected.hstsMaxAgeSeconds).toBeGreaterThanOrEqual(31_536_000);
    const csp = (security.ContentSecurityPolicy as Json).ContentSecurityPolicy as string;
    expect((security.ContentSecurityPolicy as Json).Override).toBe(true);
    const directives = csp.split(';').map((d) => d.trim());
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain('sandbox');
    expect(csp).not.toMatch(/allow-|script-src|unsafe/);
    expect(security.ReferrerPolicy).toEqual({
      ReferrerPolicy: expected.referrerPolicy,
      Override: true,
    });
  });

  it('keeps media usable in <img>, PhotoSwipe and attachment downloads', () => {
    // Nothing that blocks cross-context embedding or rewrites the object's own headers.
    expect(policy.CustomHeadersConfig).toBeUndefined();
    expect(policy.RemoveHeadersConfig).toBeUndefined();
    expect(security.FrameOptions).toBeUndefined();
    expect(JSON.stringify(policy)).not.toMatch(
      /Content-Disposition|Content-Type"|Cross-Origin-(Resource|Embedder)-Policy/i,
    );
    // response-content-disposition still reaches S3 and is part of the cache key.
    const cachePolicy = Object.values(
      app.findResources('AWS::CloudFront::CachePolicy', {
        Properties: { CachePolicyConfig: { Name: 'shotx-prod-media' } },
      }),
    )[0] as Json;
    expect(JSON.stringify(cachePolicy)).toContain('response-content-disposition');
    expect(media.AllowedMethods).toEqual(['GET', 'HEAD']);
  });

  it('allows CORS reads from any origin, never with credentials, GET and HEAD only', () => {
    expect(policy.CorsConfig).toEqual({
      AccessControlAllowOrigins: { Items: ['*'] },
      AccessControlAllowMethods: { Items: ['GET', 'HEAD'] },
      AccessControlAllowHeaders: { Items: ['Range'] },
      AccessControlAllowCredentials: false,
      OriginOverride: true,
    });
  });

  /**
   * A media URL opened in its own tab becomes a synthetic media document carrying these headers;
   * its <video> fetches the same URL again. Verified in Chrome 156 (infra/README.md, "Media
   * opened in a new tab"): with `default-src 'none'; sandbox` the fetch is blocked by CSP
   * (media-src falls back to default-src); with `media-src 'self'` but no CORS it fails the CORS
   * check, because the sandboxed document's origin is opaque. This models those two rules.
   */
  describe('media opened in a new tab', () => {
    const csp = (security.ContentSecurityPolicy as Json).ContentSecurityPolicy as string;
    const directives = new Map(
      csp
        .split(';')
        .map((d) => d.trim().split(/\s+/))
        .filter((tokens) => tokens[0] !== '')
        .map(([name = '', ...values]) => [name.toLowerCase(), values]),
    );
    /** CSP3 fallback for fetch directives: media-src, else default-src, else allow. */
    const effective = (directive: string) =>
      directives.get(directive) ?? directives.get('default-src');
    const cors = policy.CorsConfig as
      | { AccessControlAllowOrigins: { Items: string[] }; AccessControlAllowCredentials: boolean }
      | undefined;

    it("lets the media document load its own URL (media-src 'self')", () => {
      expect(effective('media-src')).toEqual(["'self'"]);
    });

    it('keeps the document sandboxed: no scripts, opaque origin, nothing else loadable', () => {
      expect(directives.get('sandbox')).toEqual([]);
      expect(effective('script-src')).toEqual(["'none'"]);
      for (const d of [
        'img-src',
        'style-src',
        'font-src',
        'connect-src',
        'frame-src',
        'object-src',
      ]) {
        expect(effective(d), d).toEqual(["'none'"]);
      }
    });

    it("answers the opaque origin's CORS-mode video fetch (Origin: null) without credentials", () => {
      expect(cors?.AccessControlAllowOrigins.Items).toContain('*');
      expect(cors?.AccessControlAllowCredentials).toBe(false);
    });
  });

  it('is used by /media/* only; pages keep the managed security headers policy', () => {
    for (const b of [behaviour('/api/*'), behaviour('/_next/static/*')]) {
      expect(JSON.stringify(b.ResponseHeadersPolicyId)).not.toContain(policyId);
    }
  });
});

describe('SQS', () => {
  const queues = app.findResources('AWS::SQS::Queue');
  const dlqLogicalIds = new Set(
    Object.values(queues).flatMap((q) =>
      collect((q.Properties as Json).RedrivePolicy, 'deadLetterTargetArn').flatMap((arn) =>
        collect(arn, 'Fn::GetAtt').map((g) => (g as string[])[0]),
      ),
    ),
  );

  it('gives every queue a dead-letter queue', () => {
    const mainQueues = Object.entries(queues).filter(([id]) => !dlqLogicalIds.has(id));
    expect(mainQueues).toHaveLength(QUEUE_NAMES.length);
    expect(dlqLogicalIds.size).toBe(QUEUE_NAMES.length);
    for (const [id, q] of mainQueues) {
      expect((q.Properties as Json).RedrivePolicy, id).toMatchObject({
        deadLetterTargetArn: expect.anything() as unknown,
        maxReceiveCount: expect.any(Number) as unknown,
      });
    }
  });

  it('alarms on every dead-letter queue', () => {
    const alarmedQueues = new Set(
      Object.values(app.findResources('AWS::CloudWatch::Alarm'))
        .map((a) => a.Properties as Json)
        .filter((p) => p.MetricName === 'ApproximateNumberOfMessagesVisible')
        .flatMap((p) => collect(p.Dimensions, 'Value'))
        .flatMap((v) => collect(v, 'Fn::GetAtt').map((g) => (g as string[])[0])),
    );
    for (const dlq of dlqLogicalIds) expect(alarmedQueues.has(dlq), dlq).toBe(true);
  });

  const queueProps = (name: string) => {
    const [q] = Object.values(
      app.findResources('AWS::SQS::Queue', { Properties: { QueueName: `shotx-prod-${name}` } }),
    );
    return (q as Json).Properties as Json;
  };

  it('sets every visibility timeout from context and passes it to the worker', () => {
    const env = containerEnv('worker');
    for (const q of QUEUE_NAMES) {
      const visibility = queueProps(q).VisibilityTimeout as number;
      expect(visibility, q).toBe(s.config.queues[q].visibilityTimeoutSeconds);
      expect(visibility, q).toBeGreaterThanOrEqual(60);
      expect(env[QUEUE_VISIBILITY_TIMEOUT_ENV[q]], q).toBe(String(visibility));
    }
  });

  it('heartbeats faces jobs: 600-900 s timeout, worst case within 12 h, receives and retention', () => {
    const faces = queueProps('faces');
    const visibility = faces.VisibilityTimeout as number;
    expect(visibility).toBeGreaterThanOrEqual(600);
    expect(visibility).toBeLessThanOrEqual(900);
    const worst = facesQueueWorstCase(s.config).seconds;
    // A job may outlive the timeout (heartbeats), but not SQS's 12 h cap.
    expect(worst).toBeGreaterThan(visibility);
    expect(worst).toBeLessThanOrEqual(SQS_MAX_VISIBILITY_TIMEOUT_SECONDS);
    const maxReceiveCount = (faces.RedrivePolicy as Json).maxReceiveCount as number;
    expect(maxReceiveCount * visibility).toBeGreaterThanOrEqual(worst);
    expect(
      heartbeatQueueIssues(
        {
          visibilityTimeoutSeconds: visibility,
          maxReceiveCount,
          retentionDays: (faces.MessageRetentionPeriod as number) / 86_400,
        },
        worst,
        'faces',
      ),
    ).toEqual([]);
  });

  it('lets the worker heartbeat faces jobs with ChangeMessageVisibility', () => {
    const [facesId] = Object.keys(
      app.findResources('AWS::SQS::Queue', { Properties: { QueueName: 'shotx-prod-faces' } }),
    );
    const statements = Object.entries(app.findResources('AWS::IAM::Policy'))
      .filter(([id]) => id.includes('workerTask'))
      .flatMap(
        ([, p]) => ((p.Properties as Json).PolicyDocument as { Statement: Json[] }).Statement,
      );
    const heartbeat = statements.filter(
      (st) =>
        ([] as unknown[]).concat(st.Action).includes('sqs:ChangeMessageVisibility') &&
        JSON.stringify(st.Resource).includes(`"${facesId}"`),
    );
    expect(heartbeat).toHaveLength(1);
    // The worker learns each queue's timeout from its environment.
    expect(containerEnv('worker').FACES_QUEUE_VISIBILITY_TIMEOUT_SECONDS).toBe(
      String(s.config.queues.faces.visibilityTimeoutSeconds),
    );
  });

  it('starts the media pipeline only for originals/', () => {
    app.hasResourceProperties('Custom::S3BucketNotifications', {
      NotificationConfiguration: {
        QueueConfigurations: [
          Match.objectLike({
            Events: ['s3:ObjectCreated:*'],
            Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'originals/' }] } },
          }),
        ],
      },
    });
  });
});

describe('data stores', () => {
  const data = s.template(platform.data);

  it('runs RDS PostgreSQL Multi-AZ, encrypted, private, TLS only', () => {
    data.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      MultiAZ: true,
      StorageEncrypted: true,
      PubliclyAccessible: false,
    });
    data.hasResourceProperties('AWS::RDS::DBParameterGroup', {
      Parameters: { 'rds.force_ssl': '1' },
    });
  });

  it('runs Redis Multi-AZ with failover and TLS', () => {
    data.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
      MultiAZEnabled: true,
      AutomaticFailoverEnabled: true,
      TransitEncryptionEnabled: true,
      AtRestEncryptionEnabled: true,
    });
  });

  describe('Redis memory (ADR 0005)', () => {
    it('never evicts: a custom redis7 parameter group with maxmemory-policy noeviction', () => {
      const groups = Object.entries(data.findResources('AWS::ElastiCache::ParameterGroup'));
      expect(groups).toHaveLength(1);
      const [groupId, group] = groups[0] as [string, Json];
      expect(group.Properties).toMatchObject({
        CacheParameterGroupFamily: `redis${s.config.redis.engineVersion.split('.')[0]}`,
        Properties: { 'maxmemory-policy': 'noeviction' },
      });
      data.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', {
        CacheParameterGroupName: { Ref: groupId },
      });
    });

    it('alarms to the alarm topic when the fullest node passes the memory threshold', () => {
      const alarms = Object.values(app.findResources('AWS::CloudWatch::Alarm'))
        .map((a) => a.Properties as Json)
        .filter((p) => collect(p.Metrics, 'MetricName').includes('DatabaseMemoryUsagePercentage'));
      expect(alarms).toHaveLength(1);
      const alarm = alarms[0] as Json;
      expect(alarm).toMatchObject({
        Threshold: s.config.redis.alarms.memoryUsagePercentThreshold,
        EvaluationPeriods: s.config.redis.alarms.evaluationPeriods,
        ComparisonOperator: 'GreaterThanThreshold',
      });
      expect(s.config.redis.alarms.memoryUsagePercentThreshold).toBe(75);
      expect(JSON.stringify(alarm.AlarmActions)).toMatch(/"Ref":"AlarmTopic/);
      // One series per node (<id>-001 ...), from the Data stack's replication group.
      const nodes = (alarm.Metrics as Json[]).filter((m) => m.MetricStat !== undefined);
      expect(nodes).toHaveLength(s.config.redis.numCacheClusters);
      nodes.forEach((m, i) => {
        const dims = JSON.stringify(m);
        expect(dims).toContain(`"-00${i + 1}"`);
        expect(dims).toContain(`"StackName":"${platform.data.stackName}"`);
        expect(dims).toContain('"Namespace":"AWS/ElastiCache"');
      });
      expect(JSON.stringify(alarm.Metrics)).toContain(
        `MAX([${nodes.map((m) => m.Id as string).join(', ')}])`,
      );
    });
  });

  describe('Redis authentication (RBAC)', () => {
    const users: (Json & { id: string })[] = Object.entries(
      data.findResources('AWS::ElastiCache::User'),
    ).map(([id, r]) => ({ id, ...(r.Properties as Json) }));
    const groups = Object.values(data.findResources('AWS::ElastiCache::UserGroup')).map(
      (r) => r.Properties as Json,
    );
    const [replicationGroup] = Object.values(
      data.findResources('AWS::ElastiCache::ReplicationGroup'),
    ).map((r) => r.Properties as Json);

    it('attaches exactly one user group to the replication group', () => {
      expect(groups).toHaveLength(1);
      expect(replicationGroup?.UserGroupIds).toEqual([groups[0]?.UserGroupId]);
      expect(replicationGroup?.AuthToken).toBeUndefined();
      expect(replicationGroup?.TransitEncryptionEnabled).toBe(true);
    });

    it('disables the default user', () => {
      const group = groups[0] as Json;
      const members = users.filter((u) => (group.UserIds as unknown[]).includes(u.UserId));
      expect(members).toHaveLength((group.UserIds as unknown[]).length);
      const defaults = members.filter((u) => u.UserName === 'default');
      expect(defaults).toHaveLength(1);
      expect(String(defaults[0]?.AccessString)).toMatch(/^off\b/);
      expect(String(defaults[0]?.AccessString)).toContain('-@all');
    });

    it('gives api and worker one password user whose password lives in Secrets Manager', () => {
      const app = users.filter((u) => u.UserName === s.config.redis.username);
      expect(app).toHaveLength(1);
      expect(String(app[0]?.AccessString)).toMatch(/^on\b/);
      // FLUSHALL, KEYS, CONFIG, ... are denied (redis-acl.integration.test.ts checks the commands).
      expect(String(app[0]?.AccessString)).toMatch(/ \+@all -@dangerous$/);
      expect((groups[0]?.UserIds as unknown[]).includes(app[0]?.UserId)).toBe(true);
      for (const u of users) {
        expect(u.NoPasswordRequired, u.id).not.toBe(true);
        expect(u.Passwords, u.id).toBeUndefined();
        const mode = u.AuthenticationMode as { Type: string; Passwords: unknown[] };
        expect(mode.Type, u.id).toBe('password');
        expect(mode.Passwords, u.id).toHaveLength(1);
        // Only a dynamic reference, never a literal password.
        expect(JSON.stringify(mode.Passwords), u.id).toMatch(
          /^\[\{"Fn::Join":\["",\["\{\{resolve:secretsmanager:",\{"Ref":"[^"]+"\},":SecretString:password::\}\}"\]\]\}\]$/,
        );
      }
    });

    it('passes the credentials to api and worker as ECS secrets, not in REDIS_URL', () => {
      for (const service of ['api', 'worker']) {
        const secrets = containerSecrets(service);
        for (const [name, key] of [
          ['REDIS_USERNAME', 'username'],
          ['REDIS_PASSWORD', 'password'],
        ] as const) {
          const valueFrom = JSON.stringify(secrets[name]);
          expect(valueFrom, `${service} ${name}`).toContain(`:${key}::`);
          expect(valueFrom, `${service} ${name}`).toContain(
            `"StackName":"${platform.data.stackName}"`,
          );
          expect(valueFrom, `${service} ${name}`).toMatch(/RedisAppUserSecret/);
        }
        const url = JSON.stringify(containerEnv(service).REDIS_URL);
        expect(url).toContain('rediss://');
        expect(url).not.toContain('@');
        expect(containerEnv(service).REDIS_PASSWORD).toBeUndefined();
      }
      for (const service of ['web', 'admin']) {
        const names = [
          ...Object.keys(containerSecrets(service)),
          ...Object.keys(containerEnv(service)),
        ];
        expect(
          names.filter((n) => n.startsWith('REDIS_')),
          service,
        ).toEqual([]);
      }
    });
  });

  it('opens PostgreSQL and Redis to the api and worker tasks only', () => {
    const ingress = Object.values(app.findResources('AWS::EC2::SecurityGroupIngress')).map(
      (r) => r.Properties as Json,
    );
    const toData = ingress.filter((p) =>
      JSON.stringify(p.GroupId).includes(`"StackName":"${platform.data.stackName}"`),
    );
    expect(toData).toHaveLength(4);
    const sources = toData.map((p) => JSON.stringify(p.SourceSecurityGroupId));
    expect(sources.filter((x) => x.includes('apiSg'))).toHaveLength(2);
    expect(sources.filter((x) => x.includes('workerSg'))).toHaveLength(2);
  });
});

describe('ECS', () => {
  it('runs web, admin, api and worker on Fargate', () => {
    app.resourceCountIs('AWS::ECS::Service', 4);
    for (const name of ['web', 'admin', 'api', 'worker']) {
      app.hasResourceProperties('AWS::ECS::Service', { ServiceName: name, LaunchType: 'FARGATE' });
    }
  });

  it('scales the worker on queue depth', () => {
    app.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      PolicyType: 'StepScaling',
      ScalingTargetId: Match.objectLike({ Ref: Match.stringLikeRegexp('worker') }),
    });
    const queueAlarms = Object.values(app.findResources('AWS::CloudWatch::Alarm'))
      .map((a) => a.Properties as Json)
      .filter(
        (p) => Array.isArray(p.Metrics) && collect(p.Metrics, 'Namespace').includes('AWS/SQS'),
      );
    expect(queueAlarms.length).toBe(2);
    for (const alarm of queueAlarms) {
      const namespaces = collect(alarm.Metrics, 'Namespace');
      expect(namespaces.length).toBe(QUEUE_NAMES.length * 2);
      expect(new Set(namespaces)).toEqual(new Set(['AWS/SQS']));
    }
  });

  it('gives the api the face-search byte limits that the WAF enforces', () => {
    const limits = faceSearchLimits(s.config);
    expect(containerEnv('api').FACE_SEARCH_MAX_BODY_BYTES).toBe(String(limits.maxBodyBytes));
    expect(containerEnv('api').FACE_SEARCH_MAX_SELFIE_BYTES).toBe(String(limits.selfieMaxBytes));
  });

  it('gives the worker a stop timeout above WORKER_SHUTDOWN_GRACE_SECONDS (20 s + 10 s)', () => {
    expect(container('worker').StopTimeout).toBe(30);
    for (const name of ['web', 'admin', 'api']) expect(container(name).StopTimeout).toBeUndefined();
  });

  it('passes FACE_SEARCH_ENABLED=false to api and worker, and the consent version to api', () => {
    for (const name of ['api', 'worker']) {
      expect(containerEnv(name).FACE_SEARCH_ENABLED, name).toBe('false');
    }
    expect(containerEnv('api').CONSENT_POLICY_VERSION).toBe(LATEST_CONSENT_POLICY_VERSION);
    for (const name of ['web', 'admin']) {
      expect(containerEnv(name).FACE_SEARCH_ENABLED, name).toBeUndefined();
    }
    const on = synthPlatform((c) => {
      (c.features as Json).faceSearchEnabled = true;
    });
    const onApp = on.template(on.platform.app);
    onApp.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Family: 'shotx-prod-worker',
      ContainerDefinitions: [
        Match.objectLike({
          Environment: Match.arrayWith([{ Name: 'FACE_SEARCH_ENABLED', Value: 'true' }]),
        }),
      ],
    });
  });

  it('gives the api a generated IP_HASH_SECRET of at least 32 characters, as an ECS secret', () => {
    const secrets = app.findResources('AWS::SecretsManager::Secret', {
      Properties: { Name: 'shotx-prod/ip-hash-secret' },
    });
    const [[secretId, secret]] = Object.entries(secrets) as [[string, Json]];
    const generate = (secret.Properties as Json).GenerateSecretString as Json;
    expect(generate.PasswordLength).toBe(64);
    expect(generate.PasswordLength as number).toBeGreaterThanOrEqual(32);
    expect(generate.ExcludePunctuation).toBe(true);
    expect(secret.DeletionPolicy).toBe('Retain');
    expect(JSON.stringify(containerSecrets('api').IP_HASH_SECRET)).toContain(`"${secretId}"`);
    expect(containerEnv('api').IP_HASH_SECRET).toBeUndefined();
    for (const name of ['web', 'admin', 'worker']) {
      expect(containerSecrets(name).IP_HASH_SECRET, name).toBeUndefined();
    }
  });

  it('passes MEDIA_BUCKET to web for its CSP connect-src', () => {
    const [bucketId] = Object.keys(
      app.findResources('AWS::S3::Bucket', {
        Properties: { OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] } },
      }),
    );
    expect(containerEnv('web').MEDIA_BUCKET).toEqual({ Ref: bucketId });
    expect(containerEnv('web').MEDIA_BUCKET).toEqual(containerEnv('api').MEDIA_BUCKET);
  });

  it('gives web and api the same UPLOAD_* overrides (common group)', () => {
    const edited = synthPlatform((c) => {
      ((c.services as Json).env as Json).common = { UPLOAD_PART_BYTES: '33554432' };
    });
    const t = edited.template(edited.platform.app);
    for (const name of ['web', 'api']) {
      t.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Family: `shotx-prod-${name}`,
        ContainerDefinitions: [
          Match.objectLike({
            Environment: Match.arrayWith([{ Name: 'UPLOAD_PART_BYTES', Value: '33554432' }]),
          }),
        ],
      });
    }
  });

  it('keeps the ALB internal and reachable only from the CloudFront origin-facing prefix list', () => {
    app.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internal' });
    const [albSgId] = Object.keys(
      app.findResources('AWS::EC2::SecurityGroup', {
        Properties: { GroupDescription: Match.stringLikeRegexp('Internal ALB') },
      }),
    );
    expect(albSgId).toBeDefined();
    const ingress = Object.values(app.findResources('AWS::EC2::SecurityGroupIngress'))
      .map((r) => r.Properties as Json)
      .filter((p) => JSON.stringify(p.GroupId).includes(`"${albSgId}"`));
    expect(ingress.length).toBeGreaterThan(0);
    expect(ingress.every((r) => r.CidrIp === undefined && r.CidrIpv6 === undefined)).toBe(true);
    expect(ingress).toContainEqual(
      expect.objectContaining({
        SourcePrefixListId: s.config.network.cloudFrontOriginFacingPrefixListId,
      }),
    );
  });
});

describe('IAM for Rekognition', () => {
  const policies = Object.entries(app.findResources('AWS::IAM::Policy')).map(([id, p]) => ({
    id,
    statements: ((p.Properties as Json).PolicyDocument as { Statement: Json[] }).Statement,
  }));
  const workerStatements = policies
    .filter((p) => p.id.includes('workerTask'))
    .flatMap((p) => p.statements);
  const has = (statements: Json[], action: string) =>
    statements.filter((st) => ([] as unknown[]).concat(st.Action).includes(action));

  it('lets the worker call IndexFaces only on pg-* collections', () => {
    const [st] = has(workerStatements, 'rekognition:IndexFaces');
    expect(JSON.stringify(st?.Resource)).toMatch(/:collection\/pg-\*/);
  });

  it('lets the worker list faces (reconciliation) only on pg-* collections', () => {
    const listing = has(workerStatements, 'rekognition:ListFaces');
    expect(listing).toHaveLength(1);
    expect(JSON.stringify(listing[0]?.Resource)).toMatch(/:collection\/pg-\*"/);
    expect(JSON.stringify(listing[0]?.Resource)).not.toMatch(/collection\/\*"/);
  });

  it('gives the worker nothing on tmp/index/: IndexFaces gets bytes (ADR 0008 section 5)', () => {
    expect(JSON.stringify(workerStatements)).not.toContain('tmp/index');
  });

  const apiStatements = policies
    .filter((p) => p.id.includes('apiTask'))
    .flatMap((p) => p.statements);

  /**
   * Allowed actions per resource: S3 object prefixes as "tmp/zips/*", the bucket as "bucket",
   * Rekognition collections as "collection". Merged statements (minimizePolicies) are split again.
   */
  function grants(statements: Json[]): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const st of statements) {
      expect(st.Effect).toBe('Allow');
      const resources = ([] as unknown[]).concat(st.Resource);
      for (const r of resources) {
        const json = JSON.stringify(r);
        const key = json.includes(':collection/')
          ? 'collection'
          : (/"\/([a-z/_-]*\*)"/.exec(json)?.[1] ??
            (json.includes('MediaBucket') ? 'bucket' : json));
        const set = out.get(key) ?? new Set<string>();
        for (const a of ([] as string[]).concat(st.Action as string[])) set.add(a);
        out.set(key, set);
      }
    }
    return out;
  }
  const sorted = (set: Set<string> | undefined) => [...(set ?? [])].sort();
  const workerGrants = grants(workerStatements);
  const apiGrants = grants(apiStatements);

  it('gives the worker exactly what each S3 prefix needs', () => {
    const media = ['s3:AbortMultipartUpload', 's3:DeleteObject', 's3:GetObject', 's3:PutObject'];
    // Plus ListParts on originals/ only: media.sweep recovers uploads the API failed to complete.
    expect(sorted(workerGrants.get('originals/*'))).toEqual(
      [...media, 's3:ListMultipartUploadParts'].sort(),
    );
    expect(sorted(workerGrants.get('derived/*'))).toEqual(media);
    // Zips: multipart Put and Abort only.
    expect(sorted(workerGrants.get('tmp/zips/*'))).toEqual([
      's3:AbortMultipartUpload',
      's3:PutObject',
    ]);
    expect(sorted(workerGrants.get('tmp/reconcile/*'))).toEqual([
      's3:DeleteObject',
      's3:GetObject',
      's3:PutObject',
    ]);
    expect(sorted(workerGrants.get('bucket'))).toEqual(['s3:ListBucket']);
    // Nothing on tmp/* as a whole.
    expect(workerGrants.has('tmp/*')).toBe(false);
    const s3Keys = [...workerGrants.keys()].filter((k) => k.endsWith('*'));
    expect(s3Keys.sort()).toEqual(['derived/*', 'originals/*', 'tmp/reconcile/*', 'tmp/zips/*']);
  });

  it('gives the worker indexing, deletion and reconciliation calls, but no selfie search', () => {
    const rekognition = sorted(workerGrants.get('collection'));
    expect(rekognition).toEqual([
      'rekognition:CreateCollection',
      'rekognition:DeleteCollection',
      'rekognition:DeleteFaces',
      'rekognition:DescribeCollection',
      'rekognition:IndexFaces',
      'rekognition:ListFaces',
      'rekognition:SearchFaces',
    ]);
  });

  it('gives the api search only: face deletion runs in the worker (delete.faces)', () => {
    expect(sorted(apiGrants.get('collection'))).toEqual([
      'rekognition:DescribeCollection',
      'rekognition:SearchFaces',
      'rekognition:SearchFacesByImage',
    ]);
  });

  it('lets the api presign uploads into originals/ and HeadObject derived/ only', () => {
    expect(sorted(apiGrants.get('originals/*'))).toEqual([
      's3:AbortMultipartUpload',
      's3:GetObject',
      's3:ListMultipartUploadParts',
      's3:PutObject',
    ]);
    // s3:GetObject is what authorises HeadObject.
    expect(sorted(apiGrants.get('derived/*'))).toEqual(['s3:GetObject']);
    const s3Keys = [...apiGrants.keys()].filter((k) => k.endsWith('*'));
    expect(s3Keys.sort()).toEqual(['derived/*', 'originals/*']);
  });

  it('lets the api send to the faces and zip queues only', () => {
    const queueIds = (name: string) =>
      Object.keys(
        app.findResources('AWS::SQS::Queue', { Properties: { QueueName: `shotx-prod-${name}` } }),
      );
    const sends = apiStatements
      .filter((st) => ([] as unknown[]).concat(st.Action).includes('sqs:SendMessage'))
      .map((st) => JSON.stringify(st.Resource))
      .join(' ');
    for (const q of ['faces', 'zip']) expect(sends, q).toContain(`"${queueIds(q)[0]}"`);
    for (const q of ['media', 'jobs']) expect(sends, q).not.toContain(`"${queueIds(q)[0]}"`);
  });

  it('lets the worker send to the media (media.sweep) and faces queues only', () => {
    const queueIds = (name: string) =>
      Object.keys(
        app.findResources('AWS::SQS::Queue', { Properties: { QueueName: `shotx-prod-${name}` } }),
      );
    const sends = workerStatements
      .filter((st) => ([] as unknown[]).concat(st.Action).includes('sqs:SendMessage'))
      .map((st) => JSON.stringify(st.Resource))
      .join(' ');
    for (const q of ['media', 'faces']) expect(sends, q).toContain(`"${queueIds(q)[0]}"`);
    for (const q of ['zip', 'jobs']) expect(sends, q).not.toContain(`"${queueIds(q)[0]}"`);
  });

  it('gives Rekognition permissions to no role other than api and worker', () => {
    const others = policies.filter(
      (p) => !p.id.includes('workerTask') && !p.id.includes('apiTask'),
    );
    expect(JSON.stringify(others)).not.toContain('rekognition:');
  });
});

describe('Cognito', () => {
  const auth = s.template(platform.auth);

  it('federates Google and LINE (OIDC) into the user pool', () => {
    auth.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'Google',
    });
    auth.hasResourceProperties('AWS::Cognito::UserPoolIdentityProvider', {
      ProviderType: 'OIDC',
      ProviderName: 'LINE',
      ProviderDetails: Match.objectLike({ oidc_issuer: 'https://access.line.me' }),
    });
  });

  it('requires MFA in the admin user pool', () => {
    auth.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'shotx-prod-admins',
      MfaConfiguration: 'ON',
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
  });
});

describe('scheduled jobs', () => {
  it('sends every job to the jobs queue on a Bangkok-time schedule', () => {
    app.resourceCountIs('AWS::Scheduler::Schedule', SCHEDULED_JOB_TYPES.length);
    const inputs = Object.values(app.findResources('AWS::Scheduler::Schedule')).map((r) => {
      const p = r.Properties as Json;
      expect(p.ScheduleExpressionTimezone).toBe('Asia/Bangkok');
      return JSON.parse((p.Target as Json).Input as string) as { type: string };
    });
    expect(inputs.map((i) => i.type).sort()).toEqual([...SCHEDULED_JOB_TYPES].sort());
  });

  it('runs faces.reconcile.daily at least 2 h after faces.expire.daily, once a day', () => {
    // Both delete faces (shared DeleteFaces rate limit); reconcile also picks up what a failed
    // expiry left behind.
    const minutes = (type: string) => {
      const m = /^cron\((\d+) (\d+) \* \* \? \*\)$/.exec(
        s.config.schedules.jobs[type as (typeof SCHEDULED_JOB_TYPES)[number]].expression,
      );
      if (m === null) throw new Error(`${type} is not a once-a-day cron`);
      return Number(m[2]) * 60 + Number(m[1]);
    };
    const gap = (minutes('faces.reconcile.daily') - minutes('faces.expire.daily') + 1440) % 1440;
    expect(gap).toBeGreaterThanOrEqual(120);
    expect(1440 - gap).toBeGreaterThanOrEqual(120);
  });
});

describe('synthesis', () => {
  it('has no errors in any stack', () => {
    for (const stack of s.stacks) {
      expect(
        Annotations.fromStack(stack).findError('*', Match.anyValue()),
        stack.stackName,
      ).toEqual([]);
    }
  });

  it('still works without a Route 53 zone when certificates are given', () => {
    const external = synthPlatform((c) => {
      const domain = c.domain as Json;
      domain.hostedZoneId = '';
      domain.hostedZoneName = '';
      domain.certificateArn =
        'arn:aws:acm:us-east-1:000000000000:certificate/11111111-2222-3333-4444-555555555555';
      domain.adminCertificateArn =
        'arn:aws:acm:us-east-1:000000000000:certificate/66666666-7777-8888-9999-000000000000';
    });
    external
      .template(external.platform.edge)
      .resourceCountIs('AWS::CertificateManager::Certificate', 0);
    external.template(external.platform.app).resourceCountIs('AWS::Route53::RecordSet', 0);
  });
});
