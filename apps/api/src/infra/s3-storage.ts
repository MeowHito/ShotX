import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  type MediaStorageConfig,
  type OriginalsStorageClass,
  storageS3ClientOptions,
} from '@shotx/shared';
import type { BucketUsage, ObjectStorage, UploadedPart } from '../tokens';

/**
 * The S3 client for the media bucket (R2, LocalStack, MinIO or AWS S3), from the shared
 * storageS3ClientOptions: an explicit endpoint and keys whenever STORAGE_ENDPOINT_URL is set (never
 * AWS_ENDPOINT_URL or the default chain there), and checksums only when required (SDK defaults put
 * `x-amz-checksum-*` into presigned part URLs and browsers' PUTs would fail).
 */
export function createS3Client(storage: Pick<MediaStorageConfig, 'client'>): S3Client {
  return new S3Client(storageS3ClientOptions(storage));
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
    /** STORAGE_ORIGINALS_CLASS (R2 accepts only STANDARD and STANDARD_IA). */
    private readonly originalsStorageClass: OriginalsStorageClass,
  ) {}

  async createMultipartUpload(input: { key: string; contentType: string }): Promise<string> {
    const out = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        StorageClass: this.originalsStorageClass,
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

  /**
   * A presigned single PutObject URL (design images, ADR 0013) that signs `content-type` and
   * `content-length`: the PUT must send exactly that type and exactly `contentLength` bytes (the
   * browser sets Content-Length from the body). The object gets the bucket's default class.
   */
  presignPutObject(input: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInSeconds: number;
  }): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      {
        expiresIn: input.expiresInSeconds,
        // Without this the presigner leaves content-type unsigned.
        signableHeaders: new Set(['content-type', 'content-length']),
      },
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

  /**
   * HeadObject. The API's role has no s3:ListBucket, so S3 answers a missing key with 403, not
   * 404: both mean "no such object" here.
   */
  async headObject(key: string): Promise<{ size: number } | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: out.ContentLength ?? 0 };
    } catch (error) {
      const status = httpStatus(error);
      if (errorName(error) === 'NotFound' || status === 404 || status === 403) return null;
      throw error;
    }
  }

  /** ListObjectsV2 over the whole bucket, 1000 keys a page, summed by first path segment. */
  async bucketUsage(): Promise<BucketUsage> {
    const byPrefix = new Map<string, { objectCount: number; bytes: number }>();
    let objectCount = 0;
    let totalBytes = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token, MaxKeys: 1000 }),
      );
      for (const object of page.Contents ?? []) {
        const size = object.Size ?? 0;
        const key = object.Key ?? '';
        const slash = key.indexOf('/');
        const prefix = slash < 0 ? '' : key.slice(0, slash + 1);
        const entry = byPrefix.get(prefix) ?? { objectCount: 0, bytes: 0 };
        entry.objectCount += 1;
        entry.bytes += size;
        byPrefix.set(prefix, entry);
        objectCount += 1;
        totalBytes += size;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
    return {
      bucket: this.bucket,
      objectCount,
      totalBytes,
      prefixes: [...byPrefix.entries()]
        .map(([prefix, v]) => ({ prefix, ...v }))
        .sort((a, b) => b.bytes - a.bytes),
    };
  }
}
