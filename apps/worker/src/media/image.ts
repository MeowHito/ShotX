import type { DesignAssetConfig, MediaConfig } from '@shotx/shared';
import sharp, { type Sharp } from 'sharp';
import { isTransientMediaFailure, MediaDecodeError, MediaFormatMismatchError } from './errors';
import { takenAtFromExif } from './exif';

// Keep memory flat on a long-running worker: libvips' operation cache only helps repeated work.
sharp.cache(false);

export interface ImageDerivatives {
  /** Width and height of the original after EXIF orientation. */
  width: number;
  height: number;
  takenAt: Date | null;
  thumb: Buffer;
  preview: Buffer;
  web: Buffer;
}

function decodeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isTransientMediaFailure(message)) return error instanceof Error ? error : new Error(message);
  return new MediaDecodeError(`Image could not be decoded: ${message}`);
}

/**
 * Renders the image derivatives from an original on disk: thumb.webp and preview.webp, and
 * web.jpg (the "web" download size), each fitted inside its long edge without enlarging. EXIF
 * orientation is applied, and every derivative is written without metadata (sharp strips EXIF
 * including GPS, XMP, IPTC and the ICC profile, converting to sRGB, unless asked to keep them).
 * Animated images use their first frame. Throws MediaDecodeError when the bytes don't decode.
 */
export async function renderImageDerivatives(
  path: string,
  config: MediaConfig,
  exifDefaultUtcOffset: string,
): Promise<ImageDerivatives> {
  try {
    const source = sharp(path, { failOn: 'error' });
    const metadata = await source.metadata();
    const { width, height } = metadata.autoOrient;
    if (!(width > 0 && height > 0)) throw new MediaDecodeError('Image has no dimensions');
    const fitted = (longEdge: number) =>
      source
        .clone()
        .autoOrient()
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true });
    const [thumb, preview, web] = await Promise.all([
      fitted(config.thumb.longEdge).webp({ quality: config.thumb.webpQuality }).toBuffer(),
      fitted(config.preview.longEdge).webp({ quality: config.preview.webpQuality }).toBuffer(),
      encodeWebJpeg(fitted, Math.max(width, height), config.web),
    ]);
    return {
      width,
      height,
      takenAt: takenAtFromExif(metadata.exif, exifDefaultUtcOffset),
      thumb,
      preview,
      web,
    };
  } catch (error) {
    if (error instanceof MediaDecodeError) throw error;
    throw decodeError(error);
  }
}

/** Each step down from the configured quality toward the minimum (ADR 0028). */
const WEB_QUALITY_STEP = 5;
/** Each step down of the long edge once the quality is at its minimum. */
const WEB_EDGE_FACTOR = 0.85;
/** web.jpg never gets smaller than this long edge, cap or not. */
const WEB_MIN_LONG_EDGE = 640;

/**
 * web.jpg within `config.maxBytes` (ADR 0028): the configured quality first, then lower quality
 * in steps down to `minJpegQuality`, then a smaller long edge at that quality, until it fits (or
 * the long edge reaches WEB_MIN_LONG_EDGE). A cap of 0 encodes once. `sourceLongEdge` is the
 * oriented original's long edge (never enlarged).
 */
async function encodeWebJpeg(
  fitted: (longEdge: number) => Sharp,
  sourceLongEdge: number,
  config: MediaConfig['web'],
): Promise<Buffer> {
  // JPEG has no alpha: transparent PNG/WebP areas become white, not black.
  const encode = (edge: number, quality: number) =>
    fitted(edge).flatten({ background: '#ffffff' }).jpeg({ quality, progressive: true }).toBuffer();
  let edge = Math.min(config.longEdge, sourceLongEdge);
  let quality = config.jpegQuality;
  let out = await encode(edge, quality);
  while (config.maxBytes > 0 && out.length > config.maxBytes) {
    if (quality > config.minJpegQuality) {
      quality = Math.max(config.minJpegQuality, quality - WEB_QUALITY_STEP);
    } else if (edge > WEB_MIN_LONG_EDGE) {
      edge = Math.max(WEB_MIN_LONG_EDGE, Math.floor(edge * WEB_EDGE_FACTOR));
    } else {
      break;
    }
    out = await encode(edge, quality);
  }
  return out;
}

