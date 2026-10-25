import { Stack, type StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import { SERVICE_NAMES, type ServiceName } from '../constants';

export interface RegistryStackProps extends StackProps {
  readonly config: PlatformConfig;
}

/**
 * ECR repositories, one per service. Separate from the App stack so CI can push the first images
 * before the ECS services are created.
 */
export class RegistryStack extends Stack {
  readonly repositories: Record<ServiceName, ecr.IRepository>;

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);
    const { config } = props;

    const repos = {} as Record<ServiceName, ecr.IRepository>;
    for (const name of SERVICE_NAMES) {
      const repo = new ecr.Repository(this, `${name}Repository`, {
        repositoryName: `shotx-${config.stage}/${name}`,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        imageScanOnPush: true,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [
          { description: 'Keep recent images', maxImageCount: config.registry.keepImages },
        ],
      });
      repos[name] = repo;
      new CfnOutput(this, `${name}RepositoryUri`, { value: repo.repositoryUri });
    }
    this.repositories = repos;
  }
}
