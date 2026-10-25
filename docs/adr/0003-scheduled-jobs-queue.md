# ADR 0003: Scheduled jobs reach the worker through a fourth SQS queue, `jobs`

- Status: Accepted
- Date: 2026-10-25

## Context

The platform spec lists three queues, `media`, `faces` and `zip`, each with a DLQ and alarms.
It also lists scheduled jobs, "EventBridge Scheduler → worker": an hourly stats rollup; daily
subscription transitions, trash purge and face-index expiry; and a nightly quota reconciliation
against S3. It doesn't say how a schedule reaches the worker. Wave 1 infra added a fourth queue,
which is a deviation that needs a record.

- The worker is a long-running ECS service that polls SQS. EventBridge Scheduler can't call a
  running service. It can start a new ECS task (`RunTask`), invoke Lambda, or send to SQS.
- SQS delivers at least once, and the worker already handles that for the other queues: retries,
  a dead-letter queue, and scaling on queue depth.

## Decision

1. A fourth queue, `shotx-<stage>-jobs`, with its own dead-letter queue
   `shotx-<stage>-jobs-dlq` (`infra/lib/constructs/job-queues.ts`). Like the other queues it
   has SQS-managed encryption, TLS-only access, and two alarms on the alarm topic: messages in
   the DLQ, and the age of the oldest message. Settings are in `queues.jobs` in
   `infra/cdk.json` (visibility 3600 s, retention 1 day, 3 receives before the DLQ).
2. One EventBridge Scheduler schedule per job, in the schedule group `shotx-<stage>`, on
   `Asia/Bangkok` time (`infra/lib/constructs/schedules.ts`, `schedules.jobs` in cdk.json). Each
   sends this message to the `jobs` queue:

   ```json
   { "type": "<job type>", "scheduledTime": "<ISO-8601 scheduled time>" }
   ```

   `scheduledTime` is Scheduler's `<aws.scheduler.scheduled-time>`, so it is the same on every
   retry of one run. Scheduler retries delivery `schedules.retryAttempts` times within
   `schedules.maxEventAgeSeconds` and then sends the event to the jobs DLQ.

3. The job types are, exactly:

   | type                             | default schedule (Bangkok) |
   | -------------------------------- | -------------------------- |
   | `stats.rollup.hourly`            | `cron(5 * * * ? *)`        |
   | `subscriptions.transition.daily` | `cron(0 1 * * ? *)`        |
   | `trash.purge.daily`              | `cron(30 1 * * ? *)`       |
   | `faces.expire.daily`             | `cron(0 2 * * ? *)`        |
   | `quota.reconcile.nightly`        | `cron(30 3 * * ? *)`       |

4. packages/shared becomes the single source of truth for the type strings and the message
   schema (contracts is adding them). Until infra imports them from `@shotx/shared`,
   `SCHEDULED_JOB_TYPES` in `infra/lib/constants.ts` mirrors them exactly.
5. The worker consumes `jobs` like its other queues, and `jobs` counts towards the queue backlog
   the worker scales on.

## Rationale

- One delivery path for all background work: the worker's SQS consumer, retry, DLQ and alarm
  handling cover scheduled jobs too, with no second runtime.
- A run that fails ends up in an alarmed DLQ with its `type` and `scheduledTime`, and can be
  redriven.
- A queue of its own keeps job messages apart from S3 event notifications (`media`) and per-file
  work (`faces`, `zip`). DLQ alarms and age alarms then point at the right pipeline, and the
  queue gets the long visibility timeout that batch jobs need.

## Alternatives considered

- **Scheduler starts an ECS task (`RunTask`) per job.** Rejected: a separate task definition and
  command per job, a cold start for every run, no shared DLQ or redrive, and job failures only
  visible in task exit codes.
- **Lambda functions.** Rejected: job code would live in a second runtime with its own
  packaging, VPC access to RDS, and limits (15 minutes), apart from the worker that owns the
  same domain logic.
- **Send scheduled jobs to an existing queue.** Rejected: `media` carries S3 event notifications
  with a different shape, and mixing them would blur the alarms and the visibility timeouts.

## Consequences

- Every job must be idempotent. SQS can deliver a message twice, and Scheduler can retry a run.
  The worker can dedupe on (`type`, `scheduledTime`).
- Jobs that can run longer than the visibility timeout must heartbeat with
  `ChangeMessageVisibility` (`JOBS_QUEUE_VISIBILITY_TIMEOUT_SECONDS`) or split their work into
  batches.
- Changing a job type or the message shape is a contract change: packages/shared,
  `infra/lib/constants.ts`, `infra/cdk.json` (`schedules.jobs.<type>`) and the worker change
  together. infra tests assert that every type has a schedule and that the message carries it.
- Once `@shotx/shared` exports the job types, infra imports them instead of keeping its own list
  (infra already depends on `@shotx/shared`).
- The worker receives `JOBS_QUEUE_URL`; the stack outputs `JobsQueueUrl` and `JobsDlqUrl`.
