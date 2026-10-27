import { describe, expect, it } from 'vitest';
import {
  isNonPublicStorageHost,
  isR2Host,
  loadMediaBrowserOrigins,
  loadMediaStorageConfig,
  loadMediaUrlSignerConfig,
  mediaUrlOrigin,
  storageS3ClientOptions,
} from './storage';

const R2 = 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com';
const keys = { STORAGE_ACCESS_KEY_ID: 'AKIDEXAMPLE', STORAGE_SECRET_ACCESS_KEY: 's3cr3t-value' };
const r2 = {
  APP_STAGE: 'prod',
  MEDIA_BUCKET: 'shotx-prod-media',
  STORAGE_ENDPOINT_URL: R2,
  STORAGE_REGION: 'auto',
  STORAGE_ORIGINALS_CLASS: 'STANDARD',
  ...keys,
};
/** A copy of `env` without `names`. */
const without = (env: Record<string, string>, ...names: string[]) =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !names.includes(k)));

const local = {
  APP_STAGE: 'local',
  MEDIA_BUCKET: 'shotx-local-media',
  S3_FORCE_PATH_STYLE: 'true',
  STORAGE_ENDPOINT_URL: 'http://localhost:4566',
  STORAGE_REGION: 'ap-southeast-1',
  STORAGE_ACCESS_KEY_ID: 'test',
  STORAGE_SECRET_ACCESS_KEY: 'test',
};

describe('loadMediaStorageConfig', () => {
  it('without STORAGE_ENDPOINT_URL is AWS S3 as before: AWS_REGION, AWS_ENDPOINT_URL, default chain', () => {
    expect(loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-prod-media' })).toEqual({
      bucket: 'shotx-prod-media',
      forcePathStyle: false,
      originalsStorageClass: 'INTELLIGENT_TIERING',
      client: {
        endpointUrl: null,
        region: 'ap-southeast-1',
        credentials: null,
        forcePathStyle: false,
        explicit: false,
      },
    });
    const legacy = loadMediaStorageConfig({
      MEDIA_BUCKET: 'shotx-local-media',
      S3_FORCE_PATH_STYLE: 'true',
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      AWS_REGION: 'us-east-1',
    });
    expect(legacy.forcePathStyle).toBe(true);
    expect(legacy.client).toEqual({
      endpointUrl: 'http://localhost:4566',
      region: 'us-east-1',
      credentials: null,
      forcePathStyle: true,
      explicit: false,
    });
    expect(() => loadMediaStorageConfig({})).toThrow(/at MEDIA_BUCKET\b/);
  });

  it('with STORAGE_ENDPOINT_URL uses explicit region and keys, ignoring AWS_*', () => {
    const config = loadMediaStorageConfig({
      ...r2,
      AWS_ENDPOINT_URL: 'http://localhost:4566',
      AWS_REGION: 'us-west-2',
    });
    expect(config).toEqual({
      bucket: 'shotx-prod-media',
      forcePathStyle: false,
      originalsStorageClass: 'STANDARD',
      client: {
        endpointUrl: R2,
        region: 'auto',
        credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 's3cr3t-value' },
        forcePathStyle: false,
        explicit: true,
      },
    });
  });

  it('requires region and both keys with an endpoint, and refuses them without one', () => {
    expect(() => loadMediaStorageConfig(without(r2, 'STORAGE_REGION'))).toThrow(
      /STORAGE_REGION is required/,
    );
    expect(() => loadMediaStorageConfig(without(r2, 'STORAGE_SECRET_ACCESS_KEY'))).toThrow(
      /are required with STORAGE_ENDPOINT_URL/,
    );
    expect(() =>
      loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-media', STORAGE_REGION: 'auto' }),
    ).toThrow(/STORAGE_REGION needs STORAGE_ENDPOINT_URL/);
    expect(() => loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-media', ...keys })).toThrow(
      /need STORAGE_ENDPOINT_URL/,
    );
  });

  it('refuses a loopback, private or plain-http endpoint outside APP_STAGE=local', () => {
    for (const url of [
      'http://localhost:4566',
      'https://localhost:4566',
      'https://127.0.0.1:9000',
      'https://10.0.0.5',
      'https://[::1]:9000',
      'https://minio:9000',
      'https://storage.internal',
    ]) {
      expect(() => loadMediaStorageConfig({ ...r2, STORAGE_ENDPOINT_URL: url }), url).toThrow(
        /must not be a localhost, loopback or private host/,
      );
      expect(() =>
        loadMediaStorageConfig({ ...r2, APP_STAGE: undefined, STORAGE_ENDPOINT_URL: url }),
      ).toThrow();
    }
    expect(() =>
      loadMediaStorageConfig({ ...r2, STORAGE_ENDPOINT_URL: 'http://s3.example.com' }),
    ).toThrow(/must be https/);
    // Local development (also a production build run locally) may use LocalStack.
    expect(loadMediaStorageConfig(local).client.endpointUrl).toBe('http://localhost:4566');
    expect(loadMediaStorageConfig({ ...local, NODE_ENV: 'production' }).client.explicit).toBe(true);
  });

  it('refuses INTELLIGENT_TIERING on R2 and accepts STANDARD_IA', () => {
    expect(() => loadMediaStorageConfig(without(r2, 'STORAGE_ORIGINALS_CLASS'))).toThrow(
      /STANDARD or STANDARD_IA on R2/,
    );
    expect(
      loadMediaStorageConfig({ ...r2, STORAGE_ORIGINALS_CLASS: 'STANDARD_IA' })
        .originalsStorageClass,
    ).toBe('STANDARD_IA');
    // LocalStack and AWS accept Intelligent-Tiering.
    expect(loadMediaStorageConfig(local).originalsStorageClass).toBe('INTELLIGENT_TIERING');
  });

  it.each([
    ['MEDIA_BUCKET', 'Shotx-Media'],
    ['MEDIA_BUCKET', 'ab'],
    ['MEDIA_BUCKET', 'shotx..media'],
    ['MEDIA_BUCKET', '-shotx'],
    ['MEDIA_BUCKET', 's3://shotx-media'],
    ['S3_FORCE_PATH_STYLE', 'maybe'],
    ['STORAGE_ORIGINALS_CLASS', 'GLACIER'],
    ['STORAGE_ENDPOINT_URL', 'r2.example.com'],
    ['STORAGE_ENDPOINT_URL', 'https://user:pw@r2.example.com'],
    ['STORAGE_ENDPOINT_URL', 'https://r2.example.com/bucket'],
    ['STORAGE_REGION', 'Singapore'],
    ['STORAGE_ACCESS_KEY_ID', 'has space'],
    ['STORAGE_SECRET_ACCESS_KEY', ' '],
  ])('rejects %s=%j', (key, value) => {
    expect(() => loadMediaStorageConfig({ ...r2, [key]: value })).toThrow(
      new RegExp(`at ${key}\\b`),
    );
  });
});

