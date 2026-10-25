import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { AwsConfig, MediaStorageConfig } from '@shotx/shared';
import type { ObjectStorage, UploadedPart } from '../tokens';

/**
 * The S3 client for the media bucket. Checksums only when required: otherwise SDK defaults put
 * `x-amz-checksum-*` into presigned part URLs and browsers' PUTs would fail.
 */
export function createS3Client(aws: AwsConfig, storage: MediaStorageConfig): S3Client {
  return new S3Client({
    region: aws.region,
    ...(aws.endpointUrl === null ? {} : { endpoint: aws.endpointUrl }),
    forcePathStyle: storage.forcePathStyle,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function errorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { name, Code } = error as { name?: unknown; Code?: unknown };
  return typeof Code === 'string' ? Code : typeof name === 'string' ? name : undefined;
}

const isNoSuchUpload = (error: unknown) => errorName(error) === 'NoSuchUpload';

function httpStatus(error: unknown): number | undefined {
  const meta = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return meta?.httpStatusCode;
}

/** Most parts one ListParts page returns. */
const LIST_PARTS_PAGE = 1000;

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async createMultipartUpload(input: { key: string; contentType: string }): Promise<string> {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        StorageClass: 'INTELLIGENT_TIERING',
      }),
    );
    if (out.UploadId === undefined || out.UploadId === '') {
      throw new Error('CreateMultipartUpload returned no UploadId');
    }
    return out.UploadId;
  }

  presignUploadPart(input: {
    key: string;
    uploadId: string;
    partNumber: number;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.partNumber,
      }),
      { expiresIn: input.expiresInSeconds },
    );
  }

  async listParts(input: { key: string; uploadId: string }): Promise<UploadedPart[] | null> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    try {
      for (;;) {
        const out = await this.client.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: input.key,
            UploadId: input.uploadId,
            MaxParts: LIST_PARTS_PAGE,
            ...(marker === undefined ? {} : { PartNumberMarker: marker }),
          }),
        );
        for (const p of out.Parts ?? []) {
          if (p.PartNumber === undefined || p.ETag === undefined || p.Size === undefined) continue;
          parts.push({ partNumber: p.PartNumber, etag: p.ETag, size: p.Size });
        }
        if (out.IsTruncated !== true || out.NextPartNumberMarker === undefined) break;
        marker = out.NextPartNumberMarker;
      }
    } catch (error) {
      if (isNoSuchUpload(error)) return null;
      throw error;
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  async completeMultipartUpload(input: {
    key: string;
    uploadId: string;
    parts: { partNumber: number; etag: string }[];
  }): Promise<boolean> {
    try {
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          MultipartUpload: {
            Parts: input.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
      return true;
    } catch (error) {
      if (isNoSuchUpload(error)) return false;
      throw error;
    }
  }

  async abortMultipartUpload(input: { key: string; uploadId: string }): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: input.key,
          UploadId: input.uploadId,
        }),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) return;
      throw error;
    }
  }

  async headObject(key: string): Promise<{ size: number } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0 };
    } catch (error) {
      if (errorName(error) === 'NotFound' || httpStatus(error) === 404) return null;
      throw error;
    }
  }
}
