import { z } from 'zod';
import { fileExtension } from './media-types';

/**
 * S3 key layout of the media bucket. Every key that belongs to a photographer contains their id,
 * so storage and bandwidth can be attributed (CloudFront standard logs on AWS; activity_events on R2). Build keys only with
 * the functions below; never concatenate them by hand.
 *
 *   originals/{photographerId}/{fileId}/{originalName}     STORAGE_ORIGINALS_CLASS (Intelligent-
 *                                                          Tiering on AWS, STANDARD on R2)
 *   derived/{photographerId}/{fileId}/{variant file}       thumb.webp, preview.webp, web.jpg,
 *                                                          poster.jpg, preview.mp4
 *   designs/{photographerId}/{assetId}/original            share page design images (ADR 0013),
 *   designs/{photographerId}/{assetId}/web.webp            STANDARD; see designAssetKey
 *   tmp/zips/{jobId}.zip                                   tmp/ is lifecycle-expired
 *   tmp/reconcile/...                                      worker's orphan-face scans (ADR 0006)
 *
 * There is no tmp/index/ any more (ADR 0004 is superseded by ADR 0008 section 5): index images
 * and tiles go to Rekognition as bytes and are never written to the bucket.
 */
export const S3_PREFIXES = {
  originals: 'originals/',
  derived: 'derived/',
  /** Share page design images (ADR 0013). Not under tmp/: kept until the orphan purge. */
  designs: 'designs/',
  tmp: 'tmp/',
  tmpZips: 'tmp/zips/',
  /** The worker's reconciliation scan files (faces.reconcile.daily), with their own rule. */
  tmpReconcile: 'tmp/reconcile/',
} as const;

/** File names of the derivatives the worker writes for each upload. */
export const DERIVED_FILE_NAMES = {
  /** Images and videos: grid thumbnail. */
  thumb: 'thumb.webp',
  /** Images: lightbox preview. */
  preview: 'preview.webp',
  /** Images: the "web" download size. */
  web: 'web.jpg',
  /** Videos: poster frame. */
  poster: 'poster.jpg',
  /** Videos: 720p H.264 preview. */
  videoPreview: 'preview.mp4',
} as const;
export type DerivedVariant = keyof typeof DERIVED_FILE_NAMES;
export const DERIVED_VARIANTS = Object.keys(DERIVED_FILE_NAMES) as readonly DerivedVariant[];

/** Longest original name, in UTF-8 bytes, that a key may contain. */
export const ORIGINAL_NAME_MAX_BYTES = 255;

/** Longest id accepted as a key segment. */
export const KEY_SEGMENT_MAX_LENGTH = 128;

const SAFE_SEGMENT = new RegExp(`^[A-Za-z0-9_-]{1,${KEY_SEGMENT_MAX_LENGTH}}$`);

/**
 * True when `value` can be used as an id segment of a key: 1–128 characters from
 * `[A-Za-z0-9_-]`. That excludes `/`, `.`, `..`, whitespace and anything needing URL encoding.
 */
export function isSafeKeySegment(value: string): boolean {
  return SAFE_SEGMENT.test(value);
}

function segment(label: string, value: string): string {
  if (!isSafeKeySegment(value)) {
    throw new RangeError(
      `${label} ${JSON.stringify(value)} is not a safe S3 key segment ([A-Za-z0-9_-], 1–${KEY_SEGMENT_MAX_LENGTH} characters)`,
    );
  }
  return value;
}

