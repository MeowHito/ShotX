import {
  checkUploadDeclaration,
  fileExtension,
  type MediaKind,
  relativePathSchema,
  UPLOAD_FILE_TYPES,
} from '@shotx/shared';
import { ApiError } from '../api/errors';
import { ClientError } from '../errors/messages';

/**
 * Client-side checks before a file is queued, with the same shared rules as `POST /uploads/init`
 * (allowlist by extension + MIME, per-kind size limit, HEIC/RAW hints). The API checks again.
 */

/** The MIME type to declare: the browser's, or the allowlist's for the extension when empty. */
export function declaredMime(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const ext = fileExtension(file.name);
  const entry = UPLOAD_FILE_TYPES.find((t) =>
    (t.extensions as readonly string[]).includes(ext ?? ''),
  );
  return entry?.mime ?? 'application/octet-stream';
}

export type PrecheckResult = { ok: true; mime: string } | { ok: false; error: Error };

export function precheckFile(
  file: { name: string; size: number; type: string },
  maxBytes: Readonly<Record<MediaKind, number>>,
  relativePath?: string | null,
): PrecheckResult {
  if (file.size === 0) return { ok: false, error: new ClientError('client.emptyFile') };
  const mime = declaredMime(file);
  const result = checkUploadDeclaration({ name: file.name, mime, sizeBytes: file.size }, maxBytes);
  if (!result.ok) {
    // Same shape as the API's error so one message map covers both.
    return {
      ok: false,
      error: new ApiError(0, result.code, 'Rejected before upload', result.details),
    };
  }
  if (relativePath && !relativePathSchema.safeParse(relativePath).success) {
    return {
      ok: false,
      error: new ClientError('client.invalidRelativePath', { path: relativePath }),
    };
  }
  return { ok: true, mime };
}

/** `accept` attribute for file inputs: the allowlist's MIME types and extensions. */
export const UPLOAD_ACCEPT = [
  ...UPLOAD_FILE_TYPES.map((t) => t.mime),
  ...UPLOAD_FILE_TYPES.flatMap((t) => t.extensions.map((e) => `.${e}`)),
].join(',');