/**
 * web.jpg alone, for an original whose web.jpg is over the cap (ADR 0028, `web.rerender`). The
 * same rendering as renderImageDerivatives' web.jpg. Throws MediaDecodeError when the bytes don't
 * decode.
 */
export async function renderWebJpeg(path: string, config: MediaConfig): Promise<Buffer> {
  try {
    const source = sharp(path, { failOn: 'error' });
    const { width, height } = (await source.metadata()).autoOrient;
    if (!(width > 0 && height > 0)) throw new MediaDecodeError('Image has no dimensions');
    const fitted = (longEdge: number) =>
      source
        .clone()
        .autoOrient()
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true });
    return await encodeWebJpeg(fitted, Math.max(width, height), config.web);
  } catch (error) {
    if (error instanceof MediaDecodeError) throw error;
    throw decodeError(error);
  }
}

/** A poster frame (PNG/JPEG on disk) as poster.jpg at full size and thumb.webp. */
export async function renderPosterDerivatives(
  framePath: string,
  config: MediaConfig,
): Promise<{ poster: Buffer; thumb: Buffer; width: number; height: number }> {
  try {
    const source = sharp(framePath, { failOn: 'error' });
    const { width, height } = (await source.metadata()).autoOrient;
    const [poster, thumb] = await Promise.all([
      source
        .clone()
        .autoOrient()
        .flatten({ background: '#000000' })
        .jpeg({ quality: config.poster.jpegQuality, progressive: true })
        .toBuffer(),
      source
        .clone()
        .autoOrient()
        .resize({
          width: config.thumb.longEdge,
          height: config.thumb.longEdge,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: config.thumb.webpQuality })
        .toBuffer(),
    ]);
    return { poster, thumb, width, height };
  } catch (error) {
    throw decodeError(error);
  }
}

export interface DesignAssetWeb {
  /** web.webp's bytes and dimensions (after EXIF orientation and the resize). */
  web: Buffer;
  width: number;
  height: number;
}

/**
 * A share page design image (ADR 0013) as `web.webp`: EXIF orientation applied, fitted inside
 * DESIGN_ASSET_LONG_EDGE without enlarging, alpha kept (lossless alpha plane), every metadata
 * block stripped (sharp writes none unless asked: no EXIF incl. GPS, XMP, IPTC or ICC; colours
 * converted to sRGB). Animated images use their first frame.
 *
 * The decoder's own idea of the format must be `expectedFormat` (the row's verified MIME type)
 * before anything is rendered: the magic-byte check ran on an earlier read, and the bytes may have
 * been replaced since. Throws MediaFormatMismatchError when it isn't, MediaDecodeError when the
 * bytes don't decode.
 */
export async function renderDesignAssetWeb(
  path: string,
  expectedFormat: 'jpeg' | 'png' | 'webp',
  config: Pick<DesignAssetConfig, 'longEdge' | 'webpQuality'>,
): Promise<DesignAssetWeb> {
  try {
    const source = sharp(path, { failOn: 'error' });
    const metadata = await source.metadata();
    if (metadata.format !== expectedFormat) {
      throw new MediaFormatMismatchError(expectedFormat, metadata.format);
    }
    const { width, height } = metadata.autoOrient;
    if (!(width > 0 && height > 0)) throw new MediaDecodeError('Image has no dimensions');
    const { data, info } = await source
      .autoOrient()
      .resize({
        width: config.longEdge,
        height: config.longEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: config.webpQuality, alphaQuality: 100 })
      .toBuffer({ resolveWithObject: true });
    return { web: data, width: info.width, height: info.height };
  } catch (error) {
    if (error instanceof MediaDecodeError || error instanceof MediaFormatMismatchError) throw error;
    throw decodeError(error);
  }
}
