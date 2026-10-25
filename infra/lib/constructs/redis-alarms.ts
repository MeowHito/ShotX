import { Duration, Fn } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import type { PlatformConfig } from '../config';

export interface RedisAlarmsProps {
  readonly config: PlatformConfig;
  /** The replication group's id (Data stack). */
  readonly replicationGroupId: string;
  readonly alarmTopic: sns.ITopic;
}

/**
 * Redis runs with maxmemory-policy noeviction (ADR 0005): when memory is full, writes fail
 * (rate limits, grants, Rekognition token buckets) instead of keys being evicted. This alarm is
 * the early warning: DatabaseMemoryUsagePercentage (used_memory / maxmemory) of the fullest node
 * above `redis.alarms.memoryUsagePercentThreshold`.
 */
export class RedisAlarms extends Construct {
  readonly memoryAlarm: cloudwatch.Alarm;

  constructor(scope: Construct, id: string, props: RedisAlarmsProps) {
    super(scope, id);
    const { config } = props;
    const { redis } = config;
    const period = Duration.seconds(redis.alarms.periodSeconds);

    // Cluster-mode-disabled replication groups name their nodes <id>-001, <id>-002, ...
    const usingMetrics: Record<string, cloudwatch.IMetric> = {};
    for (let n = 1; n <= redis.numCacheClusters; n++) {
      usingMetrics[`m${n}`] = new cloudwatch.Metric({
        namespace: 'AWS/ElastiCache',
        metricName: 'DatabaseMemoryUsagePercentage',
        dimensionsMap: {
          CacheClusterId: Fn.join('', [props.replicationGroupId, `-${String(n).padStart(3, '0')}`]),
        },
        statistic: cloudwatch.Stats.MAXIMUM,
        period,
      });
    }
    const fullestNode = new cloudwatch.MathExpression({
      label: 'Redis memory used, % of maxmemory (fullest node)',
      expression: `MAX([${Object.keys(usingMetrics).join(', ')}])`,
      usingMetrics,
      period,
    });

    this.memoryAlarm = new cloudwatch.Alarm(this, 'MemoryAlarm', {
      alarmName: `shotx-${config.stage}-redis-memory`,
      alarmDescription:
        'Redis memory is filling up. maxmemory-policy is noeviction (ADR 0005): at 100% writes ' +
        'fail, which breaks rate limits and face_only grants. Find what grows (keys without TTL?) ' +
        'or scale the node type.',
      metric: fullestNode,
      threshold: redis.alarms.memoryUsagePercentThreshold,
      evaluationPeriods: redis.alarms.evaluationPeriods,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.MISSING,
    });
    this.memoryAlarm.addAlarmAction(new cwActions.SnsAction(props.alarmTopic));
  }
}