// Control (Cc), format (Cf: bidi overrides, zero-width), lone surrogates (Cs) and line/paragraph
// separators. Bidi overrides can disguise an extension ("photo‮gpj.exe").
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu;
// Path separators, `?` and `#` (they break URLs if anyone forgets to encode), and the other
// characters AWS recommends avoiding in object keys.
const RESERVED = /[/\\?#%{}^~`[\]"<>|]/g;
const utf8 = new TextEncoder();

/** Length of `value` in UTF-8 bytes (a lone surrogate counts as the 3 bytes of U+FFFD). */
export function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

/** The longest prefix of `value` of at most `maxBytes` UTF-8 bytes. Never splits a code point. */
function utf8Prefix(value: string, maxBytes: number): string {
  let prefix = '';
  let used = 0;
  for (const ch of value) {
    used += utf8ByteLength(ch);
    if (used > maxBytes) break;
    prefix += ch;
  }
  return prefix;
}

/** Fallback stem when nothing is left of a name. */
const EMPTY_NAME = 'file';

/**
 * Truncates `name` to at most `maxBytes` UTF-8 bytes. The extension is kept when it fits with at
 * least one byte of stem; otherwise the whole name is truncated as if it had none, so the result
 * is never longer than `maxBytes`, however long the extension.
 */
function truncateUtf8(name: string, maxBytes: number): string {
  if (utf8ByteLength(name) <= maxBytes) return name;
  const suffix = fileExtension(name) === null ? '' : name.slice(name.lastIndexOf('.'));
  const keepSuffix = suffix !== '' && utf8ByteLength(suffix) + EMPTY_NAME.length <= maxBytes;
  const ext = keepSuffix ? suffix : '';
  const stem = utf8Prefix(name.slice(0, name.length - ext.length), maxBytes - utf8ByteLength(ext))
    // Trailing dots and spaces are not allowed (see sanitizeOriginalName).
    .replace(/[.\s]+$/u, '');
  const result = (stem === '' ? EMPTY_NAME : stem) + ext;
  // Unreachable with maxBytes >= 4; kept so the byte limit holds by construction.
  return utf8ByteLength(result) <= maxBytes ? result : utf8Prefix(result, maxBytes);
}

/**
 * Makes a client-supplied file name safe for the last segment of an `originals/` key: NFC,
 * without control or invisible characters, without `/`, `\` or other reserved characters
 * (replaced with `_`), without `..`, leading dots or trailing dots and spaces, and at most
 * {@link ORIGINAL_NAME_MAX_BYTES} UTF-8 bytes with the extension kept. Thai and other scripts are
 * kept. Returns `file` when nothing is left.
 *
 * The display name (`files.name`, used for Content-Disposition) is stored separately.
 */
export function sanitizeOriginalName(raw: string): string {
  const name = raw
    // NFC first: some characters normalize to reserved ones (U+1FEF becomes a backtick).
    .normalize('NFC')
    .replace(INVISIBLE, '')
    // Again: removing an invisible character can leave a sequence that NFC composes.
    .normalize('NFC')
    .replace(RESERVED, '_')
    .replace(/\s+/gu, ' ')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.\s]+/u, '')
    .replace(/[.\s]+$/u, '');
  return name === '' ? EMPTY_NAME : truncateUtf8(name, ORIGINAL_NAME_MAX_BYTES);
}

/** True when `name` is already in the form {@link sanitizeOriginalName} produces. */
export function isSafeOriginalName(name: string): boolean {
  return name !== '' && sanitizeOriginalName(name) === name;
}

// A lone surrogate can't be stored as UTF-8 (PostgreSQL rejects it).
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * True when a client-supplied file name is acceptable as input: 1 to
 * {@link ORIGINAL_NAME_MAX_BYTES} UTF-8 bytes and well-formed UTF-16 (no lone surrogates). It is
 * stored as the display name (`files.name`); the key segment is still built with
 * {@link sanitizeOriginalName}. API input validation uses {@link originalNameSchema}.
 */
export function isValidOriginalNameInput(name: string): boolean {
  return (
    name !== '' && !LONE_SURROGATE.test(name) && utf8ByteLength(name) <= ORIGINAL_NAME_MAX_BYTES
  );
}

/**
 * zod schema for a file name sent by a client (e.g. `POST /uploads/init`, rename): rejects empty
 * names, names over 255 UTF-8 bytes and lone surrogates.
 */
