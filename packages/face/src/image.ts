import type { FaceConfig } from '@shotx/shared';
import sharp, { type OutputInfo } from 'sharp';
import { REKOGNITION_INLINE_MAX_BYTES } from './provider';
import type { PixelRect, Size } from './types';

export interface EncodedImage extends Size {
  bytes: Buffer;
}

/** How an image is squeezed under its byte limit: lower the quality first, then the size. */
export type EncodeOptions = FaceConfig['encode'];

export interface JpegOptions {
  longEdge: number;
  quality: number;
  maxBytes: number;
  encode: EncodeOptions;
}

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
  const { qualityStep, minQuality, shrinkFactor, minLongEdge } = options.encode;
  // Without these the loop below would never end.
  if (!(qualityStep >= 1 && shrinkFactor > 0 && shrinkFactor < 1 && minLongEdge >= 1)) {
    throw new RangeError('Invalid JPEG encode options');
  }
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
    if (quality - qualityStep >= minQuality) {
      quality -= qualityStep;
    } else {
      longEdge = Math.floor(Math.max(info.width, info.height) * shrinkFactor);
      if (longEdge < minLongEdge) {
        throw new RangeError(`Image does not fit in ${options.maxBytes} bytes`);
      }
    }
  }
}

/** Prepares a selfie the way the web client does before upload. */
export function prepareSelfie(
  input: Uint8Array,
  config: Pick<FaceConfig, 'selfie' | 'encode'>,
): Promise<EncodedImage> {
  return encodeJpeg(input, {
    longEdge: config.selfie.longEdge,
    quality: config.selfie.jpegQuality,
    maxBytes: REKOGNITION_INLINE_MAX_BYTES,
    encode: config.encode,
  });
}
