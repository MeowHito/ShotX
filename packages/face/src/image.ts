import type { FaceConfig } from '@shotx/shared';
import sharp from 'sharp';
import { REKOGNITION_INLINE_MAX_BYTES } from './provider';
import type { PixelRect, Size } from './types';

export interface EncodedImage extends Size {
  bytes: Buffer;
  /** JPEG quality the image was written with: lower than requested when it had to fit. */
  quality: number;
  /** True when the long edge had to shrink below the requested one to fit the byte limit. */
  downscaled: boolean;
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

interface RawImage {
  data: Buffer;
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/** Decodes, orients, crops and downsizes once per size; every quality step re-encodes these pixels. */
async function decode(input: Uint8Array, longEdge: number, region?: PixelRect): Promise<RawImage> {
  try {
    let pipeline = sharp(input, { autoOrient: true });
    if (region) pipeline = pipeline.extract(region);
    const { data, info } = await pipeline
      .resize({ width: longEdge, height: longEdge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels };
  } catch (error) {
    throw new UnreadableImageError(error);
  }
}

function toJpeg(raw: RawImage, quality: number): Promise<Buffer> {
  const { data, width, height, channels } = raw;
  return sharp(data, { raw: { width, height, channels } }).jpeg({ quality }).toBuffer();
}

/**
 * Encodes `input`, or `region` of it in oriented pixels, as an auto-oriented JPEG whose long edge
 * is at most `longEdge` (never upscaled). All metadata, GPS included, is dropped. Quality and then
 * size go down until the result fits in `maxBytes`: quality in `qualityStep`s down to
 * `minQuality`, then the long edge by `shrinkFactor`, with `minLongEdge` itself as the last size
 * tried. FaceConfig guarantees that a square image of `minLongEdge` fits FACE_INDEX_MAX_BYTES at
 * any quality (`faceEncodeFloorBytes`), so with the configured options this never gives up.
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
  if (!(options.maxBytes >= 1)) throw new RangeError('maxBytes must be at least 1');
  let quality = options.quality;
  let longEdge = options.longEdge;
  let downscaled = false;
  for (;;) {
    const raw = await decode(input, longEdge, region);
    for (;;) {
      const bytes = await toJpeg(raw, quality);
      if (bytes.length <= options.maxBytes) {
        return { bytes, width: raw.width, height: raw.height, quality, downscaled };
      }
      if (quality - qualityStep < minQuality) break;
      quality -= qualityStep;
    }
    const current = Math.max(raw.width, raw.height);
    if (current <= minLongEdge) {
      throw new RangeError(`Image does not fit in ${options.maxBytes} bytes`);
    }
    // Never skip minLongEdge itself: it is the size the configuration guarantees to fit.
    longEdge = Math.max(minLongEdge, Math.floor(current * shrinkFactor));
    downscaled = true;
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
