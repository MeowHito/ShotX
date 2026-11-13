import type { SyncPrepare } from './engine';
import type { WatermarkPosition, WatermarkSettings } from './store';

/**
 * ADR 0021: the photographer's watermark, burned into each synced photo in the browser before
 * upload (folder sync only). The file keeps its name; JPEGs keep their EXIF (the shooting date
 * orders the share page), with the orientation reset to 1 because the pixels are drawn upright
 * and the embedded EXIF thumbnail dropped (it would be an unwatermarked copy). Videos and other
 * types go up unchanged.
 *
 * ADR 0022: the logo is trimmed to its visible pixels (a transparent border in the PNG used to
 * make it look smaller than the size set), and the frame mode stretches the landscape or
 * portrait frame over the whole photo, picked by the photo's own orientation.
 */

/** Types the browser can decode and encode again. */
const WATERMARKABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface WatermarkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the mark goes on a photo: its width is `sizePercent` of the photo's shorter side (so
 * portrait and landscape photos get the same mark), its height follows the mark's aspect ratio,
 * and it keeps `marginPercent` of the shorter side from the edges it is placed against. Never
 * wider or taller than the photo.
 */
export function watermarkBox(
  photo: { width: number; height: number },
  mark: { width: number; height: number },
  settings: Pick<WatermarkSettings, 'position' | 'sizePercent' | 'marginPercent'>,
): WatermarkBox {
  const shorter = Math.min(photo.width, photo.height);
  let width = (shorter * settings.sizePercent) / 100;
  let height = (width * mark.height) / Math.max(1, mark.width);
  const fit = Math.min(1, photo.width / width, photo.height / height);
  width *= fit;
  height *= fit;
  const margin = (shorter * settings.marginPercent) / 100;
  const [h, v] = placement(settings.position);
  const along = (free: number, where: 'start' | 'middle' | 'end') =>
    where === 'start'
      ? Math.min(margin, free)
      : where === 'end'
        ? Math.max(0, free - margin)
        : free / 2;
  return {
    x: Math.round(along(photo.width - width, h)),
    y: Math.round(along(photo.height - height, v)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function placement(
  position: WatermarkPosition,
): ['start' | 'middle' | 'end', 'start' | 'middle' | 'end'] {
  const horizontal = position.includes('left')
    ? 'start'
    : position.includes('right')
      ? 'end'
      : 'middle';
  const vertical = position.startsWith('top')
    ? 'start'
    : position.startsWith('bottom')
      ? 'end'
      : 'middle';
  return [horizontal, vertical];
}

// --- JPEG EXIF ---------------------------------------------------------------------------------

/** The APP1 "Exif" segment of a JPEG (marker and length included), or null. */
export function jpegExifSegment(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= jpeg.length) {
    if (jpeg[i] !== 0xff) return null;
    const marker = jpeg[i + 1] ?? 0;
    // Start of scan or end of image: no more metadata segments.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = ((jpeg[i + 2] ?? 0) << 8) | (jpeg[i + 3] ?? 0);
    if (length < 2) return null;
    const isExif =
      marker === 0xe1 &&
      jpeg[i + 4] === 0x45 && // E
      jpeg[i + 5] === 0x78 && // x
      jpeg[i + 6] === 0x69 && // i
      jpeg[i + 7] === 0x66 && // f
      jpeg[i + 8] === 0 &&
      jpeg[i + 9] === 0;
    if (isExif) return jpeg.slice(i, i + 2 + length);
    i += 2 + length;
  }
  return null;
}

/**
 * A copy of an EXIF segment with IFD0's Orientation set to 1 and the link to IFD1 (the
 * embedded thumbnail) cut. Unparseable data comes back unchanged.
 */
export function uprightExif(segment: Uint8Array): Uint8Array {
  const out = segment.slice();
  const tiff = 10; // FF E1, length (2), "Exif\0\0"
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (out.length < tiff + 8) return out;
  const order = view.getUint16(tiff);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return out;
  const ifd0 = tiff + view.getUint32(tiff + 4, little);
  if (ifd0 + 2 > out.length) return out;
  const count = view.getUint16(ifd0, little);
  for (let n = 0; n < count; n++) {
    const entry = ifd0 + 2 + n * 12;
    if (entry + 12 > out.length) return out;
    // 0x0112 Orientation, type SHORT (3): the value sits in the first 2 bytes of the value field.
    if (view.getUint16(entry, little) === 0x0112 && view.getUint16(entry + 2, little) === 3) {
      view.setUint16(entry + 8, 1, little);
    }
  }
  const next = ifd0 + 2 + count * 12;
  if (next + 4 <= out.length) view.setUint32(next, 0, little);
  return out;
}

/**
 * `jpeg` (a browser encoder's output, which carries no EXIF) with `segment` inserted after SOI
 * and a leading JFIF APP0.
 */
export function withExifSegment(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + (((jpeg[4] ?? 0) << 8) | (jpeg[5] ?? 0));
  const body = jpeg.subarray(at);
  const result = new Uint8Array(at + segment.length + body.length);
  result.set(jpeg.subarray(0, at), 0);
  result.set(segment, at);
  result.set(body, at + segment.length);
  return result;
}

// --- Logo trim and frames (ADR 0022) ---------------------------------------------------------

/** Alpha at or below this counts as empty when trimming a logo's border. */
const TRIM_ALPHA = 8;

/**
 * The smallest box holding every visible pixel of RGBA `data` (alpha > TRIM_ALPHA), or null
 * when nothing is visible.
 */
export function alphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): WatermarkBox | null {
  let top = height;
  let bottom = -1;
  let left = width;
  let right = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if ((data[row + x * 4 + 3] ?? 0) > TRIM_ALPHA) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (bottom < 0) return null;
  return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}

/** The logo without its transparent border (unchanged when it has none or can't be read). */
export async function trimmedMark(image: Blob): Promise<ImageBitmap> {
  const mark = await createImageBitmap(image);
  try {
    const canvas = new OffscreenCanvas(mark.width, mark.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx === null) return mark;
    ctx.drawImage(mark, 0, 0);
    const box = alphaBounds(
      ctx.getImageData(0, 0, mark.width, mark.height).data,
      mark.width,
      mark.height,
    );
    if (box === null || (box.width === mark.width && box.height === mark.height)) return mark;
    const trimmed = await createImageBitmap(mark, box.x, box.y, box.width, box.height);
    mark.close();
    return trimmed;
  } catch {
    return mark;
  }
}

/**
 * Which frame a photo gets: landscape for photos at least as wide as tall, portrait otherwise.
 * A photo whose orientation has no frame gets none.
 */
export function frameFor<T>(
  photo: { width: number; height: number },
  frames: { landscape: T | null; portrait: T | null },
): T | null {
  return photo.width >= photo.height ? frames.landscape : frames.portrait;
}

// --- Composition -------------------------------------------------------------------------------

export interface WatermarkerOptions {
  /** JPEG and WebP quality of the re-encoded photo (0–1). */
  quality: number;
}

/**
 * The folder sync's prepare step for these settings: decodes the logo (trimmed) or the frames
 * once, then draws each photo upright with the mark on top and encodes it in its own type. In
 * logo mode the logo goes where the settings place it (globalAlpha = opacity); in frame mode the
 * frame for the photo's orientation covers the whole photo, and a photo with no frame for its
 * orientation is uploaded as it is.
 */
export async function createWatermarker(
  settings: WatermarkSettings,
  options: WatermarkerOptions,
): Promise<SyncPrepare> {
  const frameMode = settings.mode === 'frame';
  const decode = (blob: Blob | null) => (blob === null ? null : createImageBitmap(blob));
  const [logo, landscape, portrait] = await Promise.all([
    !frameMode && settings.image !== null ? trimmedMark(settings.image) : null,
    frameMode ? decode(settings.frameLandscape) : null,
    frameMode ? decode(settings.framePortrait) : null,
  ]);
  if (frameMode ? landscape === null && portrait === null : logo === null) {
    throw new Error('watermark has no image');
  }
  return async (file) => {
    if (!WATERMARKABLE.has(file.type)) return file;
    const photo = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const frame = frameMode ? frameFor(photo, { landscape, portrait }) : null;
      if (frameMode && frame === null) return file;
      const canvas = new OffscreenCanvas(photo.width, photo.height);
      const ctx = canvas.getContext('2d');
      if (ctx === null) throw new Error('no 2d canvas');
      ctx.drawImage(photo, 0, 0);
      if (frame !== null) {
        ctx.drawImage(frame, 0, 0, photo.width, photo.height);
      } else if (logo !== null) {
        const box = watermarkBox(photo, logo, settings);
        ctx.globalAlpha = Math.min(1, Math.max(0, settings.opacityPercent / 100));
        ctx.drawImage(logo, box.x, box.y, box.width, box.height);
      }
      const encoded = await canvas.convertToBlob({ type: file.type, quality: options.quality });
      if (encoded.type !== file.type) throw new Error(`browser can't encode ${file.type}`);
      let parts: BlobPart[] = [encoded];
      if (file.type === 'image/jpeg') {
        const exif = jpegExifSegment(new Uint8Array(await file.arrayBuffer()));
        if (exif !== null) {
          const bytes = withExifSegment(
            new Uint8Array(await encoded.arrayBuffer()),
            uprightExif(exif),
          );
          parts = [
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          ];
        }
      }
      return new File(parts, file.name, { type: file.type, lastModified: file.lastModified });
    } finally {
      photo.close();
    }
  };
}
