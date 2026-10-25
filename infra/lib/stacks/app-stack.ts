import { Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import { PATHS, QUEUE_NAMES, S3_PREFIXES, type ServiceName } from '../constants';
import { Cdn } from '../constructs/cdn';
import { JobQueues } from '../constructs/job-queues';
import { MediaStorage } from '../constructs/media-storage';
import { Schedules } from '../constructs/schedules';
import { Services } from '../constructs/services';
import type { AuthStack } from './auth-stack';
import type { DataStack } from './data-stack';

export interface AppStackProps extends StackProps {
  readonly config: PlatformConfig;
  readonly vpc: ec2.IVpc;
  readonly repositories: Record<ServiceName, ecr.IRepository>;
  readonly data: DataStack;
  readonly auth: AuthStack;
  readonly mainCertificate: acm.ICertificate;
  readonly adminCertificate: acm.ICertificate;
  readonly mainWebAclArn: string;
  readonly adminWebAclArn: string;
}

/**
 * The application platform in ap-southeast-1: media bucket, queues, ECS services, CloudFront and
 * schedules. They share one stack because the bucket policy (OAC) references the distribution,
 * the distribution references the ALB, and the services reference the bucket and queues; split
 * across stacks these would form dependency cycles.
 */
export class AppStack extends Stack {
  readonly mediaBucket: s3.Bucket;
  readonly mainDistributionArn: string;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config, data, auth } = props;
    const prefix = `shotx-${config.stage}`;

    const alarmTopic = new sns.Topic(this, 'AlarmTopic', { topicName: `${prefix}-alarms` });
    if (config.alarms.email !== '') {
      alarmTopic.addSubscription(new subs.EmailSubscription(config.alarms.email));
    }

    const storage = new MediaStorage(this, 'Storage', { config });
    const queues = new JobQueues(this, 'Queues', { config, alarmTopic });

    // Completed uploads (CompleteMultipartUpload) under originals/ start the media pipeline.
    // The worker writes derived/ and tmp/, which must not trigger it.
    storage.bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(queues.queues.media.queue),
      { prefix: S3_PREFIXES.originals },
    );

    const signingKey = new cloudfront.PublicKey(this, 'MediaSigningKey', {
      publicKeyName: `${prefix}-media-signing`,
      comment: 'Signs /media/* URLs; private key in Secrets Manager',
      encodedKey: config.cdn.signingPublicKeyPem,
    });

    const services = new Services(this, 'Services', {
      config,
      vpc: props.vpc,
      repositories: props.repositories,
      database: {
        host: data.databaseHost,
        port: data.databasePort,
        name: data.databaseName,
        secret: data.databaseSecret,
        securityGroup: data.databaseSecurityGroup,
      },
      redis: { host: data.redisHost, port: data.redisPort, securityGroup: data.redisSecurityGroup },
      cognito: {
        userPoolId: auth.userPool.userPoolId,
        webClientId: auth.webClient.userPoolClientId,
        domain: auth.userPoolDomain.baseUrl(),
        adminUserPoolId: auth.adminUserPool.userPoolId,
        adminClientId: auth.adminClient.userPoolClientId,
        adminDomain: auth.adminUserPoolDomain.baseUrl(),
      },
      bucket: storage.bucket,
      queues: queues.queues,
      cloudFrontKeyPairId: signingKey.publicKeyId,
    });

    const cdn = new Cdn(this, 'Cdn', {
      config,
      loadBalancer: services.loadBalancer,
      mediaBucket: storage.bucket,
      logBucket: storage.logBucket,
      signingKey,
      mainCertificate: props.mainCertificate,
      adminCertificate: props.adminCertificate,
      mainWebAclArn: props.mainWebAclArn,
      adminWebAclArn: props.adminWebAclArn,
    });

    new Schedules(this, 'Schedules', { config, jobs: queues.queues.jobs });

    this.mediaBucket = storage.bucket;
    this.mainDistributionArn = cdn.mainDistribution.distributionArn;

    // One output per env var the services read: MEDIA_QUEUE_URL -> output MediaQueueUrl.
    const out = (envName: string, value: string) =>
      new CfnOutput(
        this,
        envName.toLowerCase().replace(/(^|_)([a-z])/g, (_m, _s, c: string) => c.toUpperCase()),
        {
          value,
          description: envName,
        },
      );
    out('MEDIA_BUCKET', storage.bucket.bucketName);
    for (const q of QUEUE_NAMES) {
      out(`${q.toUpperCase()}_QUEUE_URL`, queues.queues[q].queue.queueUrl);
      out(`${q.toUpperCase()}_DLQ_URL`, queues.queues[q].deadLetterQueue.queueUrl);
    }
    out('CLOUDFRONT_KEY_PAIR_ID', signingKey.publicKeyId);
    out('CLOUDFRONT_MEDIA_BASE_URL', `https://${config.domain.main}${PATHS.media}`);
    out('MAIN_DISTRIBUTION_ID', cdn.mainDistribution.distributionId);
    out('MAIN_DISTRIBUTION_DOMAIN', cdn.mainDistribution.distributionDomainName);
    out('ADMIN_DISTRIBUTION_ID', cdn.adminDistribution.distributionId);
    out('ADMIN_DISTRIBUTION_DOMAIN', cdn.adminDistribution.distributionDomainName);
    out('CLOUDFRONT_LOG_BUCKET', storage.logBucket.bucketName);
    out('API_INTERNAL_URL', `http://${services.loadBalancer.loadBalancerDnsName}`);
    out('ECS_CLUSTER', services.cluster.clusterName);
    out('ALARM_TOPIC_ARN', alarmTopic.topicArn);
  }
}
