import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { REKOGNITION_INLINE_MAX_BYTES, REKOGNITION_S3_MAX_BYTES } from './provider';
import type { ImageInput } from './types';

/** Where temporary index images go before the face provider reads them. */
export interface TempImageStore {
  /** Largest image this store can hand to the face provider. */
  readonly maxBytes: number;
  /** Stores an image and returns how provider calls should reference it. */
  put(key: string, bytes: Uint8Array): Promise<ImageInput>;
  delete(key: string): Promise<void>;
}

/** Stores images in S3. The bucket's `tmp/` lifecycle rule removes anything left behind. */
export class S3TempImageStore implements TempImageStore {
  readonly maxBytes = REKOGNITION_S3_MAX_BYTES;

  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
  ) {}

  async put(key: string, bytes: Uint8Array): Promise<ImageInput> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentType: 'image/jpeg',
      }),
    );
    return { s3: { bucket: this.bucket, key } };
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Sends images inline instead of storing them; Rekognition accepts up to 5 MB this way. */
export class InlineTempImageStore implements TempImageStore {
  readonly maxBytes = REKOGNITION_INLINE_MAX_BYTES;

  put(key: string, bytes: Uint8Array): Promise<ImageInput> {
    if (bytes.length > this.maxBytes) {
      return Promise.reject(new RangeError(`${key} is larger than ${this.maxBytes} bytes`));
    }
    return Promise.resolve({ bytes });
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }
}