export const originalNameSchema = z
  .string()
  .min(1, { error: 'must not be empty' })
  .refine((name) => !LONE_SURROGATE.test(name), { error: 'must be well-formed Unicode' })
  .refine((name) => utf8ByteLength(name) <= ORIGINAL_NAME_MAX_BYTES, {
    error: `must be at most ${ORIGINAL_NAME_MAX_BYTES} UTF-8 bytes`,
  });

export interface FileKeyParts {
  photographerId: string;
  fileId: string;
}

/** `originals/{photographerId}/{fileId}/{originalName}`. Sanitize the name first. */
export function originalKey(parts: FileKeyParts & { originalName: string }): string {
  if (!isSafeOriginalName(parts.originalName)) {
    throw new RangeError(
      `Original name ${JSON.stringify(parts.originalName)} is not safe; pass it through sanitizeOriginalName first`,
    );
  }
  return `${originalsPrefix(parts.photographerId, parts.fileId)}${parts.originalName}`;
}

/** `derived/{photographerId}/{fileId}/{thumb.webp|preview.webp|web.jpg|poster.jpg|preview.mp4}`. */
export function derivedKey(parts: FileKeyParts, variant: DerivedVariant): string {
  const fileName = DERIVED_FILE_NAMES[variant] as string | undefined;
  if (fileName === undefined) {
    throw new RangeError(`Unknown derived variant ${JSON.stringify(variant)}`);
  }
  return `${derivedPrefix(parts.photographerId, parts.fileId)}${fileName}`;
}

/** Every derived key of a file, by variant. */
export function derivedKeys(parts: FileKeyParts): Record<DerivedVariant, string> {
  return Object.fromEntries(DERIVED_VARIANTS.map((v) => [v, derivedKey(parts, v)])) as Record<
    DerivedVariant,
    string
  >;
}

/**
 * `originals/{photographerId}/`, or `originals/{photographerId}/{fileId}/` with a file id. For
 * listing during purge and quota reconciliation.
 */
export function originalsPrefix(photographerId: string, fileId?: string): string {
  const base = `${S3_PREFIXES.originals}${segment('Photographer id', photographerId)}/`;
  return fileId === undefined ? base : `${base}${segment('File id', fileId)}/`;
}

/** `derived/{photographerId}/`, or `derived/{photographerId}/{fileId}/` with a file id. */
export function derivedPrefix(photographerId: string, fileId?: string): string {
  const base = `${S3_PREFIXES.derived}${segment('Photographer id', photographerId)}/`;
  return fileId === undefined ? base : `${base}${segment('File id', fileId)}/`;
}

/** `tmp/zips/{jobId}.zip`. */
export function zipKey(jobId: string): string {
  return `${S3_PREFIXES.tmpZips}${segment('Zip job id', jobId)}.zip`;
}

// --- Design images (ADR 0013) ------------------------------------------------------------------

/**
 * Objects of one design image: the uploaded bytes (`original`, no extension: its type is
 * `design_assets.mime`, and the presigned PUT sets the Content-Type) and the worker's `web.webp`
 * (long edge <= DESIGN_ASSET_LONG_EDGE, alpha kept, metadata stripped), the only one ever served.
 */
export const DESIGN_ASSET_FILE_NAMES = {
  original: 'original',
  web: 'web.webp',
} as const;
export type DesignAssetVariant = keyof typeof DESIGN_ASSET_FILE_NAMES;
export const DESIGN_ASSET_VARIANTS = Object.keys(
  DESIGN_ASSET_FILE_NAMES,
) as readonly DesignAssetVariant[];

export interface DesignAssetKeyParts {
  photographerId: string;
  assetId: string;
}

/** `designs/{photographerId}/{assetId}/original` or `.../web.webp`. */
export function designAssetKey(parts: DesignAssetKeyParts, variant: DesignAssetVariant): string {
  const fileName = DESIGN_ASSET_FILE_NAMES[variant] as string | undefined;
  if (fileName === undefined) {
    throw new RangeError(`Unknown design asset variant ${JSON.stringify(variant)}`);
  }
  return `${designAssetsPrefix(parts.photographerId, parts.assetId)}${fileName}`;
}

