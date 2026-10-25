import { Duration } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import { QUEUE_NAMES, type QueueName } from '../constants';

export interface JobQueuesProps {
  readonly config: PlatformConfig;
  readonly alarmTopic: sns.ITopic;
}

export interface JobQueue {
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
}

/**
 * SQS queues media, faces, zip and jobs. Every queue has a dead-letter queue and two alarms:
 * messages in the DLQ, and the age of the oldest message in the main queue. SQS-managed SSE is
 * used because S3 event notifications can't publish to queues encrypted with the AWS-managed KMS
 * key.
 */
export class JobQueues extends Construct {
  readonly queues: Record<QueueName, JobQueue>;

  constructor(scope: Construct, id: string, props: JobQueuesProps) {
    super(scope, id);
    const { config, alarmTopic } = props;
    const prefix = `shotx-${config.stage}`;
    const action = new cwActions.SnsAction(alarmTopic);

    const queues = {} as Record<QueueName, JobQueue>;
    for (const name of QUEUE_NAMES) {
      const q = config.queues[name];
      const deadLetterQueue = new sqs.Queue(this, `${name}Dlq`, {
        queueName: `${prefix}-${name}-dlq`,
        retentionPeriod: Duration.days(q.dlqRetentionDays),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
      });
      const queue = new sqs.Queue(this, `${name}Queue`, {
        queueName: `${prefix}-${name}`,
        visibilityTimeout: Duration.seconds(q.visibilityTimeoutSeconds),
        retentionPeriod: Duration.days(q.retentionDays),
        receiveMessageWaitTime: Duration.seconds(q.receiveWaitSeconds),
        encryption: sqs.QueueEncryption.SQS_MANAGED,
        enforceSSL: true,
        deadLetterQueue: { queue: deadLetterQueue, maxReceiveCount: q.maxReceiveCount },
      });

      new cloudwatch.Alarm(this, `${name}DlqAlarm`, {
        alarmName: `${prefix}-${name}-dlq-not-empty`,
        alarmDescription: `Messages in the ${name} dead-letter queue`,
        metric: deadLetterQueue.metricApproximateNumberOfMessagesVisible({
          period: Duration.minutes(1),
          statistic: cloudwatch.Stats.MAXIMUM,
        }),
        threshold: q.alarms.dlqVisibleMessagesThreshold,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);

      new cloudwatch.Alarm(this, `${name}AgeAlarm`, {
        alarmName: `${prefix}-${name}-oldest-message-age`,
        alarmDescription: `Oldest message in the ${name} queue is older than expected`,
        metric: queue.metricApproximateAgeOfOldestMessage({
          period: Duration.minutes(1),
          statistic: cloudwatch.Stats.MAXIMUM,
        }),
        threshold: q.alarms.oldestMessageAgeSeconds,
        evaluationPeriods: q.alarms.oldestMessageAgeEvaluationPeriods,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);

      queues[name] = { queue, deadLetterQueue };
    }
    this.queues = queues;
  }
}
