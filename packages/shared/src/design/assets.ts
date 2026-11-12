import { FILE_STATUSES } from '../domain';
import { fileExtension, UPLOAD_FILE_TYPES, type UploadFileType } from '../media-types';

/**
 * Design images (ADR 0013): logos and pictures for share page designs. Uploaded with one presigned
 * PUT straight to the bucket (`POST /designs/assets`), verified and converted by the worker's
 * `design.asset` job on the media queue (designAssetMessageSchema), served as `web.webp` through
 * the CDN. Keys: designAssetKey in s3-keys.
 *
 * Status (`design_assets.status`, the `file_status` enum):
 *   uploading    the row exists, bytes reserved, the PUT may not have happened yet
 *   processing   `POST /designs/assets/:id/complete` sent the job
 *   ready        the worker verified the bytes and wrote web.webp; width and height set
 *   failed       wrong bytes, unreadable image, or the upload expired; nothing counted
 *
 * Quota (like originals, see drive/quota): `size_bytes` of the original is reserved at
 * `POST /designs/assets`, moved to used when the worker verifies (`verified_at`), released when
 * it fails unverified or the upload expires, and subtracted from its bucket when the purge is
 * requested (`purge_requested_at`). web.webp is not counted (derivatives never are).
 * STORAGE_QUOTA_ENFORCED decides QUOTA_EXCEEDED exactly as for uploads.
 */
export const DESIGN_ASSET_STATUSES = FILE_STATUSES;
export type DesignAssetStatus = (typeof DESIGN_ASSET_STATUSES)[number];

/**
 * Accepted design images: JPEG, PNG (transparency kept, for logos) and WebP; the extension and
 * the declared MIME type must belong to the same entry, as for uploads. No video, HEIC or SVG
 * (SVG can carry scripts).
 */
export const DESIGN_ASSET_FILE_TYPES = UPLOAD_FILE_TYPES.filter(
  (t): t is Extract<(typeof UPLOAD_FILE_TYPES)[number], { kind: 'image' }> => t.kind === 'image',
);

export type DesignAssetMime = (typeof DESIGN_ASSET_FILE_TYPES)[number]['mime'];

/** Every accepted design image MIME type (`design_assets.mime` CHECK, `accept` attribute). */
export const DESIGN_ASSET_MIME_TYPES = DESIGN_ASSET_FILE_TYPES.map(
  (t) => t.mime,
) as readonly DesignAssetMime[];

/**
 * The allowlist entry for a design image's file name and declared MIME type, or null
 * (UNSUPPORTED_FILE_TYPE). MIME types compare case-insensitively and ignore parameters.
 */
export function designAssetFileType(name: string, declaredMime: string): UploadFileType | null {
  const ext = fileExtension(name);
  if (ext === null) return null;
  const mime = declaredMime.split(';')[0]?.trim().toLowerCase();
  return (
    DESIGN_ASSET_FILE_TYPES.find(
      (t) => t.mime === mime && (t.extensions as readonly string[]).includes(ext),
    ) ?? null
  );
}
