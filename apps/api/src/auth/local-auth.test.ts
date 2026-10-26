import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { CloudFrontMediaUrlSigner } from '../infra/cloudfront-signer';
import { S3PresignMediaUrlSigner } from '../infra/s3-presign-signer';
import { SqsQueueSender } from '../infra/sqs-queue';
import { BullMqQueueSender } from '../infra/bullmq-queue';
import { testConfig } from '../testing/fakes';
import { shotxEnv, TEST_SHOTX_AUTH_ENV } from '../testing/shotx-auth';
import { mediaUrlSigner, queueSender, tokenVerifier } from '../wiring';
import { CognitoTokenVerifier } from './cognito-verifier';
import { ShotxTokenVerifier } from './shotx-tokens';

describe('S3PresignMediaUrlSigner', () => {
  const now = new Date('2026-10-26T01:02:03Z');
  const options = {
    endpointUrl: 'http://localhost:4566',
    region: 'ap-southeast-1',
    bucket: 'shotx-local-media',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    now: () => now,
  };
  const key =
    'derived/0199b2a0-0000-7000-8000-000000000001/0199b2a0-0000-7000-8000-000000000002/thumb.webp';

  function sdkClient(): S3Client {
    const client = new S3Client({
      region: options.region,
      endpoint: options.endpointUrl,
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    // The SDK adds `x-id=GetObject` before signing; media URLs don't carry it.
    client.middlewareStack.add(
      (next) => (args) => {
        const request = args.request as { query?: Record<string, unknown> };
        delete request.query?.['x-id'];
        return next(args);
      },
      { step: 'build' },
    );
    return client;
  }

  it('signs exactly like the AWS SDK presigner', async () => {
    const signer = new S3PresignMediaUrlSigner(options);
    const disposition = 'attachment; filename="รูป 1.jpg"';
    const ours = new URL(
      signer.sign(key, new Date(now.getTime() + 600_000), { contentDisposition: disposition }),
    );
    const client = sdkClient();
    const sdk = new URL(
      await getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: options.bucket,
          Key: key,
          ResponseContentDisposition: disposition,
        }),
        { expiresIn: 600, signingDate: now },
      ),
    );
    expect(ours.pathname).toBe(sdk.pathname);
    expect(ours.searchParams.get('X-Amz-Signature')).toBe(sdk.searchParams.get('X-Amz-Signature'));
  });

  it('encodes non-ASCII and reserved characters in the key like the SDK', async () => {
    const thaiKey =
      "originals/0199b2a0-0000-7000-8000-000000000001/0199b2a0-0000-7000-8000-000000000002/รูป (1)!'.jpg";
    const signer = new S3PresignMediaUrlSigner(options);
    const ours = new URL(signer.sign(thaiKey, new Date(now.getTime() + 600_000)));
    const sdk = new URL(
      await getSignedUrl(
        sdkClient(),
        new GetObjectCommand({ Bucket: options.bucket, Key: thaiKey }),
        {
          expiresIn: 600,
          signingDate: now,
        },
      ),
    );
    expect(ours.pathname).toBe(sdk.pathname);
    expect(ours.searchParams.get('X-Amz-Signature')).toBe(sdk.searchParams.get('X-Amz-Signature'));
  });

  it('refuses keys the platform did not build', () => {
    const signer = new S3PresignMediaUrlSigner(options);
    expect(() => signer.sign('../secret', new Date(now.getTime() + 1000))).toThrow(RangeError);
  });
});

describe('adapter wiring', () => {
  const local = {
    APP_STAGE: 'local',
    NODE_ENV: 'development',
    ...TEST_SHOTX_AUTH_ENV,
    AUTH_PROVIDER: 'local',
    MEDIA_URL_SIGNER: 's3-presign',
    AWS_ENDPOINT_URL: 'http://localhost:4566',
    AWS_ACCESS_KEY_ID: 'test',
    AWS_SECRET_ACCESS_KEY: 'test',
  };

  it('uses Cognito, CloudFront and SQS by default', async () => {
    const config = testConfig();
    expect(config.auth).toEqual({ provider: 'cognito' });
    expect(config.shotxAuth).toBeNull();
    expect(tokenVerifier(config)).toBeInstanceOf(CognitoTokenVerifier);
    expect(mediaUrlSigner(config)).toBeInstanceOf(CloudFrontMediaUrlSigner);
    const queue = queueSender(config);
    expect(queue.sender).toBeInstanceOf(SqsQueueSender);
    await queue.close();
  });

  it('uses the API-issued tokens with AUTH_PROVIDER=shotx', () => {
    const config = testConfig(shotxEnv());
    expect(config.cognito).toBeNull();
    expect(config.shotxAuth?.devLogin).toBeNull();
    expect(tokenVerifier(config)).toBeInstanceOf(ShotxTokenVerifier);
  });

  it('uses BullMQ with QUEUE_BACKEND=bullmq (no queue URLs needed)', async () => {
    const config = testConfig({ QUEUE_BACKEND: 'bullmq', FACES_QUEUE_URL: '', ZIP_QUEUE_URL: '' });
    expect(config.queues).toMatchObject({ backend: 'bullmq', prefix: 'shotx:test:bull' });
    const queue = queueSender(config);
    expect(queue.sender).toBeInstanceOf(BullMqQueueSender);
    await queue.close();
  });

  it('needs no Cognito or CloudFront variables in local mode', () => {
    const config = testConfig({
      ...local,
      COGNITO_USER_POOL_ID: '',
      COGNITO_WEB_CLIENT_ID: '',
      COGNITO_DOMAIN: '',
      COGNITO_ADMIN_USER_POOL_ID: '',
      COGNITO_ADMIN_CLIENT_ID: '',
      COGNITO_ADMIN_DOMAIN: '',
      CLOUDFRONT_MEDIA_BASE_URL: '',
      CLOUDFRONT_KEY_PAIR_ID: '',
      CLOUDFRONT_PRIVATE_KEY: '',
    });
    expect(config.cognito).toBeNull();
    expect(config.cloudFront).toBeNull();
    expect(config.shotxAuth?.devLogin).toEqual({ pool: 'users' });
    expect(tokenVerifier(config)).toBeInstanceOf(ShotxTokenVerifier);
    expect(mediaUrlSigner(config)).toBeInstanceOf(S3PresignMediaUrlSigner);
  });

  it('refuses s3-presign without AWS_ENDPOINT_URL, and local options on other stages', () => {
    expect(() => mediaUrlSigner(testConfig({ ...local, AWS_ENDPOINT_URL: '' }))).toThrow(
      /needs AWS_ENDPOINT_URL/,
    );
    expect(() => testConfig({ ...local, APP_STAGE: 'staging' })).toThrow(/needs APP_STAGE=local/);
  });
});
