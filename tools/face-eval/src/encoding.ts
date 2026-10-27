import {
  encodeJpeg,
  type IndexImage,
  orientedSize,
  REKOGNITION_INLINE_MAX_BYTES,
  tileRects,
} from '@shotx/face';
import type { FaceConfig } from '@shotx/shared';
import { type Dataset, readPhoto } from './dataset';

const KiB = 1024;
const MiB = 1024 * KiB;

/**
 * IndexFaces' limit for an S3Object image (15 MiB), the path used before ADR 0008 section 5. Now
 * every image goes as `Image.Bytes`, at most REKOGNITION_INLINE_MAX_BYTES (5 MiB). Only reference
 * runs use it: FakeFaceProvider replays it, the encoding survey measures it, Rekognition can't.
 */
export const LEGACY_S3_MAX_BYTES = 15 * MiB;

/** Whether production can send images of this limit (Image.Bytes); larger ones are reference only. */
export const isDeployableSize = (maxBytes: number): boolean =>
  maxBytes <= REKOGNITION_INLINE_MAX_BYTES;

/** `5 MiB`, `512 KiB` or `460800 bytes`. */
export function sizeLabel(bytes: number): string {
  if (bytes % MiB === 0) return `${bytes / MiB} MiB`;
  if (bytes % KiB === 0) return `${bytes / KiB} KiB`;
  return `${bytes} bytes`;
}

/** The part of an option key naming a byte limit: `5mib`, `512kib`, `460800b`. */
export function sizeKey(bytes: number): string {
  if (bytes % MiB === 0) return `${bytes / MiB}mib`;
  if (bytes % KiB === 0) return `${bytes / KiB}kib`;
  return `${bytes}b`;
}

/**
 * How the index images of one option were encoded. An image is **degraded** when the encoder had
 * to lower the JPEG quality or the size to fit the byte limit. An image that is not degraded is
 * byte-identical under any larger limit, so a larger limit can only change results through the
 * degraded ones.
 */
export interface EncodingStats {
  photos: number;
  /** Full images plus tiles. */
  images: number;
  tiles: number;
  degradedImages: number;
  /** Photos with at least one degraded image. */
  degradedPhotos: number;
  /** Photos whose full image was degraded. */
  degradedFullImages: number;
  downscaledImages: number;
  /** Lowest JPEG quality used; null without images. */
  minQuality: number | null;
  totalBytes: number;
  largestImageBytes: number;
}

export function emptyEncodingStats(): EncodingStats {
  return {
    photos: 0,
    images: 0,
    tiles: 0,
    degradedImages: 0,
    degradedPhotos: 0,
    degradedFullImages: 0,
    downscaledImages: 0,
    minQuality: null,
    totalBytes: 0,
    largestImageBytes: 0,
  };
}

type EncodedInfo = Pick<IndexImage, 'tile' | 'bytes' | 'quality' | 'downscaled'>;

const isDegraded = (image: EncodedInfo, requestedQuality: number) =>
  image.downscaled || image.quality < requestedQuality;

/** Adds one photo's images (`IndexPhotoResult.images`) to `stats`. */
export function addPhotoImages(
  stats: EncodingStats,
  images: readonly EncodedInfo[],
  requestedQuality: number,
): void {
  stats.photos++;
  let degraded = false;
  for (const image of images) {
    stats.images++;
    if (image.tile !== null) stats.tiles++;
    stats.totalBytes += image.bytes;
    stats.largestImageBytes = Math.max(stats.largestImageBytes, image.bytes);
    stats.minQuality =
      stats.minQuality === null ? image.quality : Math.min(stats.minQuality, image.quality);
    if (image.downscaled) stats.downscaledImages++;
    if (isDegraded(image, requestedQuality)) {
      stats.degradedImages++;
      degraded = true;
      if (image.tile === null) stats.degradedFullImages++;
    }
  }
  if (degraded) stats.degradedPhotos++;
}

