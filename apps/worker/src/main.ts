import { S3Client } from '@aws-sdk/client-s3';
import { SESv2Client } from '@aws-sdk/client-sesv2';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createDb, createPool } from '@shotx/db';
import {
  createRedisRekognitionLimiters,
  RekognitionFaceProvider,
  S3TempImageStore,
} from '@shotx/face';
import type { QueueName } from '@shotx/shared';
import { Redis } from 'ioredis';
import { S3ObjectStore } from './aws/object-store';
import { SqsQueueClient } from './aws/queue-client';
import { createEmailProvider } from './billing/email';
import { createRenewalGateway } from './billing/gateway';
import { CONSUMED_QUEUES, loadWorkerConfig } from './config';
import { checkFacesBudget } from './faces/budget';
import { CollectionRegistry } from './faces/deps';
import { createFacesHandler } from './faces/handler';
import { createJobsHandler } from './jobs/handler';
import { RedisJobRunLedger } from './jobs/ledger';
import { S3OrphanScanStore } from './jobs/orphan-scans';
import { createJsonLogger, errorFields } from './logger';
import { createMediaHandler } from './media/handler';
import { type MessageHandler, QueueConsumer } from './sqs/consumer';
import { createZipHandler } from './zip/handler';

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
  const s3 = new S3Client({ ...aws, forcePathStyle: config.storage.forcePathStyle });
  const store = new S3ObjectStore(s3, config.storage.bucket);
  const queues = new SqsQueueClient(new SQSClient(aws));
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

  // Rekognition behind FaceProvider (ADR 0001): background profile, rate limits shared through
  // Redis with every api and worker task.
  const limiters = createRedisRekognitionLimiters(redis, config.face.rekognition, 'background');
  const provider = RekognitionFaceProvider.create(config.face.rekognition, 'background', limiters);

  const budget = checkFacesBudget(
    config.face,
    worker.maxProcessingMs.faces,
    config.visibilityTimeoutSeconds.faces,
  );
  for (const problem of budget.problems) log.error(`faces time budget: ${problem}`);
  log.info('faces time budget', {
    worstAttemptMs: budget.worstAttemptMs,
    minOrphanGraceMs: budget.minOrphanGraceMs,
    orphanGraceMs: config.face.index.orphanGraceMs,
    maxProcessingMs: worker.maxProcessingMs.faces,
    heartbeatIntervalMs: budget.heartbeatIntervalMs,
    faceSearchEnabled: config.features.faceSearch,
  });

  const handlers: Record<QueueName, MessageHandler> = {
    media: createMediaHandler({
      db,
      store,
      queues,
      bucket: config.storage.bucket,
      facesQueueUrl: config.queueUrls.faces,
      media: config.media,
      video: worker.video,
      exifDefaultUtcOffset: worker.exifDefaultUtcOffset,
      tmpDir: worker.tmpDir,
      maxProcessingMs: worker.maxProcessingMs.media,
    }),
    faces: createFacesHandler({
      db,
      store,
      queues,
      facesQueueUrl: config.queueUrls.faces,
      provider,
      tempStore: new S3TempImageStore(s3, config.storage.bucket),
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
      ledger: new RedisJobRunLedger(
        redis,
        `shotx:${config.app.stage}:worker:jobs:done`,
        worker.jobDedupeTtlSeconds,
      ),
      trashRetentionDays: config.retention.trashRetentionDays,
      subscriptions: {
        gateway: createRenewalGateway(config.paymentGateway),
        email: createEmailProvider(config.email, () => new SESv2Client(aws)),
        billing: config.billing,
        lifecycle: config.retention.subscription,
        publicBaseUrl: config.app.publicBaseUrl,
      },
      batchSize: worker.jobBatchSize,
      maxRuntimeMs: worker.maxProcessingMs.jobs,
    }),
  };

  const consumers = CONSUMED_QUEUES.map(
    (queue) =>
      new QueueConsumer({
        queue,
        queueUrl: config.queueUrls[queue],
        client: queues,
        handler: handlers[queue],
        visibilityTimeoutSeconds: config.visibilityTimeoutSeconds[queue],
        batchSize: worker.consumers[queue].batchSize,
        concurrency: worker.consumers[queue].concurrency,
        waitTimeSeconds: worker.receiveWaitSeconds,
        retryBaseSeconds: worker.retryBaseSeconds,
        shutdownGraceMs: worker.shutdownGraceMs,
        log,
      }),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });
    await Promise.all(consumers.map((c) => c.stop()));
    await Promise.allSettled([pool.end(), redis.quit()]);
    log.info('stopped');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  log.info('worker started', { queues: CONSUMED_QUEUES.join(',') });
  await Promise.all(consumers.map((c) => c.start()));
}

main().catch((error: unknown) => {
  // Config errors never contain secret values (the loaders don't echo them).
  process.stderr.write(
    `${JSON.stringify({ level: 'error', msg: 'worker failed to start', ...errorFields(error) })}\n`,
  );
  process.exit(1);
});