/** Both keys of a design image, by variant (the orphan purge deletes both). */
export function designAssetKeys(parts: DesignAssetKeyParts): Record<DesignAssetVariant, string> {
  return Object.fromEntries(
    DESIGN_ASSET_VARIANTS.map((v) => [v, designAssetKey(parts, v)]),
  ) as Record<DesignAssetVariant, string>;
}

/**
 * `designs/{photographerId}/`, or `designs/{photographerId}/{assetId}/` with an asset id. For
 * quota reconciliation (the `original` objects count) and purges.
 */
export function designAssetsPrefix(photographerId: string, assetId?: string): string {
  const base = `${S3_PREFIXES.designs}${segment('Photographer id', photographerId)}/`;
  return assetId === undefined ? base : `${base}${segment('Design asset id', assetId)}/`;
}

export type ParsedS3Key =
  | { kind: 'original'; photographerId: string; fileId: string; originalName: string }
  | { kind: 'derived'; photographerId: string; fileId: string; variant: DerivedVariant }
  | { kind: 'zip'; jobId: string }
  | {
      kind: 'designAsset';
      photographerId: string;
      assetId: string;
      variant: DesignAssetVariant;
    };

const VARIANT_BY_FILE_NAME = new Map<string, DerivedVariant>(
  DERIVED_VARIANTS.map((v) => [DERIVED_FILE_NAMES[v], v]),
);

const DESIGN_VARIANT_BY_FILE_NAME = new Map<string, DesignAssetVariant>(
  DESIGN_ASSET_VARIANTS.map((v) => [DESIGN_ASSET_FILE_NAMES[v], v]),
);

/**
 * Parses a (decoded) key built by the functions above. Returns null for any other key, including
 * keys with unsafe segments, so callers can reject what they didn't create.
 */
export function parseS3Key(key: string): ParsedS3Key | null {
  const s = key.split('/');
  const safe = (...ids: (string | undefined)[]) =>
    ids.every((id) => id !== undefined && isSafeKeySegment(id));

  if (s[0] === 'originals' && s.length === 4) {
    const [, photographerId = '', fileId = '', originalName = ''] = s;
    if (!safe(photographerId, fileId) || !isSafeOriginalName(originalName)) return null;
    return { kind: 'original', photographerId, fileId, originalName };
  }
  if (s[0] === 'derived' && s.length === 4) {
    const [, photographerId = '', fileId = '', fileName = ''] = s;
    const variant = VARIANT_BY_FILE_NAME.get(fileName);
    if (!safe(photographerId, fileId) || variant === undefined) return null;
    return { kind: 'derived', photographerId, fileId, variant };
  }
  if (s[0] === 'designs' && s.length === 4) {
    const [, photographerId = '', assetId = '', fileName = ''] = s;
    const variant = DESIGN_VARIANT_BY_FILE_NAME.get(fileName);
    if (!safe(photographerId, assetId) || variant === undefined) return null;
    return { kind: 'designAsset', photographerId, assetId, variant };
  }
  if (s[0] === 'tmp' && s[1] === 'zips' && s.length === 3) {
    const fileName = s[2] ?? '';
    const jobId = fileName.endsWith('.zip') ? fileName.slice(0, -'.zip'.length) : '';
    if (!safe(jobId)) return null;
    return { kind: 'zip', jobId };
  }
  return null;
}

/**
 * Decodes an object key from an S3 event notification. S3 URL-encodes keys in events the way
 * HTML forms do: a space arrives as `+` and a literal `+` as `%2B`.
 */
export function decodeS3EventKey(encoded: string): string {
  try {
    return decodeURIComponent(encoded.replace(/\+/g, '%20'));
  } catch {
    throw new RangeError(`S3 event key ${JSON.stringify(encoded)} is not valid URL encoding`);
  }
}
