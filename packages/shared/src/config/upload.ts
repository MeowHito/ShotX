import { z } from 'zod';
import type { MediaKind } from '../media-types';
import { type Env, parseEnv } from './env';
import { GiB, int, MiB, SECONDS_PER_DAY, SECONDS_PER_HOUR } from './fields';

/** S3 multipart limits: parts are 5 MiB to 5 GiB (except the last) and at most 10,000. */
export const S3_MULTIPART_MIN_PART_BYTES = 5 * MiB;
export const S3_MULTIPART_MAX_PART_BYTES = 5 * GiB;
export const S3_MULTIPART_MAX_PARTS = 10_000;

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
  })
  .refine(
    (e) =>
      Math.ceil(
        Math.max(e.UPLOAD_MAX_IMAGE_BYTES, e.UPLOAD_MAX_VIDEO_BYTES) / e.UPLOAD_PART_BYTES,
      ) <= S3_MULTIPART_MAX_PARTS,
    {
      error: `UPLOAD_PART_BYTES is too small: the largest upload would need more than ${S3_MULTIPART_MAX_PARTS} parts`,
    },
  );

export interface UploadConfig {
  /** Largest original accepted per file, by media kind. Checked at `POST /uploads/init`. */
  maxBytes: Record<MediaKind, number>;
  /** Size of every multipart part except the last. */
  partBytes: number;
  presignTtlSeconds: number;
  partConcurrency: number;
}

export function loadUploadConfig(env: Env): UploadConfig {
  const e = parseEnv(uploadEnvSchema, env, 'upload');
  return {
    maxBytes: { image: e.UPLOAD_MAX_IMAGE_BYTES, video: e.UPLOAD_MAX_VIDEO_BYTES },
    partBytes: e.UPLOAD_PART_BYTES,
    presignTtlSeconds: e.UPLOAD_PRESIGN_TTL_SECONDS,
    partConcurrency: e.UPLOAD_PART_CONCURRENCY,
  };
}
