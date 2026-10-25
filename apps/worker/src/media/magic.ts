import { UPLOAD_FILE_TYPES, type UploadMime } from '@shotx/shared';

/** Bytes the worker reads from the start of an object to sniff its type. */
export const MAGIC_BYTES_LENGTH = 64;

export type SniffedType = 'image/jpeg' | 'image/png' | 'image/webp' | 'video/iso-bmff';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * ISO-BMFF brands of still images and RAW files (HEIC/HEIF, AVIF, Canon CR3). They share the
 * `ftyp` box with MP4 and MOV, so a renamed HEIC would otherwise pass as a video.
 */
const IMAGE_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'mif2',
  'msf1',
  'avif',
  'avis',
  'crx ',
  'jp2 ',
  'jpx ',
]);

/** Top-level QuickTime atoms an older MOV may start with instead of `ftyp`. */
const QUICKTIME_ATOMS = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((b, i) => bytes[offset + i] === b);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function isoBmffBrands(bytes: Uint8Array): string[] | null {
  if (bytes.length < 12 || ascii(bytes, 4, 8) !== 'ftyp') return null;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  const end = Math.min(bytes.length, size >= 16 ? size : 16);
  const brands = [ascii(bytes, 8, 12)];
  for (let i = 16; i + 4 <= end; i += 4) brands.push(ascii(bytes, i, i + 4));
  return brands;
}

/** What the first bytes of an object say it is, or null when it's none of the allowed types. */
export function sniffMediaType(bytes: Uint8Array): SniffedType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  const brands = isoBmffBrands(bytes);
  if (brands !== null) {
    // The major brand decides; compatible brands of real videos often include mif1 (iPhone).
    return IMAGE_BRANDS.has(brands[0] ?? '') ? null : 'video/iso-bmff';
  }
  if (bytes.length >= 8 && QUICKTIME_ATOMS.has(ascii(bytes, 4, 8))) return 'video/iso-bmff';
  return null;
}

const SNIFFED_BY_MIME: Record<UploadMime, SniffedType> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
  // MP4 and MOV share the container; ffmpeg reads both, so the declared one isn't enforced.
  'video/mp4': 'video/iso-bmff',
  'video/quicktime': 'video/iso-bmff',
};

/**
 * True when the magic bytes match the declared MIME type (`files.mime`). Unknown MIME types
 * never match.
 */
export function magicBytesMatch(bytes: Uint8Array, declaredMime: string): boolean {
  const entry = UPLOAD_FILE_TYPES.find((t) => t.mime === declaredMime);
  if (entry === undefined) return false;
  return sniffMediaType(bytes) === SNIFFED_BY_MIME[entry.mime];
}
