import { FACE_DELETION_ALERT_EVENT, QUEUE_NAMES, QUEUE_URL_ENV, S3_PREFIXES } from '@shotx/shared';
import { Duration, Stack, type StackProps, CfnOutput } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import type * as ec2 from 'aws-cdk-lib/aws-ec2';
import type * as ecr from 'aws-cdk-lib/aws-ecr';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import { PATHS, type ServiceName } from '../constants';
import { Cdn } from '../constructs/cdn';
import { Email } from '../constructs/email';
import { JobQueues } from '../constructs/job-queues';
import { MediaStorage } from '../constructs/media-storage';
import { RedisAlarms } from '../constructs/redis-alarms';
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
    // Redis lives in the Data stack; its alarm sits here, next to the alarm topic.
    new RedisAlarms(this, 'RedisAlarms', {
      config,
      replicationGroupId: data.redisReplicationGroupId,
      alarmTopic,
    });

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
      redis: {
        host: data.redisHost,
        port: data.redisPort,
        secret: data.redisSecret,
        securityGroup: data.redisSecurityGroup,
      },
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

    // Transactional email: SES identity and configuration set, SendEmail for api and worker.
    const email = new Email(this, 'Email', {
      config,
      senders: [services.taskRoles.api, services.taskRoles.worker],
    });

    // ADR 0007: the api logs a JSON line with `"event": FACE_DELETION_ALERT_EVENT` when one share
    // collects many "ขอลบใบหน้าของฉัน" deletions. Any such line alarms.
    const faceDeletionAlerts = new logs.MetricFilter(this, 'FaceDeletionAlertFilter', {
      logGroup: services.logGroups.api,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', FACE_DELETION_ALERT_EVENT),
      metricNamespace: `ShotX/${config.stage}`,
      metricName: 'FaceDeletionAlerts',
      metricValue: '1',
      defaultValue: 0,
    });
    new cloudwatch.Alarm(this, 'FaceDeletionAlertAlarm', {
      alarmName: `${prefix}-face-deletion-alert`,
      alarmDescription:
        'A share passed FACE_DELETION_ALERT_PER_SHARE face deletions within ' +
        'FACE_DELETION_ALERT_WINDOW_SECONDS (ADR 0007): check face_deletions for abuse',
      metric: faceDeletionAlerts.metric({
        statistic: 'Sum',
        period: Duration.seconds(config.alarms.faceDeletionAlertPeriodSeconds),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new cwActions.SnsAction(alarmTopic));

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
      out(QUEUE_URL_ENV[q], queues.queues[q].queue.queueUrl);
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
    // ARN only: the api gets the value as the ECS secret IP_HASH_SECRET.
    out('IP_HASH_SECRET_ARN', services.ipHashSecret.secretArn);
    // ARN only: api and worker get its keys as ECS secrets (PAYMENT_GATEWAY_SECRET_ENV).
    out('PAYMENT_GATEWAY_SECRET_ARN', services.paymentGatewaySecret.secretArn);
    out('SES_IDENTITY_ARN', email.identityArn);
    out('SES_CONFIGURATION_SET', email.configurationSet.configurationSetName);
  }
}
