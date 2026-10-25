/** Kinds of media the platform accepts. Videos get no face indexing in the MVP. */
export const MEDIA_KINDS = ['image', 'video'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export interface UploadFileType {
  kind: MediaKind;
  /** The MIME type the client must declare, and the Content-Type the original is stored with. */
  mime: string;
  /** Lowercase extensions without the dot. */
  extensions: readonly string[];
}

/**
 * The upload allowlist: JPEG, PNG, WebP, MP4 and MOV. A file is accepted only when its
 * extension and its declared MIME type belong to the same entry. HEIC and RAW are rejected in
 * the MVP (sharp's prebuilt binaries can't decode HEIC). The worker still checks magic bytes.
 */
export const UPLOAD_FILE_TYPES = [
  { kind: 'image', mime: 'image/jpeg', extensions: ['jpg', 'jpeg'] },
  { kind: 'image', mime: 'image/png', extensions: ['png'] },
  { kind: 'image', mime: 'image/webp', extensions: ['webp'] },
  { kind: 'video', mime: 'video/mp4', extensions: ['mp4'] },
  { kind: 'video', mime: 'video/quicktime', extensions: ['mov'] },
] as const satisfies readonly UploadFileType[];

export type UploadMime = (typeof UPLOAD_FILE_TYPES)[number]['mime'];
export type UploadExtension = (typeof UPLOAD_FILE_TYPES)[number]['extensions'][number];

/** Every allowed MIME type, e.g. for an `accept` attribute or a zod enum. */
export const UPLOAD_MIME_TYPES = UPLOAD_FILE_TYPES.map((t) => t.mime) as readonly UploadMime[];

/** Every allowed extension, without the dot. */
export const UPLOAD_EXTENSIONS = UPLOAD_FILE_TYPES.flatMap(
  (t) => t.extensions,
) as readonly UploadExtension[];

/** The lowercase extension of a file name without the dot, or null when it has none. */
export function fileExtension(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1);
  return /^[A-Za-z0-9]{1,16}$/.test(ext) ? ext.toLowerCase() : null;
}

/**
 * The allowlist entry for a file name and declared MIME type, or null when the pair isn't
 * allowed. MIME types compare case-insensitively and ignore parameters (`; charset=...`).
 */
export function uploadFileType(name: string, declaredMime: string): UploadFileType | null {
  const ext = fileExtension(name);
  if (ext === null) return null;
  const mime = declaredMime.split(';')[0]?.trim().toLowerCase();
  return (
    UPLOAD_FILE_TYPES.find(
      (t) => t.mime === mime && (t.extensions as readonly string[]).includes(ext),
    ) ?? null
  );
}
