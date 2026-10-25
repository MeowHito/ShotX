import type { DownloadSize } from '../domain';
import { fileExtension, type MediaKind } from '../media-types';
import { sanitizeOriginalName } from '../s3-keys';

export interface DownloadableFile {
  mediaKind: MediaKind;
  /** Display name (`files.name`). */
  name: string;
  /** `files.s3_key`. */
  s3Key: string;
  /** `files.web_key` (images: web.jpg). */
  webKey: string | null;
  /** `files.preview_key` (videos: preview.mp4). */
  previewKey: string | null;
  sizeBytes: number;
  /** `files.web_size_bytes`: size of web.jpg (images) or preview.mp4 (videos), when recorded. */
  webSizeBytes: number | null;
}

export interface DownloadObject {
  key: string;
  /** Name for Content-Disposition and for the zip entry (before uniqueZipEntryNames). */
  fileName: string;
  /** For activity `bytes` and zip totals; 0 when unknown. */
  bytes: number;
}

function withExtension(name: string, ext: string): string {
  const current = fileExtension(name);
  const stem = current === null ? name : name.slice(0, name.length - current.length - 1);
  return `${stem}.${ext}`;
}

/**
 * The object a download serves (spec: `web` serves web.jpg; originals only when the share allows
 * them). `web` serves web.jpg for images and the 720p preview.mp4 for videos, with the name's
 * extension changed to match; `original` serves the uploaded file under its display name.
 * Returns null when the variant doesn't exist yet (the file isn't `ready`). The name is
 * sanitized, so it is also a safe zip entry name.
 *
 * Owner downloads (`GET /drive/files/:id/download`) may ask for either size; share downloads use
 * the share's `download_size`.
 */
export function downloadObject(file: DownloadableFile, size: DownloadSize): DownloadObject | null {
  if (size === 'original') {
    return { key: file.s3Key, fileName: sanitizeOriginalName(file.name), bytes: file.sizeBytes };
  }
  const key = file.mediaKind === 'image' ? file.webKey : file.previewKey;
  if (key === null) return null;
  const ext = file.mediaKind === 'image' ? 'jpg' : 'mp4';
  return {
    key,
    fileName: sanitizeOriginalName(withExtension(file.name, ext)),
    bytes: file.webSizeBytes ?? 0,
  };
}
