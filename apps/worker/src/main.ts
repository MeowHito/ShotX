import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SQSClient, type SQSClientConfig } from '@aws-sdk/client-sqs';
import { createDb, createPool } from '@shotx/db';
import { createFaceProvider } from '@shotx/face';
import { awsClientOptions, QUEUE_NAMES, type QueueName } from '@shotx/shared';
import { Redis } from 'ioredis';
import { S3ObjectStore } from './aws/object-store';
import { workerS3ClientOptions } from './aws/s3-client';
import { SqsQueueClient } from './aws/queue-client';
import { createSubscriptionJobDeps, logBillingJobs } from './billing/mode';
import { BullMqConsumer } from './bullmq/consumer';
import { createBullMqConnection } from './bullmq/options';
import { syncJobSchedulers } from './bullmq/schedules';
import { BullMqQueueSender } from './bullmq/sender';
import {
  assertOffAwsQueue,
  assertOffAwsStorage,
  CONSUMED_QUEUES,
  loadWorkerConfig,
  type WorkerConfig,
} from './config';
import { checkFacesBudget, type QueueHold } from './faces/budget';
import { CollectionRegistry } from './faces/deps';
import { createFacesHandler } from './faces/handler';
import { createJobsHandler } from './jobs/handler';
import { RedisJobRunLedger } from './jobs/ledger';
import { S3OrphanScanStore } from './jobs/orphan-scans';
import { createJsonLogger, errorFields, type Logger } from './logger';
import { createMediaHandler } from './media/handler';
import type { MessageHandler, QueueConsumerRuntime } from './queue/handler';
import type { QueueSender } from './queue/sender';
import { QueueConsumer } from './sqs/consumer';
import { createZipHandler } from './zip/handler';

/** The queue runtime of QUEUE_BACKEND: how the worker sends, consumes and schedules. */
interface QueueRuntime {
  sender: QueueSender;
  /** Each queue's destination for `sender` (SQS URL or BullMQ queue name). */
  destinations: Record<QueueName, string>;
  /** How the faces queue holds a running message (for the time budget check). */
  facesHold: QueueHold;
  consumers(handlers: Record<QueueName, MessageHandler>): QueueConsumerRuntime[];
  /** Start-up work before consuming (BullMQ: sync the job schedulers). */
  prepare(): Promise<void>;
  /** Closes what the runtime opened, after the consumers stopped. */
  close(): Promise<void>;
}

