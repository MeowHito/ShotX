import {
  type DriveFile,
  type DriveFolder,
  ErrorCode,
  multipartPlan,
  UPLOAD_ROUTES,
  UPLOAD_SIGN_PARTS_MAX,
} from '@shotx/shared';
import AwsS3, { type uploadPartBytes as UploadPartBytesFn } from '@uppy/aws-s3';
import Uppy, { type UppyFile } from '@uppy/core';
import type { ApiClient } from '../api/client';
import { isApiError } from '../api/errors';
import { ClientError } from '../errors/messages';

/**
 * Uppy + @uppy/aws-s3 (v5 multipart callbacks) wired to the shared upload routes:
 *
 *   createMultipartUpload → POST /uploads/init         (reserves quota; first part URLs)
 *   signPart              → cached URLs, else POST /uploads/:id/parts in batches
 *   listParts             → GET /uploads/:id/parts      (resume)
 *   completeMultipartUpload → POST /uploads/:id/complete
 *   abortMultipartUpload  → DELETE /uploads/:id         (releases the reservation)
 *
 * Part bytes go from the browser straight to S3 with the presigned URLs; the API never sees them.
 * Uppy's `limit` caps parallel requests (UPLOAD_PART_CONCURRENCY parts at a time).
 * The Uppy key of an upload is the file id; every /uploads/:id route takes it.
 */

export interface DriveUploadMeta extends Record<string, unknown> {
  /** Target folder at the time the file was queued; null for the drive root. */
  folderId: string | null;
  /** Folder part of the dropped path (`relativePath` of init), or null. */
  drivePath: string | null;
  /** MIME type declared to the API. */
  mime: string;
  /**
   * Idempotency key of `POST /uploads/init` (uploadInitBodySchema.clientUploadId): one random
   * UUID per file, sent again on every retry so a lost init response never reserves quota twice.
   * Set by createDriveUploader when the file is added; rotated when the API says the old one can't
   * be reused (CONFLICT: that upload completed, failed or expired).
   */
  clientUploadId?: string;
}

export type DriveUploadBody = Record<string, never>;
export type DriveUppy = Uppy<DriveUploadMeta, DriveUploadBody>;
export type DriveUppyFile = UppyFile<DriveUploadMeta, DriveUploadBody>;

export interface DriveUploaderOptions {
  api: ApiClient;
  /** UPLOAD_PART_BYTES: Uppy must split files exactly as the API's multipart plan. */
  partBytes: number;
  /** UPLOAD_PART_CONCURRENCY. */
  partConcurrency: number;
  /** Replaces the XHR part upload (tests). */
  uploadPartBytes?: UploadPartBytesFn;
  /** Retry delays of part uploads (ms); tests pass []. */
  retryDelays?: number[];
  onUploaded?: (file: DriveFile) => void;
  onFoldersCreated?: (folders: DriveFolder[]) => void;
  /** Start uploading as soon as files are added (default true). */
  autoProceed?: boolean;
  now?: () => number;
}

export interface DriveUploader {
  uppy: DriveUppy;
  /** The error behind a failed file (an ApiError, ClientError or S3 failure). */
  errorFor(uppyFileId: string): unknown;
  destroy(): void;
}

function newClientUploadId(): string {
  return crypto.randomUUID();
}

interface CachedPart {
  url: string;
  expiresAt: number;
}

/** Reuse a part URL only if it is valid for at least this long. */
const URL_SAFETY_MS = 60_000;

