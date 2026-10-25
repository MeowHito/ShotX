import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { createDb, createPool, loadDatabaseConfig } from '@shotx/db';
import { createApiApp } from './app';
import { CognitoTokenVerifier, remoteJwks } from './auth/cognito-verifier';
import { loadApiConfig, redisKeyPrefix } from './config';
import { CloudFrontMediaUrlSigner } from './infra/cloudfront-signer';
import { createRedis, RedisRateLimiter } from './infra/redis';
import { createS3Client, S3ObjectStorage } from './infra/s3-storage';
import { systemClock } from './tokens';

async function main(): Promise<void> {
  const env = process.env;
  const config = loadApiConfig(env);
  const pool = createPool(loadDatabaseConfig(env));
  const redis = createRedis(config.redis);
  const s3 = createS3Client(config.aws, config.storage);
  const logger = new ConsoleLogger('api', { json: config.app.nodeEnv === 'production' });

  const app = await createApiApp(
    {
      config,
      db: createDb(pool),
      storage: new S3ObjectStorage(s3, config.storage.bucket),
      signer: new CloudFrontMediaUrlSigner(config.cloudFront),
      rateLimiter: new RedisRateLimiter(redis, redisKeyPrefix(config)),
      tokenVerifier: new CognitoTokenVerifier(config.cognito, remoteJwks(config.cognito)),
      clock: systemClock,
      onShutdown: async () => {
        s3.destroy();
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