/** The one place that picks the queue backend (ADR 0008 section 1). */
function createQueueRuntime(config: WorkerConfig, aws: SQSClientConfig, log: Logger): QueueRuntime {
  const { worker, queue } = config;
  assertOffAwsQueue(config);
  if (queue.backend === 'sqs') {
    const client = new SqsQueueClient(new SQSClient(aws));
    return {
      sender: client,
      destinations: queue.urls,
      facesHold: { backend: 'sqs', visibilityTimeoutSeconds: queue.visibilityTimeoutSeconds.faces },
      consumers: (handlers) =>
        CONSUMED_QUEUES.map(
          (name) =>
            new QueueConsumer({
              queue: name,
              queueUrl: queue.urls[name],
              client,
              handler: handlers[name],
              visibilityTimeoutSeconds: queue.visibilityTimeoutSeconds[name],
              batchSize: worker.consumers[name].batchSize,
              concurrency: worker.consumers[name].concurrency,
              waitTimeSeconds: worker.receiveWaitSeconds,
              retryBaseSeconds: worker.retryBaseSeconds,
              shutdownGraceMs: worker.shutdownGraceMs,
              log,
            }),
        ),
      // EventBridge Scheduler (infra/) sends the scheduled jobs.
      prepare: () => Promise.resolve(),
      close: () => Promise.resolve(),
    };
  }
  const connection = createBullMqConnection(config.redis);
  connection.on('error', (error) => log.warn('bullmq redis error', errorFields(error)));
  const sender = new BullMqQueueSender({
    connection,
    prefix: queue.prefix,
    queues: queue.queues,
    log,
  });
  return {
    sender,
    destinations: Object.fromEntries(QUEUE_NAMES.map((name) => [name, name])) as Record<
      QueueName,
      string
    >,
    facesHold: { backend: 'bullmq', lockDurationMs: queue.queues.faces.lockDurationMs },
    consumers: (handlers) =>
      CONSUMED_QUEUES.map(
        (name) =>
          new BullMqConsumer({
            queue: name,
            connection,
            prefix: queue.prefix,
            settings: queue.queues[name],
            handler: handlers[name],
            concurrency: worker.consumers[name].concurrency,
            shutdownGraceMs: worker.shutdownGraceMs,
            log,
          }),
      ),
    prepare: async () => {
      await syncJobSchedulers(sender.queue('jobs'), queue.schedules, queue.queues.jobs, log);
    },
    close: async () => {
      await sender.close();
      await connection.quit().catch(() => connection.disconnect());
    },
  };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const { worker } = config;
  const log = createJsonLogger({
    minLevel: worker.logLevel,
    base: { service: 'worker', stage: config.app.stage },
  });

  const aws = {
    region: config.aws.region,
    ...(config.aws.endpointUrl === null ? {} : { endpoint: config.aws.endpointUrl }),
  };
  // Media storage has its own endpoint and keys (ADR 0008 section 1): with STORAGE_ENDPOINT_URL
  // (R2) neither AWS_ENDPOINT_URL nor the default credential chain is consulted.
  assertOffAwsStorage(config);
  const s3 = new S3Client(workerS3ClientOptions(config.storage));
  const store = new S3ObjectStore(s3, config.storage.bucket);
  const runtime = createQueueRuntime(config, aws, log);
  const queues = runtime.sender;
  const pool = createPool(config.database);
  const db = createDb(pool);
  const redis = new Redis(config.redis.url, {
    ...(config.redis.credentials ?? {}),
    // ElastiCache RBAC users can't run INFO (ADR 0005), which the ready check uses.
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });
  redis.on('error', (error) => log.warn('redis error', errorFields(error)));

  // FACE_PROVIDER behind FaceProvider (ADR 0001, ADR 0009): self-hosted runs the ONNX models in
  // this process and keeps vectors in `face_vectors` on the primary; rekognition uses the
  // background profile, rate limits shared through Redis, and explicit REKOGNITION_* keys (never
  // AWS_ENDPOINT_URL or the default chain off AWS, ADR 0008 section 1).
  const face = createFaceProvider(config.face, {
    profile: 'background',
    pool,
    redis,
    rekognitionClient: config.rekognitionClient,
  });
  log.info(face.summary);
  // Deletions never need the models, so only indexing makes a missing model file fatal.
  if (config.features.faceSearch) await face.warmUp();
  const provider = face.provider;

  const budget = checkFacesBudget(config.face, worker.maxProcessingMs.faces, runtime.facesHold);
  for (const problem of budget.problems) log.error(`faces time budget: ${problem}`);
  log.info('faces time budget', {
    worstAttemptMs: budget.worstAttemptMs,
    minOrphanGraceMs: budget.minOrphanGraceMs,
    orphanGraceMs: config.face.index.orphanGraceMs,
    maxProcessingMs: worker.maxProcessingMs.faces,
    heartbeatIntervalMs: budget.heartbeatIntervalMs,
    faceSearchEnabled: config.features.faceSearch,
  });

  // ADR 0010: with BILLING_MODE=offline no gateway or email provider is created, the billing jobs
  // aren't scheduled (loadWorkerQueueConfig) and the jobs handler skips them if sent anyway.
  logBillingJobs(config.billingMode, log);
  const subscriptions = createSubscriptionJobDeps(
    {
      billingMode: config.billingMode,
      paymentGateway: config.paymentGateway,
      billing: config.billing,
      email: config.email,
      lifecycle: config.retention.subscription,
      publicBaseUrl: config.app.publicBaseUrl,
    },
    () => {
      // Only called with EMAIL_PROVIDER=ses, which is when sesClient is loaded.
      if (config.sesClient === null) throw new Error('EMAIL_PROVIDER=ses without SES client');
      return new SESv2Client(awsClientOptions(config.sesClient));
    },
  );

  const handlers: Record<QueueName, MessageHandler> = {
    media: createMediaHandler({
      db,
      store,
      queues,
      bucket: config.storage.bucket,
      facesQueueUrl: runtime.destinations.faces,
      media: config.media,
      video: worker.video,
      exifDefaultUtcOffset: worker.exifDefaultUtcOffset,
      tmpDir: worker.tmpDir,
      maxProcessingMs: worker.maxProcessingMs.media,
      originalsStorageClass: config.storage.originalsStorageClass,
      partBytes: config.multipartPartBytes,
    }),
    faces: createFacesHandler({
      db,
      store,
      queues,
      facesQueueUrl: runtime.destinations.faces,
      provider,
      collections: new CollectionRegistry(provider),
      face: config.face,
      features: config.features,
      retention: config.retention,
      batchSize: worker.jobBatchSize,
      maxProcessingMs: worker.maxProcessingMs.faces,
      tmpDir: worker.tmpDir,
      now: Date.now,
    }),
    zip: createZipHandler({
      db,
      store,
      zip: config.zip,
      partBytes: config.multipartPartBytes,
      maxProcessingMs: worker.maxProcessingMs.zip,
    }),
    jobs: createJobsHandler({
      db,
      store,
      faces: provider,
      orphanScans: new S3OrphanScanStore(store),
      orphanGraceMs: config.face.index.orphanGraceMs,
      queues,
      destinations: { media: runtime.destinations.media, faces: runtime.destinations.faces },
      sweeps: worker.sweeps,
      authSessionRetentionDays: config.retention.authSessionRetentionDays,
      faceSearchEnabled: config.features.faceSearch,
      ledger: new RedisJobRunLedger(
        redis,
        `shotx:${config.app.stage}:worker:jobs:done`,
        worker.jobDedupeTtlSeconds,
      ),
      trashRetentionDays: config.retention.trashRetentionDays,
      subscriptions,
      batchSize: worker.jobBatchSize,
      maxRuntimeMs: worker.maxProcessingMs.jobs,
    }),
  };

  const consumers = runtime.consumers(handlers);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    await Promise.all(consumers.map((c) => c.stop()));
    await Promise.allSettled([runtime.close(), pool.end(), redis.quit()]);
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await runtime.prepare();
  log.info('worker started', {
    queues: CONSUMED_QUEUES.join(','),
    queueBackend: config.queue.backend,
    billingMode: config.billingMode,
  });
  await Promise.all(consumers.map((c) => c.start()));
}

main().catch((error: unknown) => {
  // Config errors never contain secret values (the loaders don't echo them).
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'worker failed to start', ...errorFields(error) })}\n`,
  );
  process.exit(1);
});
