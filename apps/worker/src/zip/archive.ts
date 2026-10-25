import { Transform, type TransformCallback } from 'node:stream';
import { ErrorCode, type ZipEntry } from '@shotx/shared';
import { ZipArchive } from 'archiver';
import type { ObjectStore } from '../aws/object-store';

/** A zip job ends as `failed` with this stable code (an ErrorCode) and an operator message. */
export class ZipJobFailure extends Error {
  override readonly name = 'ZipJobFailure';
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ArchiveEntry extends ZipEntry {
  /** Entry modification time (the photo's taken_at, else its upload time). */
  date: Date;
}

export interface StreamZipOptions {
  /** Most bytes of entry data the archive may hold (ZIP_MAX_BYTES). */
  maxBytes: number;
  /** Multipart part size of the upload. */
  partBytes: number;
  signal: AbortSignal;
}

/** Counts the bytes of all entries and fails the archive once they pass the limit. */
class EntryByteLimit {
  total = 0;
  constructor(private readonly maxBytes: number) {}

  counter(): Transform {
    return new Transform({
      transform: (chunk: Buffer, _encoding, callback: TransformCallback) => {
        this.total += chunk.length;
        if (this.total > this.maxBytes) {
          callback(
            new ZipJobFailure(
              ErrorCode.ZIP_TOO_LARGE,
              `Entries passed ZIP_MAX_BYTES (${this.maxBytes}) while streaming`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });
  }
}

/**
 * Streams `entries` from the bucket into a ZIP at `key` with STORE (no compression: JPEG and MP4
 * don't compress further), through a multipart upload. Entries are opened one at a time, and
 * neither an object nor the archive is ever held in memory whole: memory stays around a few
 * multipart parts. ZIP64 records are added automatically when the archive needs them.
 *
 * Any failure (an object stream error, the byte limit, the signal) aborts the multipart upload
 * before the archive stream is torn down, so a partial archive never becomes an object. Returns
 * the archive size.
 */
export async function streamZip(
  store: ObjectStore,
  key: string,
  entries: readonly ArchiveEntry[],
  options: StreamZipOptions,
): Promise<number> {
  const archive = new ZipArchive({ store: true });
  const uploadAbort = new AbortController();
  const signal = AbortSignal.any([options.signal, uploadAbort.signal]);
  let failure: Error | undefined;
  const fail = (error: unknown) => {
    if (failure !== undefined) return;
    failure = error instanceof Error ? error : new Error(String(error));
    uploadAbort.abort(failure);
    archive.destroy(failure);
  };
  archive.on('error', fail);
  archive.on('warning', fail);
  const onAbort = () => fail(options.signal.reason);
  options.signal.addEventListener('abort', onAbort, { once: true });

  const limit = new EntryByteLimit(options.maxBytes);
  const uploading = store.uploadStream(key, archive, {
    contentType: 'application/zip',
    partBytes: options.partBytes,
    signal,
  });
  // Keep the upload's rejection from going unhandled while entries are fed.
  uploading.catch(() => undefined);

  const feeding = (async () => {
    for (const entry of entries) {
      if (failure !== undefined) return;
      signal.throwIfAborted();
      const source = await store.getStream(entry.key, signal);
      const counted = limit.counter();
      await new Promise<void>((resolve, reject) => {
        const onError = (error: unknown) => {
          cleanup();
          source.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        };
        const onEntry = () => {
          cleanup();
          resolve();
        };
        const onClose = () => {
          // The archive was torn down by another failure.
          cleanup();
          reject(failure ?? new Error('Archive closed'));
        };
        const cleanup = () => {
          source.off('error', onError);
          counted.off('error', onError);
          archive.off('entry', onEntry);
          archive.off('close', onClose);
        };
        source.once('error', onError);
        counted.once('error', onError);
        archive.once('entry', onEntry);
        archive.once('close', onClose);
        archive.append(source.pipe(counted), {
          name: entry.name,
          date: entry.date,
          store: true,
        });
      });
    }
    await archive.finalize();
  })();

  try {
    await feeding;
  } catch (error) {
    fail(error);
  }
  try {
    await uploading;
  } catch (error) {
    fail(error);
  } finally {
    options.signal.removeEventListener('abort', onAbort);
  }
  if (failure !== undefined) throw failure;
  return archive.pointer();
}
