import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { type Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export interface ObjectHead {
  size: number;
}

export interface ListedObject {
  key: string;
  size: number;
}

export interface UploadStreamOptions {
  contentType: string;
  /** Size of every part except the last (5 MiB to 5 GiB; see multipartPlan in @shotx/shared). */
  partBytes: number;
  signal?: AbortSignal;
}

/**
 * Parts a streaming upload sends at once. Memory per upload is about (this + 1) × partBytes, so it
 * stays small: the worker runs few zips per task and each one is bound by S3 throughput anyway.
 */
export const UPLOAD_STREAM_QUEUE_SIZE = 2;

/** After an abort, how long lib-storage may take to abort its own upload before upload.abort(). */
export const UPLOAD_ABORT_FALLBACK_MS = 30_000;

/** Objects most DeleteObjects calls may name (S3's limit). */
export const DELETE_OBJECTS_BATCH = 1000;

/**
 * The media bucket operations the worker uses. Keys are always built with the s3-keys helpers of
 * @shotx/shared. Tests use an in-memory implementation.
 */
export interface ObjectStore {
  /** Null when the object doesn't exist. */
  head(key: string): Promise<ObjectHead | null>;
  /** The whole object (for small objects only); null when it doesn't exist. */
  get(key: string): Promise<Uint8Array | null>;
  /**
   * The object as a stream, read from S3 as it is consumed (never buffered whole). Rejects with
   * an error named `NoSuchKey` when the object doesn't exist.
   */
  getStream(key: string, signal?: AbortSignal): Promise<Readable>;
  /**
   * Streams `body` into `key` with a multipart upload of `partBytes` parts, holding at most a few
   * parts in memory. Aborting `signal` aborts the upload (no object is created).
   */
  uploadStream(key: string, body: Readable, options: UploadStreamOptions): Promise<void>;
  /** Bytes `start` to `end` inclusive (fewer when the object is shorter). */
  getRange(key: string, start: number, end: number): Promise<Uint8Array>;
  /** Streams the object into `path` and returns its size and SHA-256 (lowercase hex). */
  download(
    key: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; sha256: string }>;
  put(key: string, body: Uint8Array, contentType: string): Promise<void>;
  putFile(key: string, path: string, contentType: string, signal?: AbortSignal): Promise<void>;
  /** Deletes the objects; missing ones are fine. Throws if any delete failed. */
  deleteObjects(keys: readonly string[]): Promise<void>;
  list(prefix: string): AsyncIterable<ListedObject>;
  /** Aborts a multipart upload; an upload that no longer exists is fine. */
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}

export class ObjectStoreError extends Error {
  override readonly name = 'ObjectStoreError';
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return error.name === 'NotFound' || error.name === 'NoSuchKey' || status === 404;
}

function sha256Tap(hash: ReturnType<typeof createHash>, counter: { bytes: number }) {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      counter.bytes += chunk.length;
      callback(null, chunk);
    },
  });
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const response = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: response.ContentLength ?? 0 };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (response.Body === undefined) return new Uint8Array();
      return await response.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getStream(key: string, signal?: AbortSignal): Promise<Readable> {
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: signal,
    });
    if (response.Body === undefined) throw new ObjectStoreError('GetObject returned no body');
    return response.Body as Readable;
  }

  async uploadStream(key: string, body: Readable, options: UploadStreamOptions): Promise<void> {
    const upload = new Upload({
      client: this.s3,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: options.contentType },
      partSize: options.partBytes,
      queueSize: UPLOAD_STREAM_QUEUE_SIZE,
      // A failed upload is aborted, so no parts linger (the lifecycle rule is only a backstop).
      leavePartsOnError: false,
    });
    // On abort, end the body rather than calling upload.abort(): lib-storage's reader then
    // throws, waits for the parts in flight and aborts its own upload id before done() rejects,
    // so cleanup is deterministic and never touches another attempt's upload of the same key.
    // upload.abort() is only a fallback for a part that hangs.
    let fallback: NodeJS.Timeout | undefined;
    const abort = () => {
      body.destroy(options.signal?.reason instanceof Error ? options.signal.reason : undefined);
      fallback = setTimeout(
        () => void upload.abort().catch(() => undefined),
        UPLOAD_ABORT_FALLBACK_MS,
      );
      fallback.unref();
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      options.signal?.throwIfAborted();
      await upload.done();
    } finally {
      options.signal?.removeEventListener('abort', abort);
      clearTimeout(fallback);
    }
  }

  async getRange(key: string, start: number, end: number): Promise<Uint8Array> {
    const response = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=${start}-${end}` }),
    );
    if (response.Body === undefined) return new Uint8Array();
    return response.Body.transformToByteArray();
  }

  async download(
    key: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: number; sha256: string }> {
    const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: signal,
    });
    if (response.Body === undefined) throw new ObjectStoreError('GetObject returned no body');
    const hash = createHash('sha256');
    const counter = { bytes: 0 };
    await pipeline(
      response.Body as Readable,
      sha256Tap(hash, counter),
      createWriteStream(path),
      signal === undefined ? {} : { signal },
    );
    return { bytes: counter.bytes, sha256: hash.digest('hex') };
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async putFile(
    key: string,
    path: string,
    contentType: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { size } = await stat(path);
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: contentType,
      }),
      { abortSignal: signal },
    );
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += DELETE_OBJECTS_BATCH) {
      const batch = keys.slice(i, i + DELETE_OBJECTS_BATCH);
      const response = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed = response.Errors ?? [];
      if (failed.length > 0) {
        // Codes only: keys may contain file names.
        const codes = [...new Set(failed.map((e) => e.Code ?? 'Unknown'))].join(', ');
        throw new ObjectStoreError(`DeleteObjects failed for ${failed.length} objects (${codes})`);
      }
    }
  }

  async *list(prefix: string): AsyncIterable<ListedObject> {
    let token: string | undefined;
    do {
      const response = await this.s3.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const object of response.Contents ?? []) {
        if (object.Key !== undefined) yield { key: object.Key, size: object.Size ?? 0 };
      }
      token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.s3.send(
        new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId }),
      );
    } catch (error) {
      if (error instanceof Error && (error.name === 'NoSuchUpload' || isNotFound(error))) return;
      throw error;
    }
  }
}
