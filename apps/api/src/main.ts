import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { createDb, createPool, loadDatabaseConfig } from '@shotx/db';
import { createApiApp } from './app';
import { loadApiConfig, redisKeyPrefix } from './config';
import { createRedis, RedisKeyValueStore, RedisRateLimiter } from './infra/redis';
import { createS3Client, S3ObjectStorage } from './infra/s3-storage';
import { systemClock } from './tokens';
import {
  assertExplicitStorage,
  apiFaceProvider,
  mediaSignerSummary,
  mediaUrlSigner,
  queueSender,
  packageSalesSummary,
  tokenVerifier,
} from './wiring';

async function main(): Promise<void> {
  const env = process.env;
  const config = loadApiConfig(env);
  const logger = new ConsoleLogger('api', { json: config.app.nodeEnv === 'production' });
  // Off AWS nothing may use AWS_ENDPOINT_URL or the default credential chain (ADR 0008 §1).
  assertExplicitStorage(config);
  logger.log(mediaSignerSummary(config));
  logger.log(packageSalesSummary(config));
  const pool = createPool(loadDatabaseConfig(env));
  const redis = createRedis(config.redis);
  const s3 = createS3Client(config.storage);
  const queue = queueSender(config);
  // BullMQ: Redis must be reachable before the API takes requests (bounded wait, then exit).
  await queue.start();
  // Face search is the only synchronous face call: the interactive profile fails fast (ADR 0009).
  const face = apiFaceProvider(config, redis, pool);
  logger.log(face.summary);
  // A missing or altered model file stops start-up instead of the first scan.
  if (config.features.faceSearch) await face.warmUp();
  const faceProvider = face.provider;

  const app = await createApiApp(
    {
      config,
      db: createDb(pool),
      storage: new S3ObjectStorage(s3, config.storage.bucket, config.storage.originalsStorageClass),
      signer: mediaUrlSigner(config, systemClock),
      rateLimiter: new RedisRateLimiter(redis, redisKeyPrefix(config)),
      tokenVerifier: tokenVerifier(config, systemClock),
      clock: systemClock,
      store: new RedisKeyValueStore(redis, redisKeyPrefix(config)),
      queue: queue.sender,
      faceProvider,
      onShutdown: async () => {
        s3.destroy();
        await queue.close();
        redis.disconnect();
        await pool.end();
      },
    },
    logger,
  );
  app.enableShutdownHooks();
  await app.listen(config.server.port, '0.0.0.0');
  logger.log(`listening on port ${config.server.port}`);
}

main().catch((error: unknown) => {
  // Config errors never contain secret values (the shared loaders redact them).
  console.error(error instanceof Error ? error.message : 'api failed to start');
  process.exit(1);
});
