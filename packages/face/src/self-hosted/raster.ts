import sharp from 'sharp';
import { UnreadableImageError } from '../image';

/** Decoded pixels: interleaved 8-bit RGB, row-major. */
export interface RgbImage {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface DecodeLimits {
  /**
   * The decoded long edge, at most (shrunk while loading where the format allows; never
   * upscaled). Unset: full size, bounded by `maxInputPixels` alone.
   */
  longEdge?: number | undefined;
  /** Images with more pixels than this (from the header) are refused before decoding. */
  maxInputPixels: number;
}

/**
 * Decodes an image (any format sharp reads) to oriented sRGB pixels with alpha flattened on white,
 * the way `encodeJpeg` prepares index images, bounded by `limits` so the memory one image can take
 * is bounded too (selfies come from anonymous viewers). Oversized or unreadable images throw
 * UnreadableImageError.
 */
export async function decodeRgb(input: Uint8Array, limits: DecodeLimits): Promise<RgbImage> {
  try {
    let pipeline = sharp(input, { autoOrient: true, limitInputPixels: limits.maxInputPixels });
    if (limits.longEdge !== undefined) {
      pipeline = pipeline.resize({
        width: limits.longEdge,
        height: limits.longEdge,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const { data, info } = await pipeline
      .flatten({ background: '#ffffff' })
      .toColourspace('srgb')
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 3) throw new Error(`expected 3 channels, got ${info.channels}`);
    return { data, width: info.width, height: info.height };
  } catch (error) {
    throw new UnreadableImageError(error);
  }
}

/** Resizes decoded pixels so the long edge is at most `longEdge` (never upscaled). */
export async function shrinkRgb(image: RgbImage, longEdge: number): Promise<RgbImage> {
  if (Math.max(image.width, image.height) <= longEdge) return image;
  const { data, info } = await sharp(image.data, {
    raw: { width: image.width, height: image.height, channels: 3 },
  })
    .resize({ width: longEdge, height: longEdge, fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