describe('storageS3ClientOptions', () => {
  it('passes endpoint and credentials explicitly with STORAGE_ENDPOINT_URL', () => {
    expect(storageS3ClientOptions(loadMediaStorageConfig(r2))).toEqual({
      region: 'auto',
      endpoint: R2,
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 's3cr3t-value' },
      forcePathStyle: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  });

  it('leaves credentials to the default chain on the AWS path', () => {
    const options = storageS3ClientOptions(loadMediaStorageConfig({ MEDIA_BUCKET: 'shotx-media' }));
    expect(options).toEqual({
      region: 'ap-southeast-1',
      forcePathStyle: false,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    expect('endpoint' in options || 'credentials' in options).toBe(false);
  });
});

describe('loadMediaUrlSignerConfig', () => {
  it('defaults to cloudfront and ignores storage settings then', () => {
    expect(loadMediaUrlSignerConfig({ APP_STAGE: 'prod' })).toEqual({ signer: 'cloudfront' });
    expect(loadMediaUrlSignerConfig(r2)).toEqual({ signer: 'cloudfront' });
  });

  it('allows s3-presign on any stage with the STORAGE_* endpoint and keys', () => {
    expect(loadMediaUrlSignerConfig({ ...r2, MEDIA_URL_SIGNER: 's3-presign' })).toEqual({
      signer: 's3-presign',
      endpointUrl: R2,
      region: 'auto',
      accessKeyId: 'AKIDEXAMPLE',
      secretAccessKey: 's3cr3t-value',
      keySource: 'storage',
    });
    expect(loadMediaUrlSignerConfig({ ...local, MEDIA_URL_SIGNER: 's3-presign' })).toMatchObject({
      signer: 's3-presign',
      endpointUrl: 'http://localhost:4566',
    });
  });

  it('signs with the read-only STORAGE_SIGNING_* keys when set', () => {
    const signing = {
      STORAGE_SIGNING_ACCESS_KEY_ID: 'readonly-id',
      STORAGE_SIGNING_SECRET_ACCESS_KEY: 'readonly-secret',
    };
    expect(loadMediaUrlSignerConfig({ ...r2, ...signing, MEDIA_URL_SIGNER: 's3-presign' })).toEqual(
      {
        signer: 's3-presign',
        endpointUrl: R2,
        region: 'auto',
        accessKeyId: 'readonly-id',
        secretAccessKey: 'readonly-secret',
        keySource: 'signing',
      },
    );
    // The api's own keys are not needed for signing then (the storage loader still needs them).
    const noApiKeys = without(r2, 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY');
    expect(
      loadMediaUrlSignerConfig({ ...noApiKeys, ...signing, MEDIA_URL_SIGNER: 's3-presign' }),
    ).toMatchObject({ accessKeyId: 'readonly-id', keySource: 'signing' });
    expect(() =>
      loadMediaUrlSignerConfig({
        ...r2,
        STORAGE_SIGNING_ACCESS_KEY_ID: 'readonly-id',
        MEDIA_URL_SIGNER: 's3-presign',
      }),
    ).toThrow(/set both STORAGE_SIGNING_ACCESS_KEY_ID and STORAGE_SIGNING_SECRET_ACCESS_KEY/);
    expect(() => loadMediaUrlSignerConfig({ ...r2, ...signing })).toThrow(
      /STORAGE_SIGNING_ACCESS_KEY_ID needs MEDIA_URL_SIGNER=s3-presign/,
    );
    expect(() =>
      loadMediaUrlSignerConfig({
        ...r2,
        ...signing,
        STORAGE_SIGNING_SECRET_ACCESS_KEY: ' ',
        MEDIA_URL_SIGNER: 's3-presign',
      }),
    ).toThrow(/STORAGE_SIGNING_SECRET_ACCESS_KEY/);
  });

  it('never signs with AWS keys or without an explicit endpoint', () => {
    expect(() =>
      loadMediaUrlSignerConfig({
        APP_STAGE: 'local',
        MEDIA_URL_SIGNER: 's3-presign',
        AWS_ENDPOINT_URL: 'http://localhost:4566',
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      }),
    ).toThrow(/needs STORAGE_ENDPOINT_URL/);
    const noKey = without(local, 'STORAGE_ACCESS_KEY_ID');
    expect(() => loadMediaUrlSignerConfig({ ...noKey, MEDIA_URL_SIGNER: 's3-presign' })).toThrow(
      /are required/,
    );
  });

  it('refuses a loopback endpoint outside APP_STAGE=local', () => {
    expect(() =>
      loadMediaUrlSignerConfig({ ...local, APP_STAGE: 'staging', MEDIA_URL_SIGNER: 's3-presign' }),
    ).toThrow(/must not be a localhost, loopback or private host/);
  });
});

describe('mediaUrlOrigin', () => {
  it('is null for cloudfront (same origin) and the endpoint origin for s3-presign', () => {
    expect(mediaUrlOrigin({ signer: 'cloudfront' })).toBeNull();
    expect(
      mediaUrlOrigin(loadMediaUrlSignerConfig({ ...r2, MEDIA_URL_SIGNER: 's3-presign' })),
    ).toBe(R2);
  });
});

describe('loadMediaBrowserOrigins', () => {
  it('AWS path: the bucket on the regional endpoint plus AWS_ENDPOINT_URL, no media origin', () => {
    expect(loadMediaBrowserOrigins({ MEDIA_BUCKET: 'shotx-prod-media' })).toEqual({
      upload: ['https://shotx-prod-media.s3.ap-southeast-1.amazonaws.com'],
      media: [],
    });
    expect(loadMediaBrowserOrigins({}).upload).toEqual([
      'https://*.s3.ap-southeast-1.amazonaws.com',
    ]);
  });

  it('R2: one origin for uploads and media with path-style, without needing the keys', () => {
    const web = without(r2, 'STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY');
    expect(
      loadMediaBrowserOrigins({
        ...web,
        S3_FORCE_PATH_STYLE: 'true',
        MEDIA_URL_SIGNER: 's3-presign',
      }),
    ).toEqual({ upload: [R2], media: [R2] });
    expect(loadMediaBrowserOrigins({ ...web, MEDIA_URL_SIGNER: 's3-presign' })).toEqual({
      upload: [`https://shotx-prod-media.${new URL(R2).host}`],
      media: [R2],
    });
  });

  it('local: LocalStack through STORAGE_ENDPOINT_URL', () => {
    expect(loadMediaBrowserOrigins({ ...local, MEDIA_URL_SIGNER: 's3-presign' })).toEqual({
      upload: ['http://localhost:4566'],
      media: ['http://localhost:4566'],
    });
  });

  it('applies the signer and stage rules', () => {
    expect(() => loadMediaBrowserOrigins({ MEDIA_URL_SIGNER: 's3-presign' })).toThrow(
      /needs STORAGE_ENDPOINT_URL/,
    );
    expect(() => loadMediaBrowserOrigins({ ...local, APP_STAGE: 'prod' })).toThrow(
      /must not be a localhost/,
    );
  });
});

describe('storage hosts', () => {
  it('classifies non-public hosts', () => {
    for (const host of [
      'localhost',
      'a.localhost',
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.20.0.2',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '[::1]',
      '[::]',
      '[fd00::1]',
      'minio',
      'nas.local',
      'r2.internal',
      'box.home.arpa',
    ]) {
      expect(isNonPublicStorageHost(host), host).toBe(true);
    }
    for (const host of [
      new URL(R2).hostname,
      's3.ap-southeast-1.amazonaws.com',
      '8.8.8.8',
      '[2606:4700::1]',
    ]) {
      expect(isNonPublicStorageHost(host), host).toBe(false);
    }
  });

  it('recognizes R2 endpoints', () => {
    expect(isR2Host(new URL(R2).hostname)).toBe(true);
    expect(isR2Host('abc.eu.r2.cloudflarestorage.com')).toBe(true);
    expect(isR2Host('s3.amazonaws.com')).toBe(false);
  });
});
