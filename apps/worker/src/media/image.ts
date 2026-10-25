import type { MediaConfig } from '@shotx/shared';
import sharp from 'sharp';
import { isTransientMediaFailure, MediaDecodeError } from './errors';
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
      fitted(config.web.longEdge)
        // JPEG has no alpha: transparent PNG/WebP areas become white, not black.
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: config.web.jpegQuality, progressive: true })
        .toBuffer(),
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
