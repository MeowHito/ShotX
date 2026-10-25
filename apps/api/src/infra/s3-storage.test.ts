import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  NoSuchUpload,
  NotFound,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { createS3Client, S3ObjectStorage } from './s3-storage';

// No test reaches AWS: the client's `send` is mocked, and presigning is local.

const s3Mock = mockClient(S3Client);
const key = 'originals/p/f/IMG.jpg';
const noSuchUpload = () =>
  new NoSuchUpload({ message: 'gone', $metadata: { httpStatusCode: 404 } });

function storage() {
  const client = createS3Client(
    { region: 'ap-southeast-1', endpointUrl: null },
    { bucket: 'shotx-test-media', forcePathStyle: false },
  );
  return new S3ObjectStorage(client, 'shotx-test-media');
}

afterEach(() => s3Mock.reset());

describe('S3ObjectStorage', () => {
  it('creates Intelligent-Tiering multipart uploads with the content type', async () => {
    s3Mock.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    expect(await storage().createMultipartUpload({ key, contentType: 'image/jpeg' })).toBe('u1');
    expect(s3Mock.commandCalls(CreateMultipartUploadCommand)[0]?.args[0].input).toEqual({
      Bucket: 'shotx-test-media',
      Key: key,
      ContentType: 'image/jpeg',
      StorageClass: 'INTELLIGENT_TIERING',
    });
  });

  it('lists every page of parts, ascending, and null for a missing upload', async () => {
    s3Mock
      .on(ListPartsCommand, { PartNumberMarker: undefined })
      .resolves({
        Parts: [{ PartNumber: 2, ETag: '"b"', Size: 5 }],
        IsTruncated: true,
        NextPartNumberMarker: '2',
      })
      .on(ListPartsCommand, { PartNumberMarker: '2' })
      .resolves({ Parts: [{ PartNumber: 1, ETag: '"a"', Size: 5 }], IsTruncated: false });
    expect(await storage().listParts({ key, uploadId: 'u1' })).toEqual([
      { partNumber: 1, etag: '"a"', size: 5 },
      { partNumber: 2, etag: '"b"', size: 5 },
    ]);
    s3Mock.reset();
    s3Mock.on(ListPartsCommand).rejects(noSuchUpload());
    expect(await storage().listParts({ key, uploadId: 'u1' })).toBeNull();
  });

  it('completes with the given parts; a missing upload is false, other errors throw', async () => {
    s3Mock.on(CompleteMultipartUploadCommand).resolves({});
    const s = storage();
    expect(
      await s.completeMultipartUpload({
        key,
        uploadId: 'u1',
        parts: [{ partNumber: 1, etag: '"a"' }],
      }),
    ).toBe(true);
    expect(
      s3Mock.commandCalls(CompleteMultipartUploadCommand)[0]?.args[0].input.MultipartUpload,
    ).toEqual({
      Parts: [{ PartNumber: 1, ETag: '"a"' }],
    });
    s3Mock.on(CompleteMultipartUploadCommand).rejects(noSuchUpload());
    expect(await s.completeMultipartUpload({ key, uploadId: 'u1', parts: [] })).toBe(false);
    s3Mock.on(CompleteMultipartUploadCommand).rejects(new Error('boom'));
    await expect(s.completeMultipartUpload({ key, uploadId: 'u1', parts: [] })).rejects.toThrow(
      'boom',
    );
  });

  it('ignores aborting a missing upload and maps HeadObject 404 to null', async () => {
    s3Mock.on(AbortMultipartUploadCommand).rejects(noSuchUpload());
    await expect(storage().abortMultipartUpload({ key, uploadId: 'u1' })).resolves.toBeUndefined();
    s3Mock
      .on(HeadObjectCommand)
      .rejects(new NotFound({ message: 'nf', $metadata: { httpStatusCode: 404 } }));
    expect(await storage().headObject(key)).toBeNull();
    // Without s3:ListBucket, S3 answers a missing key with 403.
    const forbidden = Object.assign(new Error('Forbidden'), {
      name: 'Forbidden',
      $metadata: { httpStatusCode: 403 },
    });
    s3Mock.on(HeadObjectCommand).rejects(forbidden);
    expect(await storage().headObject(key)).toBeNull();
    s3Mock.on(HeadObjectCommand).rejects(
      Object.assign(new Error('Slow Down'), {
        name: 'SlowDown',
        $metadata: { httpStatusCode: 503 },
      }),
    );
    await expect(storage().headObject(key)).rejects.toThrow('Slow Down');
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 42 });
    expect(await storage().headObject(key)).toEqual({ size: 42 });
  });

  it('presigns UploadPart URLs without checksum parameters the browser could not satisfy', async () => {
    const client = new S3Client({
      region: 'ap-southeast-1',
      credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' },
      requestChecksumCalculation: 'WHEN_REQUIRED',
    });
    const url = new URL(
      await new S3ObjectStorage(client, 'shotx-test-media').presignUploadPart({
        key,
        uploadId: 'u1',
        partNumber: 3,
        expiresInSeconds: 600,
      }),
    );
    expect(url.searchParams.get('partNumber')).toBe('3');
    expect(url.searchParams.get('uploadId')).toBe('u1');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(
      [...url.searchParams.keys()].filter((k) => k.toLowerCase().includes('checksum')),
    ).toEqual([]);
  });
});
