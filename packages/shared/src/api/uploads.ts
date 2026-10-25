import { z } from 'zod';
import { S3_MULTIPART_MAX_PARTS, UPLOAD_SIGN_PARTS_MAX } from '../config/upload';
import { driveNameSchema, relativePathSchema } from '../drive/names';
import { byteCountSchema, idSchema, isoDateTimeSchema } from './common';
import { driveFileSchema, driveFolderSchema } from './drive';

/**
 * Uploads go straight to S3 with presigned multipart part URLs (Uppy `@uppy/aws-s3`); the bytes
 * never pass through the API. An upload is identified by its file id: `:id` in every
 * `/uploads/:id/...` route is `fileId`, never the S3 UploadId.
 *
 *   1. POST /uploads/init                 reserve quota, create the file row (`uploading`), get
 *                                         the plan and the first part URLs
 *   2. POST /uploads/:id/parts            more part URLs, on demand (Uppy `signPart`)
 *      GET  /uploads/:id/parts            parts S3 already has, to resume (Uppy `listParts`)
 *   3. POST /uploads/:id/complete         with every part's ETag (bucket CORS exposes ETag)
 *      DELETE /uploads/:id                abort instead: releases the reservation, deletes the row
 *
 * After complete the file is `processing` until the worker verifies the bytes (magic bytes and
 * exact size) and writes the derivatives; poll the folder listing for `ready` or `failed`.
 */

export const partNumberSchema = z.number().int().min(1).max(S3_MULTIPART_MAX_PARTS);

export const UPLOAD_NAME_CONFLICT_MODES = ['rename', 'fail'] as const;
export type UploadNameConflictMode = (typeof UPLOAD_NAME_CONFLICT_MODES)[number];

export const uploadInitBodySchema = z.object({
  /** File name as the user had it; becomes the display name (`files.name`). */
  name: driveNameSchema,
  /** Size in bytes, exactly. The worker fails the file if the object differs. */
  size: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /**
   * Declared MIME type. Checked with the extension against the allowlist (UNSUPPORTED_FILE_TYPE),
   * not here, so clients get the specific code.
   */
  mime: z.string().min(1).max(255),
  /** Target folder; null for the drive root. */
  folderId: idSchema.nullable(),
  /**
   * Folder drag-and-drop: the folders between `folderId` and the file, e.g. `Event/Day 1` (no
   * file name, no leading or trailing `/`). The API finds or creates each level in the same
   * transaction (an existing live folder with that name is reused) and puts the file in the last
   * one. Parses to the list of names.
   */
  relativePath: relativePathSchema.optional(),
  /**
   * When a live file in the target folder already has the name: `rename` (default) stores it as
   * `name (2).ext`, … and returns the final name; `fail` answers NAME_TAKEN.
   */
  onNameConflict: z.enum(UPLOAD_NAME_CONFLICT_MODES).default('rename'),
});
export type UploadInitBody = z.input<typeof uploadInitBodySchema>;

export const presignedPartSchema = z.object({
  partNumber: partNumberSchema,
  /** Presigned S3 UploadPart URL. PUT the part's bytes to it and keep the response's ETag. */
  url: z.url(),
});
export type PresignedPart = z.output<typeof presignedPartSchema>;

export const uploadInitResponseSchema = z.object({
  /** Use as `:id` in every /uploads/:id route. */
  fileId: idSchema,
  /**
   * The S3 multipart UploadId. Informational, for Uppy's state (`createMultipartUpload` must
   * return one); the API's routes never take it.
   */
  uploadId: z.string().min(1),
  /** The new file (`uploading`), with its final name and folder. */
  file: driveFileSchema,
  /** Folders created for `relativePath`, top-down (existing ones reused are not listed). */
  createdFolders: z.array(driveFolderSchema),
  /** Bytes per part; the last part is the remainder (multipartPlan). */
  partSize: z.number().int().positive(),
  partCount: partNumberSchema,
  /** Parts uploaded in parallel (UPLOAD_PART_CONCURRENCY). */
  maxConcurrency: z.number().int().positive(),
  /** URLs for the first parts (UPLOAD_INIT_PRESIGNED_PARTS, possibly none or all). */
  parts: z.array(presignedPartSchema),
  /** When the part URLs above stop working. */
  partUrlsExpireAt: isoDateTimeSchema,
  /** The upload session ends here: complete before it, or start again (UPLOAD_EXPIRED). */
  expiresAt: isoDateTimeSchema,
});
export type UploadInitResponse = z.output<typeof uploadInitResponseSchema>;

const distinctPartNumbers = (numbers: readonly number[]) =>
  new Set(numbers).size === numbers.length;

/** More part URLs. Part numbers must be within the upload's partCount (else VALIDATION_FAILED). */
export const signPartsBodySchema = z.object({
  partNumbers: z
    .array(partNumberSchema)
    .min(1)
    .max(UPLOAD_SIGN_PARTS_MAX)
    .refine(distinctPartNumbers, { error: 'partNumbers must be distinct' }),
});
export type SignPartsBody = z.input<typeof signPartsBodySchema>;

export const signPartsResponseSchema = z.object({
  parts: z.array(presignedPartSchema),
  expiresAt: isoDateTimeSchema,
});
export type SignPartsResponse = z.output<typeof signPartsResponseSchema>;

/** Parts S3 already has for the upload, ascending, so Uppy can resume. */
export const listPartsResponseSchema = z.object({
  parts: z.array(
    z.object({ partNumber: partNumberSchema, etag: z.string().min(1), size: byteCountSchema }),
  ),
});
export type ListPartsResponse = z.output<typeof listPartsResponseSchema>;

/**
 * Every part, ascending, with the ETag S3 returned for it (quotes included or not; the API passes
 * it through). The API checks the parts against S3 (sizes must match the plan exactly, see
 * partsMatchPlan) before completing: UPLOAD_PARTS_INVALID otherwise.
 */
export const completeUploadBodySchema = z.object({
  parts: z
    .array(z.object({ partNumber: partNumberSchema, etag: z.string().min(1).max(1024) }))
    .min(1)
    .max(S3_MULTIPART_MAX_PARTS)
    .refine(
      (parts) => parts.every((p, i) => i === 0 || p.partNumber > (parts[i - 1]?.partNumber ?? 0)),
      {
        error: 'parts must be in strictly ascending partNumber order',
      },
    ),
});
export type CompleteUploadBody = z.input<typeof completeUploadBodySchema>;

/**
 * The file after complete (`processing`, or already `ready`/`failed` if the worker was faster).
 * Completing twice returns the same file (idempotent).
 */
export const completeUploadResponseSchema = z.object({ file: driveFileSchema });
export type CompleteUploadResponse = z.output<typeof completeUploadResponseSchema>;
