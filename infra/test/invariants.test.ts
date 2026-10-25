import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { EDGE_REGION, PRIMARY_REGION, QUEUE_NAMES, SCHEDULED_JOB_TYPES } from '../lib/constants';
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

  it('expires tmp/ after 1 to 3 days', () => {
    const tmp = rules.find((r) => r.Prefix === 'tmp/');
    expect(tmp?.Status).toBe('Enabled');
    expect(tmp?.ExpirationInDays).toBeGreaterThanOrEqual(1);
    expect(tmp?.ExpirationInDays).toBeLessThanOrEqual(3);
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
    expect(resources).not.toContain('tmp/index');
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

describe('WAF', () => {
  const mainRules = (() => {
    const [acl] = Object.values(
      edge.findResources('AWS::WAFv2::WebACL', { Properties: { Name: 'shotx-prod-main' } }),
    );
    return ((acl as Json).Properties as Json).Rules as Json[];
  })();
  const rateRules = mainRules.filter((r) => (r.Statement as Json).RateBasedStatement !== undefined);
  const scoped = (needle: string) =>
    rateRules.filter((r) => JSON.stringify(r.Statement).includes(`"SearchString":"${needle}"`));

  it('rate-limits /s/* with a CAPTCHA tier and a block tier', () => {
    const share = scoped('/s/');
    expect(share.map((r) => Object.keys(r.Action as Json)[0]).sort()).toEqual(['Block', 'Captcha']);
  });

  it('rate-limits face search with a CAPTCHA tier and a block tier', () => {
    const face = scoped('/face-search');
    expect(face.map((r) => Object.keys(r.Action as Json)[0]).sort()).toEqual(['Block', 'Captcha']);
    for (const r of face) expect(JSON.stringify(r.Statement)).toContain('"SearchString":"POST"');
  });

  it('evaluates each block rule before its CAPTCHA rule', () => {
    for (const needle of ['/s/', '/face-search']) {
      const [a, b] = scoped(needle).sort((x, y) => (x.Priority as number) - (y.Priority as number));
      expect(Object.keys(a?.Action as Json)).toEqual(['Block']);
      expect(Object.keys(b?.Action as Json)).toEqual(['Captcha']);
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

  it('gives the faces queue at least 180 s of visibility', () => {
    app.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'shotx-prod-faces',
      VisibilityTimeout: Match.anyValue(),
    });
    const [faces] = Object.values(
      app.findResources('AWS::SQS::Queue', { Properties: { QueueName: 'shotx-prod-faces' } }),
    );
    expect(((faces as Json).Properties as Json).VisibilityTimeout).toBeGreaterThanOrEqual(180);
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
      .filter((p) => Array.isArray(p.Metrics));
    expect(queueAlarms.length).toBe(2);
    for (const alarm of queueAlarms) {
      const namespaces = collect(alarm.Metrics, 'Namespace');
      expect(namespaces.length).toBe(QUEUE_NAMES.length * 2);
      expect(new Set(namespaces)).toEqual(new Set(['AWS/SQS']));
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

  it('lets the IndexFaces caller (worker) read tmp/index/*', () => {
    const reads = has(workerStatements, 's3:GetObject').map((st) => JSON.stringify(st.Resource));
    expect(reads.some((r) => r.includes('/tmp/*') || r.includes('/tmp/index/*'))).toBe(true);
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
