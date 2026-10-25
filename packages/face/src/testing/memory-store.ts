import { REKOGNITION_S3_MAX_BYTES } from '../provider';
import type { TempImageStore } from '../temp-store';
import type { ImageInput } from '../types';

export interface ObjectReader {
  get(key: string): Uint8Array | undefined;
}

/** In-memory stand-in for the S3 temp store; the fake provider reads objects back from it. */
export class MemoryTempImageStore implements TempImageStore, ObjectReader {
  readonly maxBytes = REKOGNITION_S3_MAX_BYTES;
  /** Every key `put` was called with, in call order, to check how keys are built. */
  readonly putKeys: string[] = [];
  /** Every key `delete` was called with, in call order. */
  readonly deleteKeys: string[] = [];
  private readonly objects = new Map<string, Uint8Array>();
  private readonly failures = { put: [] as Error[], delete: [] as Error[] };

  /** Makes the next call of `operation` reject with `error`, without storing or deleting. */
  failNext(operation: 'put' | 'delete', error: Error): this {
    this.failures[operation].push(error);
    return this;
  }

  put(key: string, bytes: Uint8Array): Promise<ImageInput> {
    this.putKeys.push(key);
    const failure = this.failures.put.shift();
    if (failure) return Promise.reject(failure);
    this.objects.set(key, bytes);
    return Promise.resolve({ s3: { bucket: 'memory', key } });
  }

  delete(key: string): Promise<void> {
    this.deleteKeys.push(key);
    const failure = this.failures.delete.shift();
    if (failure) return Promise.reject(failure);
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
