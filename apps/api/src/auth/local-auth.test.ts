import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { bucketedExpiry, S3_PRESIGN_MAX_EXPIRES_SECONDS } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { CloudFrontMediaUrlSigner } from '../infra/cloudfront-signer';
import { S3PresignMediaUrlSigner } from '../infra/s3-presign-signer';
import { SqsQueueSender } from '../infra/sqs-queue';
import { BullMqQueueSender } from '../infra/bullmq-queue';
import { apiSendsMediaJobs } from '../config';
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
    // 1 s: the signing date is `now` itself, as in the SDK comparisons below.
    signingDateBucketSeconds: 1,
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

  it('signs one key in one bucket window byte-identically (browser cache hits)', async () => {
    let clock = new Date('2026-10-26T01:02:03Z');
    const signer = new S3PresignMediaUrlSigner({
      ...options,
      signingDateBucketSeconds: 300,
      now: () => clock,
    });
    const expiresAt = bucketedExpiry(clock, 3600, 300);
    const first = signer.sign(key, expiresAt);
    clock = new Date('2026-10-26T01:04:59Z');
    expect(signer.sign(key, bucketedExpiry(clock, 3600, 300))).toBe(first);
    const url = new URL(first);
    // Signing date rounded down to the window, expiry = bucketed expiry - signing date.
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261026T010000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe(String(3600 + 300));
    // Still exactly what the AWS SDK signs for that date and lifetime.
    const sdk = new URL(
      await getSignedUrl(sdkClient(), new GetObjectCommand({ Bucket: options.bucket, Key: key }), {
        expiresIn: 3900,
        signingDate: new Date('2026-10-26T01:00:00Z'),
      }),
    );
    expect(url.searchParams.get('X-Amz-Signature')).toBe(sdk.searchParams.get('X-Amz-Signature'));
    // The next window gives a new URL; lifetimes are capped at 7 days.
    clock = new Date('2026-10-26T01:05:00Z');
    expect(signer.sign(key, bucketedExpiry(clock, 3600, 300))).not.toBe(first);
    const far = new URL(signer.sign(key, new Date(clock.getTime() + 30 * 86_400_000)));
    expect(far.searchParams.get('X-Amz-Expires')).toBe(String(S3_PRESIGN_MAX_EXPIRES_SECONDS));
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
    STORAGE_ENDPOINT_URL: 'http://localhost:4566',
    STORAGE_REGION: 'ap-southeast-1',
    STORAGE_ACCESS_KEY_ID: 'test',
    STORAGE_SECRET_ACCESS_KEY: 'test',
  };

  it('uses Cognito, CloudFront and SQS by default', async () => {
    const config = testConfig();
    // SQS: the api sends to faces and zip only (S3 events feed media); no MEDIA_QUEUE_URL needed.
    expect(config.queues).toMatchObject({ backend: 'sqs' });
    expect(Object.keys(config.queues.backend === 'sqs' ? config.queues.urls : {})).toEqual([
      'faces',
      'zip',
    ]);
    expect(apiSendsMediaJobs(config)).toBe(false);
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
    const config = testConfig({
      QUEUE_BACKEND: 'bullmq',
      FACES_QUEUE_URL: '',
      ZIP_QUEUE_URL: '',
    });
    expect(config.queues).toMatchObject({ backend: 'bullmq', prefix: 'shotx:test:bull' });
    expect(
      Object.keys(config.queues.backend === 'bullmq' ? config.queues.queues : {}).sort(),
    ).toEqual(['faces', 'media', 'zip']);
    expect(apiSendsMediaJobs(config)).toBe(true);
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

  it('s3-presign: needs the STORAGE_* endpoint and keys, works on any stage with a public https endpoint', () => {
    expect(() => testConfig({ ...local, STORAGE_ENDPOINT_URL: '', STORAGE_REGION: '' })).toThrow(
      /needs STORAGE_ENDPOINT_URL/,
    );
    // AWS keys are never used for presigning.
    expect(() =>
      testConfig({ ...local, STORAGE_ACCESS_KEY_ID: '', STORAGE_SECRET_ACCESS_KEY: '' }),
    ).toThrow(/STORAGE_ACCESS_KEY_ID/);
    const r2 = testConfig({
      MEDIA_URL_SIGNER: 's3-presign',
      STORAGE_ENDPOINT_URL: 'https://0123456789abcdef.r2.cloudflarestorage.com',
      STORAGE_REGION: 'auto',
      STORAGE_ACCESS_KEY_ID: 'r2key',
      STORAGE_SECRET_ACCESS_KEY: 'r2secret',
      STORAGE_ORIGINALS_CLASS: 'STANDARD',
    });
    const signer = mediaUrlSigner(r2);
    expect(signer).toBeInstanceOf(S3PresignMediaUrlSigner);
    const url = new URL(
      signer.sign(
        'derived/0199b2a0-0000-7000-8000-000000000001/0199b2a0-0000-7000-8000-000000000002/thumb.webp',
        new Date(Date.now() + 600_000),
      ),
    );
    expect(url.origin).toBe('https://0123456789abcdef.r2.cloudflarestorage.com');
    expect(url.pathname.startsWith('/shotx-test-media/derived/')).toBe(true);
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(
      /^r2key\/\d{8}\/auto\/s3\/aws4_request$/,
    );
    // A localhost endpoint only on APP_STAGE=local; the dev login only there too.
    expect(() => testConfig({ ...local, APP_STAGE: 'staging', AUTH_PROVIDER: 'shotx' })).toThrow(
      /localhost/,
    );
    expect(() => testConfig({ ...local, APP_STAGE: 'staging', NODE_ENV: 'test' })).toThrow();
  });
});
