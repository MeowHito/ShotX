import { Stack, type StackProps, CfnOutput, Fn } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';

export interface NetworkStackProps extends StackProps {
  readonly config: PlatformConfig;
}

/**
 * VPC with three subnet tiers:
 * - public: NAT gateways only (the ALB is internal and reached through a CloudFront VPC origin),
 * - app (private with egress): ECS tasks,
 * - data (isolated): RDS and ElastiCache.
 *
 * The S3 gateway endpoint keeps S3 traffic (worker reads/writes, ECR layer downloads) off the
 * NAT gateways, so it doesn't pay NAT data processing.
 */
export class NetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  private readonly azCount: number;

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);
    const { network } = props.config;
    this.azCount = network.azCount;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(network.cidr),
      maxAzs: network.azCount,
      natGateways: network.natGateways,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: network.subnetCidrMasks.public,
        },
        {
          name: 'app',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: network.subnetCidrMasks.app,
        },
        {
          name: 'data',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: network.subnetCidrMasks.data,
        },
      ],
      gatewayEndpoints: {
        S3: { service: ec2.GatewayVpcEndpointAwsService.S3 },
      },
    });

    for (const service of network.interfaceEndpoints) {
      this.vpc.addInterfaceEndpoint(`Endpoint-${service.replace(/[^A-Za-z0-9]/g, '-')}`, {
        service: new ec2.InterfaceVpcEndpointAwsService(service),
        subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        privateDnsEnabled: true,
      });
    }

    new CfnOutput(this, 'VpcId', { value: this.vpc.vpcId });
  }

  /**
   * The first `network.azCount` AZs of the account, resolved by CloudFormation (Fn::GetAZs) at
   * deploy time. The default implementation does an availability-zones context lookup (an AWS
   * call) for environment-specific stacks; this keeps synth offline without hard-coding AZ names.
   */
  override get availabilityZones(): string[] {
    return Array.from({ length: this.azCount }, (_, i) => Fn.select(i, Fn.getAzs()));
  }
}
