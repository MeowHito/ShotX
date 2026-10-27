import {
  type MediaStorageConfig,
  storageS3ClientOptions,
  type StorageS3ClientOptions,
} from '@shotx/shared';

/** The media S3 client's options as the worker builds them. */
export type WorkerS3ClientOptions = Omit<
  StorageS3ClientOptions,
  'requestChecksumCalculation' | 'responseChecksumValidation'
> &
  Partial<
    Pick<StorageS3ClientOptions, 'requestChecksumCalculation' | 'responseChecksumValidation'>
  >;

/**
 * Options of the worker's media S3 client: storageS3ClientOptions (explicit endpoint and keys with
 * STORAGE_ENDPOINT_URL), with the checksum settings only for explicit endpoints (R2, LocalStack or
 * MinIO through STORAGE_*), whose S3 APIs may reject the SDK's default CRC32 headers. On AWS S3
 * (`explicit: false`) the SDK's default (checksums whenever supported) stays: it checks uploads and
 * downloads end to end, and the worker never presigns URLs, the case WHEN_REQUIRED exists for.
 * Contains the secret key: never log it.
 */
export function workerS3ClientOptions(
  storage: Pick<MediaStorageConfig, 'client'>,
): WorkerS3ClientOptions {
  const { requestChecksumCalculation, responseChecksumValidation, ...base } =
    storageS3ClientOptions(storage);
  return storage.client.explicit
    ? { ...base, requestChecksumCalculation, responseChecksumValidation }
    : base;
}
