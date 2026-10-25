import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import { createDb, createPool } from '@shotx/db';
import { Redis } from 'ioredis';
import { S3ObjectStore } from './aws/object-store';
import { SqsQueueClient } from './aws/queue-client';
import { CONSUMED_QUEUES, loadWorkerConfig } from './config';
import { unavailableFaceDeleter } from './faces';
import { createJobsHandler } from './jobs/handler';
import { RedisJobRunLedger } from './jobs/ledger';
import { createJsonLogger, errorFields } from './logger';
import { createMediaHandler } from './media/handler';
import { type MessageHandler, QueueConsumer } from './sqs/consumer';

async function main(): Promise<void> {
  const config = loadWorkerConfig(process.env);
  const log = createJsonLogger({
    minLevel: config.worker.logLevel,
    base: { service: 'worker', stage: config.app.stage },
  });

  const aws = {
    region: config.aws.region,
    ...(config.aws.endpointUrl === null ? {} : { endpoint: config.aws.endpointUrl }),
  };
  const store = new S3ObjectStore(
    new S3Client({ ...aws, forcePathStyle: config.storage.forcePathStyle }),
    config.storage.bucket,
  );
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

  const handlers: Record<(typeof CONSUMED_QUEUES)[number], MessageHandler> = {
    media: createMediaHandler({
      db,
      store,
      queues,
      bucket: config.storage.bucket,
      facesQueueUrl: config.queueUrls.faces,
      media: config.media,
      video: config.worker.video,
      exifDefaultUtcOffset: config.worker.exifDefaultUtcOffset,
      tmpDir: config.worker.tmpDir,
      maxProcessingMs: config.worker.mediaMaxProcessingMs,
    }),
    jobs: createJobsHandler({
      db,
      store,
      // Phase 3 wires RekognitionFaceProvider (background profile) here.
      faces: unavailableFaceDeleter,
      ledger: new RedisJobRunLedger(
        redis,
        `shotx:${config.app.stage}:worker:jobs:done`,
        config.worker.jobDedupeTtlSeconds,
      ),
      trashRetentionDays: config.retention.trashRetentionDays,
      batchSize: config.worker.jobBatchSize,
      maxRuntimeMs: config.worker.jobMaxRuntimeMs,
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
        batchSize: config.worker.consumers[queue].batchSize,
        concurrency: config.worker.consumers[queue].concurrency,
        waitTimeSeconds: config.worker.receiveWaitSeconds,
        retryBaseSeconds: config.worker.retryBaseSeconds,
        shutdownGraceMs: config.worker.shutdownGraceMs,
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
