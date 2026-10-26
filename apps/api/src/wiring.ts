import { CognitoTokenVerifier, remoteJwks } from './auth/cognito-verifier';
import { ShotxTokenVerifier } from './auth/shotx-tokens';
import type { ApiConfig } from './config';
import { BullMqQueueSender, connectBullMq, createBullMqConnection } from './infra/bullmq-queue';
import { CloudFrontMediaUrlSigner } from './infra/cloudfront-signer';
import { S3PresignMediaUrlSigner } from './infra/s3-presign-signer';
import { createSqsClient, SqsQueueSender } from './infra/sqs-queue';
import {
  type Clock,
  type MediaUrlSigner,
  type QueueSender,
  systemClock,
  type TokenVerifier,
} from './tokens';

// Adapter selection for main.ts, from the loaded config (the loaders refuse local options outside
// APP_STAGE=local).

/**
 * AUTH_PROVIDER=cognito: Cognito JWTs (remote JWKS). `shotx` and `local`: the API's own EdDSA
 * access tokens (per-pool keys; ADR 0008 section 4).
 */
export function tokenVerifier(config: ApiConfig, clock: Clock = systemClock): TokenVerifier {
  if (config.auth.provider === 'cognito') {
    if (config.cognito === null) throw new Error('Cognito configuration is missing');
    return new CognitoTokenVerifier(config.cognito, remoteJwks(config.cognito));
  }
  if (config.shotxAuth === null) throw new Error('ShotX auth configuration is missing');
  return new ShotxTokenVerifier(config.app.stage, config.shotxAuth, clock);
}

/** A queue sender and how to release its client. */
export interface QueueWiring {
  sender: QueueSender;
  /** Opens the client before the API listens (BullMQ: waits for Redis, bounded). */
  start: () => Promise<void>;
  close: () => Promise<void>;
}

/** QUEUE_BACKEND=sqs: SqsQueueSender. `bullmq`: BullMqQueueSender on its own Redis connection. */
export function queueSender(config: ApiConfig): QueueWiring {
  const queues = config.queues;
  if (queues.backend === 'sqs') {
    const sqs = createSqsClient(config.aws);
    return {
      sender: new SqsQueueSender(sqs, queues.urls, queues.enqueueTimeoutMs),
      start: () => Promise.resolve(),
      close: () => {
        sqs.destroy();
        return Promise.resolve();
      },
    };
  }
  const connection = createBullMqConnection(config.redis);
  const sender = new BullMqQueueSender(connection, {
    prefix: queues.prefix,
    queues: queues.queues,
    enqueueTimeoutMs: queues.enqueueTimeoutMs,
  });
  return {
    sender,
    start: () => connectBullMq(connection, queues.enqueueTimeoutMs),
    close: async () => {
      await sender.close();
      connection.disconnect();
    },
  };
}

/** CloudFront signed URLs on deployed stages; S3 presigned URLs with MEDIA_URL_SIGNER=s3-presign. */
export function mediaUrlSigner(config: ApiConfig): MediaUrlSigner {
  if (config.mediaUrls.signer === 's3-presign') {
    if (config.aws.endpointUrl === null) {
      throw new Error('MEDIA_URL_SIGNER=s3-presign needs AWS_ENDPOINT_URL (LocalStack)');
    }
    return new S3PresignMediaUrlSigner({
      endpointUrl: config.aws.endpointUrl,
      region: config.aws.region,
      bucket: config.storage.bucket,
      accessKeyId: config.mediaUrls.accessKeyId,
      secretAccessKey: config.mediaUrls.secretAccessKey,
    });
  }
  if (config.cloudFront === null) throw new Error('CloudFront signing configuration is missing');
  return new CloudFrontMediaUrlSigner(config.cloudFront);
}
