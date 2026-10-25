import { Duration, TimeZone } from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import { Construct } from 'constructs';
import type { PlatformConfig } from '../config';
import { SCHEDULED_JOB_TYPES } from '../constants';
import type { JobQueue } from './job-queues';

export interface SchedulesProps {
  readonly config: PlatformConfig;
  readonly jobs: JobQueue;
}

/**
 * EventBridge Scheduler -> `jobs` SQS queue -> worker. Each message is
 * `{ "type": "<job type>", "scheduledTime": "<ISO-8601>" }`. SQS delivers at least once, so every
 * job must be idempotent (the worker can dedupe on type + scheduledTime). Failed deliveries go to
 * the jobs DLQ, which is alarmed.
 */
export class Schedules extends Construct {
  readonly schedules: scheduler.Schedule[] = [];

  constructor(scope: Construct, id: string, props: SchedulesProps) {
    super(scope, id);
    const { config, jobs } = props;
    const s = config.schedules;
    const group = new scheduler.ScheduleGroup(this, 'Group', {
      scheduleGroupName: `shotx-${config.stage}`,
    });
    const timeZone = TimeZone.of(s.timezone);

    for (const type of SCHEDULED_JOB_TYPES) {
      const job = s.jobs[type];
      const target = new schedulerTargets.SqsSendMessage(jobs.queue, {
        input: scheduler.ScheduleTargetInput.fromObject({
          type,
          scheduledTime: scheduler.ContextAttribute.scheduledTime,
        }),
        deadLetterQueue: jobs.deadLetterQueue,
        retryAttempts: s.retryAttempts,
        maxEventAge: Duration.seconds(s.maxEventAgeSeconds),
      });
      this.schedules.push(
        new scheduler.Schedule(this, type.replace(/[^A-Za-z0-9]/g, '-'), {
          scheduleName: `shotx-${config.stage}-${type.replace(/\./g, '-')}`,
          description: `Enqueue ${type}`,
          scheduleGroup: group,
          schedule: scheduler.ScheduleExpression.expression(job.expression, timeZone),
          target,
          enabled: job.enabled,
        }),
      );
    }
  }
}
