import sharp, { type OutputInfo } from 'sharp';
import { REKOGNITION_INLINE_MAX_BYTES } from './provider';
import type { PixelRect, Size } from './types';

export interface EncodedImage extends Size {
  bytes: Buffer;
}

export interface JpegOptions {
  longEdge: number;
  quality: number;
  maxBytes: number;
}

// How an image is squeezed under maxBytes: lower the quality first, then the size.
const QUALITY_STEP = 5;
const MIN_QUALITY = 60;
const SHRINK_FACTOR = 0.85;
const MIN_LONG_EDGE = 320;

export class UnreadableImageError extends Error {
  constructor(cause: unknown) {
    super(`Image could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'UnreadableImageError';
  }
}

/** Pixel size after applying the EXIF orientation. */
export async function orientedSize(input: Uint8Array): Promise<Size> {
  try {
    const { autoOrient } = await sharp(input).metadata();
    return { width: autoOrient.width, height: autoOrient.height };
  } catch (error) {
    throw new UnreadableImageError(error);
  }
}

/**
 * Encodes `input`, or `region` of it in oriented pixels, as an auto-oriented JPEG whose long edge
 * is at most `longEdge` (never upscaled). All metadata, GPS included, is dropped. Quality and then
 * size go down until the result fits in `maxBytes`.
 */
export async function encodeJpeg(
  input: Uint8Array,
  options: JpegOptions,
  region?: PixelRect,
): Promise<EncodedImage> {
  let quality = options.quality;
  let longEdge = options.longEdge;
  for (;;) {
    let output: { data: Buffer; info: OutputInfo };
    try {
      let pipeline = sharp(input, { autoOrient: true });
      if (region) pipeline = pipeline.extract(region);
      output = await pipeline
        .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toBuffer({ resolveWithObject: true });
    } catch (error) {
      throw new UnreadableImageError(error);
    }
    const { data, info } = output;
    if (data.length <= options.maxBytes) {
      return { bytes: data, width: info.width, height: info.height };
    }
    if (quality - QUALITY_STEP >= MIN_QUALITY) {
      quality -= QUALITY_STEP;
    } else {
      longEdge = Math.floor(Math.max(info.width, info.height) * SHRINK_FACTOR);
      if (longEdge < MIN_LONG_EDGE) {
        throw new RangeError(`Image does not fit in ${options.maxBytes} bytes`);
      }
    }
  }
}

/** Prepares a selfie the way the web client does before upload. */
export function prepareSelfie(
  input: Uint8Array,
  options: { longEdge: number; jpegQuality: number },
): Promise<EncodedImage> {
  return encodeJpeg(input, {
    longEdge: options.longEdge,
    quality: options.jpegQuality,
    maxBytes: REKOGNITION_INLINE_MAX_BYTES,
  });
}
