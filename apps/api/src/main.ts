import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { createDb, createPool, loadDatabaseConfig } from '@shotx/db';
import { createRedisRekognitionLimiters, RekognitionFaceProvider } from '@shotx/face';
import { createApiApp } from './app';
import { loadApiConfig, redisKeyPrefix } from './config';
import { createRedis, RedisKeyValueStore, RedisRateLimiter } from './infra/redis';
import { createS3Client, S3ObjectStorage } from './infra/s3-storage';
import { systemClock } from './tokens';
import { mediaUrlSigner, queueSender, tokenVerifier } from './wiring';

async function main(): Promise<void> {
  const env = process.env;
  const config = loadApiConfig(env);
  const pool = createPool(loadDatabaseConfig(env));
  const redis = createRedis(config.redis);
  const s3 = createS3Client(config.aws, config.storage);
  const queue = queueSender(config);
  // BullMQ: Redis must be reachable before the API takes requests (bounded wait, then exit).
  await queue.start();
  // Face search is the only synchronous Rekognition use: the interactive profile fails fast.
  const faceProvider = RekognitionFaceProvider.create(
    config.face.rekognition,
    'interactive',
    createRedisRekognitionLimiters(redis, config.face.rekognition, 'interactive'),
  );
  const logger = new ConsoleLogger('api', { json: config.app.nodeEnv === 'production' });

  const app = await createApiApp(
    {
      config,
      db: createDb(pool),
      storage: new S3ObjectStorage(s3, config.storage.bucket),
      signer: mediaUrlSigner(config),
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
