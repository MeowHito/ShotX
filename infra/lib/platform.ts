import { Tags, type App, type Environment } from 'aws-cdk-lib';
import type { PlatformConfig } from './config';
import { EDGE_REGION, PRIMARY_REGION } from './constants';
import { AppStack } from './stacks/app-stack';
import { AuthStack } from './stacks/auth-stack';
import { DataStack } from './stacks/data-stack';
import { EdgeStack } from './stacks/edge-stack';
import { NetworkStack } from './stacks/network-stack';
import { PricingPlanStack } from './stacks/pricing-plan-stack';
import { RegistryStack } from './stacks/registry-stack';

export interface Platform {
  readonly edge: EdgeStack;
  readonly network: NetworkStack;
  readonly registry: RegistryStack;
  readonly data: DataStack;
  readonly auth: AuthStack;
  readonly app: AppStack;
  readonly pricingPlan?: PricingPlanStack;
}

/**
 * Builds every stack. Deploy order (CDK derives it from references):
 *   Edge (us-east-1) -> Network -> Registry -> Data -> Auth -> App -> PricingPlan (us-east-1)
 */
export function buildPlatform(app: App, config: PlatformConfig): Platform {
  const primary: Environment = { account: config.account, region: PRIMARY_REGION };
  const edgeEnv: Environment = { account: config.account, region: EDGE_REGION };
  const name = (s: string) => `ShotX-${config.stage}-${s}`;

  const edge = new EdgeStack(app, name('Edge'), {
    env: edgeEnv,
    crossRegionReferences: true,
    description: 'ShotX us-east-1: CloudFront WAF web ACLs and ACM certificates',
    config,
  });
  const network = new NetworkStack(app, name('Network'), {
    env: primary,
    description: 'ShotX VPC, subnets and S3 gateway endpoint',
    config,
  });
  const registry = new RegistryStack(app, name('Registry'), {
    env: primary,
    description: 'ShotX ECR repositories',
    config,
  });
  const data = new DataStack(app, name('Data'), {
    env: primary,
    description: 'ShotX RDS PostgreSQL (Multi-AZ) and ElastiCache Redis',
    config,
    vpc: network.vpc,
  });
  const auth = new AuthStack(app, name('Auth'), {
    env: primary,
    description: 'ShotX Cognito user pools (users with Google and LINE; admins with MFA)',
    config,
  });
  const appStack = new AppStack(app, name('App'), {
    env: primary,
    crossRegionReferences: true,
    description: 'ShotX media bucket, queues, ECS services, CloudFront and schedules',
    config,
    vpc: network.vpc,
    repositories: registry.repositories,
    data,
    auth,
    mainCertificate: edge.mainCertificate,
    adminCertificate: edge.adminCertificate,
    mainWebAclArn: edge.mainWebAclArn,
    adminWebAclArn: edge.adminWebAclArn,
  });
  const pricingPlan = config.cdn.flatRatePlan.enabled
    ? new PricingPlanStack(app, name('PricingPlan'), {
        env: edgeEnv,
        crossRegionReferences: true,
        description: 'ShotX CloudFront flat-rate plan subscription for the main distribution',
        config,
        distributionArn: appStack.mainDistributionArn,
        webAclArn: edge.mainWebAclArn,
      })
    : undefined;

  Tags.of(app).add('Stage', config.stage);
  for (const [key, value] of Object.entries(config.tags)) Tags.of(app).add(key, value);

  return { edge, network, registry, data, auth, app: appStack, pricingPlan };
}
