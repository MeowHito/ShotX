import { fileExtension } from './media-types';

/**
 * S3 key layout of the media bucket. Every key that belongs to a photographer contains their id,
 * so storage and bandwidth can be attributed from CloudFront standard logs. Build keys only with
 * the functions below; never concatenate them by hand.
 *
 *   originals/{photographerId}/{fileId}/{originalName}     Intelligent-Tiering
 *   derived/{photographerId}/{fileId}/{variant file}       thumb.webp, preview.webp, web.jpg,
 *                                                          poster.jpg, preview.mp4
 *   tmp/index/{fileId}/{attemptId}/{part}.jpg              part: full | t{n}   (ADR 0004)
 *   tmp/zips/{jobId}.zip                                   tmp/ is lifecycle-expired
 */
export const S3_PREFIXES = {
  originals: 'originals/',
  derived: 'derived/',
  tmp: 'tmp/',
  tmpIndex: 'tmp/index/',
  tmpZips: 'tmp/zips/',
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

function truncateUtf8(name: string, maxBytes: number): string {
  if (utf8.encode(name).length <= maxBytes) return name;
  const ext = fileExtension(name);
  const suffix = ext === null ? '' : name.slice(name.lastIndexOf('.'));
  const budget = maxBytes - utf8.encode(suffix).length;
  let stem = '';
  let used = 0;
  // Iterates code points, so surrogate pairs are never split.
  for (const ch of name.slice(0, name.length - suffix.length)) {
    used += utf8.encode(ch).length;
    if (used > budget) break;
    stem += ch;
  }
  stem = stem.replace(/[.\s]+$/u, '');
  return (stem === '' ? 'file' : stem) + suffix;
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
  return name === '' ? 'file' : truncateUtf8(name, ORIGINAL_NAME_MAX_BYTES);
}

/** True when `name` is already in the form {@link sanitizeOriginalName} produces. */
export function isSafeOriginalName(name: string): boolean {
  return name !== '' && sanitizeOriginalName(name) === name;
}

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

/** The full index image of a photo. */
export const INDEX_IMAGE_FULL = 'full';

/** `full` for the whole photo, `t{n}` for tile n (0-based, the same index as `PhotoFace.tile`). */
export type IndexImagePart = typeof INDEX_IMAGE_FULL | `t${number}`;

const TILE_PART = /^t(0|[1-9][0-9]{0,2})$/;

/** Part name of tile `tile` (0–999). */
export function indexTilePart(tile: number): IndexImagePart {
  if (!Number.isInteger(tile) || tile < 0 || tile > 999) {
    throw new RangeError(`Tile index ${tile} must be an integer from 0 to 999`);
  }
  return `t${tile}`;
}

function isIndexImagePart(part: string): part is IndexImagePart {
  return part === INDEX_IMAGE_FULL || TILE_PART.test(part);
}

export interface IndexImageKeyParts {
  fileId: string;
  /** Unique per indexing attempt, so concurrent attempts for one file never share a key. */
  attemptId: string;
  part: IndexImagePart;
}

/** `tmp/index/{fileId}/{attemptId}/{part}.jpg` (ADR 0004). */
export function indexImageKey(parts: IndexImageKeyParts): string {
  if (!isIndexImagePart(parts.part)) {
    throw new RangeError(`Index image part ${JSON.stringify(parts.part)} must be full or t{n}`);
  }
  return `${indexImagePrefix(parts.fileId, parts.attemptId)}${parts.part}.jpg`;
}

/** `tmp/index/{fileId}/`, or `tmp/index/{fileId}/{attemptId}/` with an attempt id. */
export function indexImagePrefix(fileId: string, attemptId?: string): string {
  const base = `${S3_PREFIXES.tmpIndex}${segment('File id', fileId)}/`;
  return attemptId === undefined ? base : `${base}${segment('Attempt id', attemptId)}/`;
}

export type ParsedS3Key =
  | { kind: 'original'; photographerId: string; fileId: string; originalName: string }
  | { kind: 'derived'; photographerId: string; fileId: string; variant: DerivedVariant }
  | { kind: 'index'; fileId: string; attemptId: string; part: IndexImagePart }
  | { kind: 'zip'; jobId: string };

const VARIANT_BY_FILE_NAME = new Map<string, DerivedVariant>(
  DERIVED_VARIANTS.map((v) => [DERIVED_FILE_NAMES[v], v]),
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
  if (s[0] === 'tmp' && s[1] === 'index' && s.length === 5) {
    const [, , fileId = '', attemptId = '', fileName = ''] = s;
    const part = fileName.endsWith('.jpg') ? fileName.slice(0, -'.jpg'.length) : '';
    if (!safe(fileId, attemptId) || !isIndexImagePart(part)) return null;
    return { kind: 'index', fileId, attemptId, part };
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