export function createDriveUploader(options: DriveUploaderOptions): DriveUploader {
  const { api } = options;
  const now = options.now ?? Date.now;
  const uppy: DriveUppy = new Uppy<DriveUploadMeta, DriveUploadBody>({
    autoProceed: options.autoProceed ?? true,
    // Every queued file gets its own idempotency key for upload init.
    onBeforeFileAdded: (file) => {
      if (file.meta.clientUploadId === undefined) {
        file.meta = { ...file.meta, clientUploadId: newClientUploadId() };
      }
      return file;
    },
  });

  const partUrls = new Map<string, Map<number, CachedPart>>();
  const pendingSigns = new Map<string, Map<number, Promise<void>>>();
  const partCounts = new Map<string, number>();
  const errors = new Map<string, unknown>();

  /** Runs an API step; remembers its error for the file so the UI can show the Thai message. */
  async function step<T>(file: DriveUppyFile, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      errors.set(file.id, error);
      throw error;
    }
  }

  function cache(key: string, parts: { partNumber: number; url: string }[], expiresAt: string) {
    let map = partUrls.get(key);
    if (map === undefined) {
      map = new Map();
      partUrls.set(key, map);
    }
    const expires = Date.parse(expiresAt);
    for (const part of parts) map.set(part.partNumber, { url: part.url, expiresAt: expires });
  }

  function cachedUrl(key: string, partNumber: number): string | null {
    const part = partUrls.get(key)?.get(partNumber);
    return part !== undefined && part.expiresAt - URL_SAFETY_MS > now() ? part.url : null;
  }

  /** Signs `partNumber` and the next parts in one request, deduplicating concurrent requests. */
  async function ensureSigned(key: string, partNumber: number, signal?: AbortSignal) {
    const pending = pendingSigns.get(key) ?? new Map<number, Promise<void>>();
    pendingSigns.set(key, pending);
    const inFlight = pending.get(partNumber);
    if (inFlight !== undefined) return inFlight;

    const total = partCounts.get(key) ?? partNumber;
    const batchSize = Math.min(UPLOAD_SIGN_PARTS_MAX, Math.max(1, options.partConcurrency * 2));
    const numbers: number[] = [];
    for (let n = partNumber; n <= total && numbers.length < batchSize; n++) {
      if (n === partNumber || (cachedUrl(key, n) === null && !pending.has(n))) numbers.push(n);
    }
    const request = api
      .call(UPLOAD_ROUTES.signParts, {
        params: { id: key },
        body: { partNumbers: numbers },
        signal,
      })
      .then((res) => cache(key, res.parts, res.expiresAt))
      .finally(() => {
        for (const n of numbers) pending.delete(n);
      });
    for (const n of numbers) pending.set(n, request);
    return request;
  }

  function forget(key: string) {
    partUrls.delete(key);
    pendingSigns.delete(key);
    partCounts.delete(key);
  }

  uppy.use(AwsS3<DriveUploadMeta, DriveUploadBody>, {
    shouldUseMultipart: true,
    limit: options.partConcurrency,
    ...(options.retryDelays !== undefined ? { retryDelays: options.retryDelays } : {}),
    ...(options.uploadPartBytes !== undefined ? { uploadPartBytes: options.uploadPartBytes } : {}),

    getChunkSize: (file: { size: number }) => multipartPlan(file.size, options.partBytes).partSize,

    createMultipartUpload: (file) =>
      step(file, async () => {
        const size = file.size ?? 0;
        const clientUploadId = uppy.getFile(file.id)?.meta.clientUploadId ?? newClientUploadId();
        let res;
        try {
          res = await api.call(UPLOAD_ROUTES.init, {
            body: {
              name: file.name ?? 'file',
              size,
              mime: file.meta.mime,
              folderId: file.meta.folderId,
              ...(file.meta.drivePath ? { relativePath: file.meta.drivePath } : {}),
              clientUploadId,
            },
          });
        } catch (error) {
          if (isApiError(error, ErrorCode.CONFLICT) && uppy.getFile(file.id) !== undefined) {
            // The key belongs to an upload that is over; the user's retry starts a new one.
            const current = uppy.getFile(file.id);
            uppy.setFileMeta(file.id, { ...current.meta, clientUploadId: newClientUploadId() });
          }
          throw error;
        }
        const expected = multipartPlan(size, options.partBytes);
        if (res.partSize !== expected.partSize || res.partCount !== expected.partCount) {
          // Uppy would cut parts the API rejects at complete; give the reservation back now.
          await api
            .call(UPLOAD_ROUTES.abort, { params: { id: res.fileId } })
            .catch(() => undefined);
          throw new ClientError('client.uploadPlanMismatch');
        }
        partCounts.set(res.fileId, res.partCount);
        cache(res.fileId, res.parts, res.partUrlsExpireAt);
        if (res.createdFolders.length > 0) options.onFoldersCreated?.(res.createdFolders);
        return { uploadId: res.uploadId, key: res.fileId };
      }),

    signPart: (file, { key, partNumber, signal }) =>
      step(file, async () => {
        let url = cachedUrl(key, partNumber);
        if (url === null) {
          await ensureSigned(key, partNumber, signal);
          url = cachedUrl(key, partNumber);
        }
        if (url === null) throw new ClientError('client.storageUpload');
        return { method: 'PUT' as const, url };
      }),

    listParts: (file, { key, signal }) =>
      step(file, async () => {
        const res = await api.call(UPLOAD_ROUTES.listParts, { params: { id: key }, signal });
        return res.parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.etag, Size: p.size }));
      }),

    completeMultipartUpload: (file, { key, parts, signal }) =>
      step(file, async () => {
        const sorted = parts
          .map((p) => ({ partNumber: p.PartNumber ?? 0, etag: p.ETag ?? '' }))
          .sort((a, b) => a.partNumber - b.partNumber);
        const res = await api.call(UPLOAD_ROUTES.complete, {
          params: { id: key },
          body: { parts: sorted },
          signal,
        });
        forget(key);
        options.onUploaded?.(res.file);
        return {};
      }),

    abortMultipartUpload: async (_file, { key }) => {
      forget(key);
      try {
        await api.call(UPLOAD_ROUTES.abort, { params: { id: key } });
      } catch (error) {
        // Already gone (never started, aborted or purged) is fine.
        if (!isApiError(error, ErrorCode.UPLOAD_NOT_FOUND)) throw error;
      }
    },
  });

  const clearError = (file: DriveUppyFile | undefined) => {
    if (file !== undefined) errors.delete(file.id);
  };
  uppy.on('upload-retry', clearError);
  uppy.on('file-removed', clearError);

  return {
    uppy,
    errorFor(id) {
      return errors.get(id) ?? new ClientError('client.storageUpload');
    },
    destroy() {
      uppy.destroy();
    },
  };
}
