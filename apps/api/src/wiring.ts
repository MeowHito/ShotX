import {
  type ConfiguredFaceProvider,
  createFaceProvider,
  createRedisRekognitionLimiters,
  type PgPoolLike,
  type RekognitionLimiters,
  RekognitionFaceProvider,
} from '@shotx/face';
import { LOCAL_DEV_APP_STAGE } from '@shotx/shared';
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
    // The SQS client relies on AWS_ENDPOINT_URL and the default credential chain (the ECS task
    // role): AWS stacks only.
    if (config.offAws && config.app.stage !== LOCAL_DEV_APP_STAGE) {
      throw new Error('QUEUE_BACKEND=sqs is for the AWS stacks only; off AWS use bullmq');
    }
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

/**
 * MEDIA_URL_SIGNER=cloudfront: CloudFront signed URLs (AWS stacks, until infra/ is removed).
 * `s3-presign`: SigV4 presigned GETs on STORAGE_ENDPOINT_URL with the STORAGE_* keys (R2 on the
 * VPS, LocalStack or MinIO locally; any stage).
 */
export function mediaUrlSigner(config: ApiConfig, clock: Clock = systemClock): MediaUrlSigner {
  const urls = config.mediaUrls;
  if (urls.signer === 's3-presign') {
    return new S3PresignMediaUrlSigner({
      endpointUrl: urls.endpointUrl,
      region: urls.region,
      bucket: config.storage.bucket,
      accessKeyId: urls.accessKeyId,
      secretAccessKey: urls.secretAccessKey,
      signingDateBucketSeconds: config.share.signedUrlExpiryBucketSeconds,
      now: () => clock.now(),
    });
  }
  if (config.cloudFront === null) throw new Error('CloudFront signing configuration is missing');
  return new CloudFrontMediaUrlSigner(config.cloudFront);
}

/**
 * Refuses AWS S3 through the default chain off AWS (outside APP_STAGE=local, where LocalStack via
 * AWS_ENDPOINT_URL is fine): with no task role the SDK would pick up whatever AWS_* keys the
 * environment has. Off AWS, storage must be an explicit STORAGE_ENDPOINT_URL with its own keys.
 */
export function assertExplicitStorage(config: ApiConfig): void {
  if (
    config.offAws &&
    !config.storage.client.explicit &&
    config.app.stage !== LOCAL_DEV_APP_STAGE
  ) {
    throw new Error(
      'Off AWS, media storage needs STORAGE_ENDPOINT_URL and STORAGE_* keys (no default credential chain)',
    );
  }
}

/**
 * The start-up line about media URL signing: the signer and, for s3-presign, which key pair
 * signs (`signing`: the read-only STORAGE_SIGNING_* token; `storage`: the api's own keys) and
 * the endpoint origin. Never a key.
 */
export function mediaSignerSummary(config: Pick<ApiConfig, 'mediaUrls'>): string {
  const urls = config.mediaUrls;
  if (urls.signer === 'cloudfront') return 'media URLs: cloudfront';
  return `media URLs: s3-presign on ${new URL(urls.endpointUrl).origin}, keySource=${urls.keySource}`;
}

/**
 * The api's FaceProvider as FACE_PROVIDER selects (ADR 0009): self-hosted runs the selfie through
 * the ONNX models in this process (bounded by FACE_INFERENCE_CONCURRENCY) and searches
 * `face_vectors` on `pool`; rekognition is interactiveFaceProvider below.
 */
export function apiFaceProvider(
  config: Pick<ApiConfig, 'face' | 'rekognitionClient'>,
  redis: Parameters<typeof createRedisRekognitionLimiters>[0],
  pool: PgPoolLike,
): ConfiguredFaceProvider {
  return createFaceProvider(config.face, {
    profile: 'interactive',
    pool,
    redis,
    rekognitionClient: config.rekognitionClient,
  });
}

/**
 * The api's Rekognition provider: face search (the only synchronous Rekognition use) and face
 * deletion, on the `interactive` profile (fails fast). The client gets REKOGNITION_* region and
 * keys explicitly (config.rekognitionClient; ADR 0008 §1), never AWS_ENDPOINT_URL or, off AWS,
 * the default chain. `limiters` default to the Redis token buckets shared with the worker.
 */
export function interactiveFaceProvider(
  config: Pick<ApiConfig, 'face' | 'rekognitionClient'>,
  redis: Parameters<typeof createRedisRekognitionLimiters>[0],
  limiters: RekognitionLimiters = createRedisRekognitionLimiters(
    redis,
    config.face.rekognition,
    'interactive',
  ),
): RekognitionFaceProvider {
  if (config.rekognitionClient === null) {
    throw new Error('FACE_PROVIDER=rekognition needs the REKOGNITION_* client settings');
  }
  return RekognitionFaceProvider.create(
    config.face.rekognition,
    'interactive',
    limiters,
    config.rekognitionClient,
  );
}
