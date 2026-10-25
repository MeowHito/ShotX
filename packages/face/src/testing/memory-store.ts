import { REKOGNITION_S3_MAX_BYTES } from '../provider';
import type { TempImageStore } from '../temp-store';
import type { ImageInput } from '../types';

export interface ObjectReader {
  get(key: string): Uint8Array | undefined;
}

/** In-memory stand-in for the S3 temp store; the fake provider reads objects back from it. */
export class MemoryTempImageStore implements TempImageStore, ObjectReader {
  readonly maxBytes = REKOGNITION_S3_MAX_BYTES;
  private readonly objects = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): Promise<ImageInput> {
    this.objects.set(key, bytes);
    return Promise.resolve({ s3: { bucket: 'memory', key } });
  }

  delete(key: string): Promise<void> {
    this.objects.delete(key);
    return Promise.resolve();
  }

  get(key: string): Uint8Array | undefined {
    return this.objects.get(key);
  }

  /** Keys currently stored, to check that temporary images are cleaned up. */
  keys(): string[] {
    return [...this.objects.keys()];
  }
}
