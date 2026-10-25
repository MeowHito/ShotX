import {
  S3_MULTIPART_MAX_PART_BYTES,
  S3_MULTIPART_MAX_PARTS,
  S3_MULTIPART_MIN_PART_BYTES,
} from '../config/upload';
import { ErrorCode, type RejectedFileTypeHint } from '../errors';
import { fileExtension, type MediaKind, type UploadFileType, uploadFileType } from '../media-types';

const MiB = 1024 * 1024;

/** Largest object a multipart upload can make: 10,000 parts of 5 GiB. */
export const S3_MULTIPART_MAX_OBJECT_BYTES = S3_MULTIPART_MAX_PARTS * S3_MULTIPART_MAX_PART_BYTES;

export interface MultipartPlan {
  /** Size of every part except the last. */
  partSize: number;
  /** 1 to 10,000. */
  partCount: number;
}

/**
 * Part size and count for an upload of `sizeBytes`. Uses `preferredPartBytes` (UPLOAD_PART_BYTES)
 * unless that would need more than 10,000 parts; then the smallest whole number of MiB that fits.
 * Every part except the last is `partSize`; the last is the remainder (or `partSize`). A 0-byte
 * file is one empty part.
 */
export function multipartPlan(sizeBytes: number, preferredPartBytes: number): MultipartPlan {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new RangeError(`sizeBytes must be a non-negative safe integer, got ${sizeBytes}`);
  }
  if (sizeBytes > S3_MULTIPART_MAX_OBJECT_BYTES) {
    throw new RangeError('sizeBytes is over the 10,000 × 5 GiB multipart limit');
  }
  if (
    !Number.isSafeInteger(preferredPartBytes) ||
    preferredPartBytes < S3_MULTIPART_MIN_PART_BYTES ||
    preferredPartBytes > S3_MULTIPART_MAX_PART_BYTES
  ) {
    throw new RangeError('preferredPartBytes must be between 5 MiB and 5 GiB');
  }
  const minimum = Math.ceil(sizeBytes / S3_MULTIPART_MAX_PARTS);
  const partSize =
    minimum <= preferredPartBytes
      ? preferredPartBytes
      : Math.min(S3_MULTIPART_MAX_PART_BYTES, Math.ceil(minimum / MiB) * MiB);
  return { partSize, partCount: Math.max(1, Math.ceil(sizeBytes / partSize)) };
}

/**
 * Expected size of part `partNumber` (1-based). For `POST /uploads/:id/complete`: the API lists
 * the parts S3 has and rejects the upload (UPLOAD_PARTS_INVALID) unless every part has exactly
 * this size, so the object can't be bigger than the reservation.
 */
export function expectedPartSize(
  plan: MultipartPlan,
  sizeBytes: number,
  partNumber: number,
): number {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount) {
    throw new RangeError(`partNumber must be 1 to ${plan.partCount}, got ${partNumber}`);
  }
  if (partNumber < plan.partCount) return plan.partSize;
  return sizeBytes - plan.partSize * (plan.partCount - 1);
}

/**
 * True when `parts` (as S3 ListParts returns them) are exactly parts 1..partCount of the plan with
 * the expected sizes.
 */
export function partsMatchPlan(
  plan: MultipartPlan,
  sizeBytes: number,
  parts: readonly { partNumber: number; size: number }[],
): boolean {
  if (parts.length !== plan.partCount) return false;
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  return sorted.every(
    (part, i) =>
      part.partNumber === i + 1 && part.size === expectedPartSize(plan, sizeBytes, i + 1),
  );
}

const HEIC_EXTENSIONS = new Set(['heic', 'heif', 'hif']);
const RAW_EXTENSIONS = new Set([
  '3fr',
  'ari',
  'arw',
  'bay',
  'cr2',
  'cr3',
  'crw',
  'dcr',
  'dng',
  'erf',
  'fff',
  'iiq',
  'k25',
  'kdc',
  'mef',
  'mos',
  'mrw',
  'nef',
  'nrw',
  'orf',
  'pef',
  'raf',
  'raw',
  'rw2',
  'rwl',
  'sr2',
  'srf',
  'srw',
  'x3f',
]);
const HEIC_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
]);

/** `heic` or `raw` when the name or MIME type is one the MVP rejects on purpose. */
export function rejectedFileTypeHint(
  name: string,
  declaredMime: string,
): RejectedFileTypeHint | null {
  const ext = fileExtension(name);
  const mime = declaredMime.split(';')[0]?.trim().toLowerCase() ?? '';
  if ((ext !== null && HEIC_EXTENSIONS.has(ext)) || HEIC_MIMES.has(mime)) return 'heic';
  if (ext !== null && RAW_EXTENSIONS.has(ext)) return 'raw';
  return null;
}

export type UploadDeclarationResult =
  | { ok: true; fileType: UploadFileType }
  | {
      ok: false;
      code: typeof ErrorCode.UNSUPPORTED_FILE_TYPE;
      details: { extension: string | null; hint: RejectedFileTypeHint | null };
    }
  | { ok: false; code: typeof ErrorCode.FILE_TOO_LARGE; details: { maxBytes: number } };

/**
 * The checks `POST /uploads/init` makes before reserving quota: the extension and declared MIME
 * type must be one allowlist entry (UNSUPPORTED_FILE_TYPE), and the size within that media kind's
 * limit (FILE_TOO_LARGE). The worker still sniffs magic bytes.
 */
export function checkUploadDeclaration(
  declared: { name: string; mime: string; sizeBytes: number },
  maxBytes: Readonly<Record<MediaKind, number>>,
): UploadDeclarationResult {
  const fileType = uploadFileType(declared.name, declared.mime);
  if (fileType === null) {
    return {
      ok: false,
      code: ErrorCode.UNSUPPORTED_FILE_TYPE,
      details: {
        extension: fileExtension(declared.name),
        hint: rejectedFileTypeHint(declared.name, declared.mime),
      },
    };
  }
  const limit = Math.min(maxBytes[fileType.kind], S3_MULTIPART_MAX_OBJECT_BYTES);
  if (declared.sizeBytes > limit) {
    return { ok: false, code: ErrorCode.FILE_TOO_LARGE, details: { maxBytes: limit } };
  }
  return { ok: true, fileType };
}

/**
 * True when renaming a file of `mime` to `newName` keeps an extension of the same allowlist entry
 * (`.jpg` to `.jpeg` is fine, `.jpg` to `.png` or no extension is not). `PATCH /drive/files/:id`
 * answers UNSUPPORTED_FILE_TYPE otherwise, so downloads keep a name that matches their bytes.
 */
export function renameKeepsFileType(mime: string, newName: string): boolean {
  return uploadFileType(newName, mime) !== null;
}
