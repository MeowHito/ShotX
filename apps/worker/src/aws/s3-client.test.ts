import { loadMediaStorageConfig } from '@shotx/shared';
import { describe, expect, it } from 'vitest';
import { workerS3ClientOptions } from './s3-client';

describe('workerS3ClientOptions', () => {
  it('keeps the SDK default checksums on AWS S3 (no explicit endpoint)', () => {
    const options = workerS3ClientOptions(
      loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-prod-media', AWS_REGION: 'ap-southeast-1' }),
    );
    expect(options).toEqual({ region: 'ap-southeast-1', forcePathStyle: false });
  });

  it('asks for checksums only when required on an explicit endpoint (R2, LocalStack)', () => {
    const options = workerS3ClientOptions(
      loadMediaStorageConfig({
        APP_STAGE: 'prod',
        MEDIA_BUCKET: 'shotx-prod-media',
        STORAGE_ENDPOINT_URL: 'https://0123456789abcdef.r2.cloudflarestorage.com',
        STORAGE_REGION: 'auto',
        STORAGE_ACCESS_KEY_ID: 'key',
        STORAGE_SECRET_ACCESS_KEY: 'secret',
        STORAGE_ORIGINALS_CLASS: 'STANDARD',
      }),
    );
    expect(options).toMatchObject({
      region: 'auto',
      endpoint: 'https://0123456789abcdef.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'key', secretAccessKey: 'secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  });
});