export interface SurveyRequest {
  dataset: Dataset;
  config: FaceConfig;
  longEdges: readonly number[];
  sizes: readonly number[];
  concurrency: number;
  log: (message: string) => void;
}

export interface SurveyRow {
  longEdge: number;
  maxBytes: number;
  size: string;
  deployable: boolean;
  /** Full images only. */
  full: EncodingStats;
  /** Every 2×2 tile of every photo: an upper bound, production tiles only on a signal. */
  tiles: EncodingStats;
}

export interface Survey {
  photos: number;
  /** Full-image JPEG sizes at FACE_INDEX_JPEG_QUALITY without any limit, per long edge. */
  unlimitedFullBytes: Array<{ longEdge: number; p50: number; p95: number; max: number }>;
  rows: SurveyRow[];
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * Encodes every photo (full image and all tiles) under each byte limit, locally, without any
 * provider call, to show how many index images a limit changes: for the old 15 MiB S3 path versus
 * the 5 MiB bytes path on a real dataset, which Rekognition can no longer compare directly. Each
 * image is encoded once without a limit; only images larger than a limit are encoded again under
 * it. Counts only: no image data leaves memory.
 */
export async function surveyEncoding(request: SurveyRequest): Promise<Survey> {
  const { dataset, config, longEdges, sizes } = request;
  const quality = config.index.jpegQuality;
  const rows = new Map<string, SurveyRow>();
  const unlimited = new Map<number, number[]>();
  for (const longEdge of longEdges) {
    unlimited.set(longEdge, []);
    for (const maxBytes of sizes) {
      rows.set(`${longEdge}|${maxBytes}`, {
        longEdge,
        maxBytes,
        size: sizeLabel(maxBytes),
        deployable: isDeployableSize(maxBytes),
        full: emptyEncodingStats(),
        tiles: emptyEncodingStats(),
      });
    }
  }

  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < dataset.photos.length) {
      const photo = dataset.photos[next++]!;
      const original = await readPhoto(dataset, photo);
      const size = await orientedSize(original);
      const regions = [
        undefined,
        ...tileRects(size, config.index.tileGrid, config.index.tileOverlap),
      ];
      for (const longEdge of longEdges) {
        const perSize = new Map<number, { full: EncodedInfo[]; tiles: EncodedInfo[] }>(
          sizes.map((s) => [s, { full: [], tiles: [] }]),
        );
        for (const [i, region] of regions.entries()) {
          const tile = region === undefined ? null : i - 1;
          const encode = (maxBytes: number) =>
            encodeJpeg(original, { longEdge, quality, maxBytes, encode: config.encode }, region);
          const free = await encode(Number.MAX_SAFE_INTEGER);
          if (tile === null) unlimited.get(longEdge)!.push(free.bytes.length);
          for (const maxBytes of sizes) {
            const fitted = free.bytes.length <= maxBytes ? free : await encode(maxBytes);
            const info = {
              tile,
              bytes: fitted.bytes.length,
              quality: fitted.quality,
              downscaled: fitted.downscaled,
            };
            const bucket = perSize.get(maxBytes)!;
            (tile === null ? bucket.full : bucket.tiles).push(info);
          }
        }
        for (const maxBytes of sizes) {
          const row = rows.get(`${longEdge}|${maxBytes}`)!;
          const bucket = perSize.get(maxBytes)!;
          addPhotoImages(row.full, bucket.full, quality);
          addPhotoImages(row.tiles, bucket.tiles, quality);
        }
      }
      done++;
      if (done % 50 === 0) request.log(`  encoded ${done} of ${dataset.photos.length} photos`);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(request.concurrency, dataset.photos.length)) },
      worker,
    ),
  );

  return {
    photos: dataset.photos.length,
    unlimitedFullBytes: longEdges.map((longEdge) => {
      const sorted = [...unlimited.get(longEdge)!].sort((a, b) => a - b);
      return {
        longEdge,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        max: sorted.at(-1) ?? 0,
      };
    }),
    rows: [...rows.values()],
  };
}
