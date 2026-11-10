import { z } from 'zod';
import type { MediaKind } from '../media-types';
import { type Env, parseEnv } from './env';
import { GiB, int, MiB, SECONDS_PER_DAY, SECONDS_PER_HOUR } from './fields';

/** S3 multipart limits: parts are 5 MiB to 5 GiB (except the last) and at most 10,000. */
export const S3_MULTIPART_MIN_PART_BYTES = 5 * MiB;
export const S3_MULTIPART_MAX_PART_BYTES = 5 * GiB;
export const S3_MULTIPART_MAX_PARTS = 10_000;

/** Most part URLs one `POST /uploads/:id/parts` request may ask for. */
export const UPLOAD_SIGN_PARTS_MAX = 100;

/**
 * Longest upload session. The bucket's lifecycle rule aborts incomplete multipart uploads after
 * 2 days (infra `storage.abortIncompleteMultipartUploadDays`), so a session must end well before
 * that or S3 would drop parts of a live upload.
 */
export const UPLOAD_SESSION_TTL_MAX_SECONDS = 36 * SECONDS_PER_HOUR;

// Per-file size limits are assumptions (the spec names the limit, not the value).
const uploadEnvSchema = z
  .object({
    UPLOAD_MAX_IMAGE_BYTES: int(1 * MiB, 1 * GiB).default(100 * MiB),
    UPLOAD_MAX_VIDEO_BYTES: int(1 * MiB, 50 * GiB).default(5 * GiB),
    UPLOAD_PART_BYTES: int(S3_MULTIPART_MIN_PART_BYTES, S3_MULTIPART_MAX_PART_BYTES).default(
      16 * MiB,
    ),
    /** Lifetime of each presigned part URL. Uppy signs parts on demand, so this can be short. */
    UPLOAD_PRESIGN_TTL_SECONDS: int(60, 7 * SECONDS_PER_DAY).default(SECONDS_PER_HOUR),
    /** Parts the client uploads in parallel (the spec says 4–6). */
    UPLOAD_PART_CONCURRENCY: int(1, 10).default(4),
    /**
     * How long an upload stays open after `POST /uploads/init` (the response's `expiresAt`).
     * After it, complete and part signing return UPLOAD_EXPIRED, and the nightly reconciliation
     * aborts the multipart upload and releases the reservation. Assumption: 24 h.
     */
    UPLOAD_SESSION_TTL_SECONDS: int(SECONDS_PER_HOUR, UPLOAD_SESSION_TTL_MAX_SECONDS).default(
      24 * SECONDS_PER_HOUR,
    ),
    /** Part URLs returned by `POST /uploads/init` itself (the rest via `POST /uploads/:id/parts`). */
    UPLOAD_INIT_PRESIGNED_PARTS: int(0, UPLOAD_SIGN_PARTS_MAX).default(8),
  })
  .refine(
    (e) =>
      Math.ceil(
        Math.max(e.UPLOAD_MAX_IMAGE_BYTES, e.UPLOAD_MAX_VIDEO_BYTES) / e.UPLOAD_PART_BYTES,
      ) <= S3_MULTIPART_MAX_PARTS,
    {
      error: `UPLOAD_PART_BYTES is too small: the largest upload would need more than ${S3_MULTIPART_MAX_PARTS} parts`,
    },
  )
  .refine((e) => e.UPLOAD_PRESIGN_TTL_SECONDS <= e.UPLOAD_SESSION_TTL_SECONDS, {
    error: 'UPLOAD_PRESIGN_TTL_SECONDS must be less than or equal to UPLOAD_SESSION_TTL_SECONDS',
  });

export interface UploadConfig {
  /** Largest original accepted per file, by media kind. Checked at `POST /uploads/init`. */
  maxBytes: Record<MediaKind, number>;
  /** Size of every multipart part except the last. */
  partBytes: number;
  presignTtlSeconds: number;
  partConcurrency: number;
  /** Lifetime of an upload session (`files.upload_expires_at - created_at`). */
  sessionTtlSeconds: number;
  /** Part URLs included in the init response. */
  initPresignedParts: number;
}

export function loadUploadConfig(env: Env): UploadConfig {
  const e = parseEnv(uploadEnvSchema, env, 'upload');
  return {
    maxBytes: { image: e.UPLOAD_MAX_IMAGE_BYTES, video: e.UPLOAD_MAX_VIDEO_BYTES },
    partBytes: e.UPLOAD_PART_BYTES,
    presignTtlSeconds: e.UPLOAD_PRESIGN_TTL_SECONDS,
    partConcurrency: e.UPLOAD_PART_CONCURRENCY,
    sessionTtlSeconds: e.UPLOAD_SESSION_TTL_SECONDS,
    initPresignedParts: e.UPLOAD_INIT_PRESIGNED_PARTS,
  };
}

// --- Storage quota switch (ADR 0010) --------------------------------------------------------------

const storageQuotaEnvSchema = z.object({
  /**
   * Whether uploads (and copies) are checked against the plan quota. Default false (ADR 0010: no
   * storage limit for now). When false, POST /uploads/init and POST /drive/files/:id/copy never
   * answer QUOTA_EXCEEDED, and GET /drive/usage reports `quotaBytes` and `availableBytes` as null.
   * `storage_usage` is still maintained exactly either way (reservation at init, release on abort,
   * the worker's commit, nightly reconciliation), so a limit can be switched on later and admins
   * see who uses how much. Per-file size limits and the MIME allowlist always apply.
   * `true`/`false` (also 1/0, yes/no, on/off).
   */
  STORAGE_QUOTA_ENFORCED: z.stringbool().default(false),
});

export interface StorageQuotaConfig {
  enforced: boolean;
}

/** Reads STORAGE_QUOTA_ENFORCED (api and worker; default false). */
export function loadStorageQuotaConfig(env: Env): StorageQuotaConfig {
  return { enforced: parseEnv(storageQuotaEnvSchema, env, 'storage quota').STORAGE_QUOTA_ENFORCED };
}
