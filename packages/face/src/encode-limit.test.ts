import { faceEncodeFloorBytes, loadFaceConfig } from '@shotx/shared';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { encodeJpeg, type JpegOptions } from './image';
import { indexPhoto, indexPhotoOptions } from './index-photo';
import {
  type FaceProvider,
  type IndexFacesRequest,
  REKOGNITION_INLINE_MAX_BYTES,
} from './provider';

// Worst cases for the 5 MiB Image.Bytes limit (ADR 0008 section 5): pixel noise, which JPEG can't
// compress, at sizes above FACE_INDEX_LONG_EDGE. At 3500 px and quality 90 noise is about 7.6 MB.

const SLOW_MS = 120_000;
const config = loadFaceConfig({});

/** Deterministic xorshift noise, `channels` bytes per pixel. */
function noisePixels(width: number, height: number, channels = 3): Buffer {
  const data = Buffer.alloc(width * height * channels);
  let x = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    data[i] = x & 0xff;
  }
  return data;
}

function noiseJpeg(width: number, height: number, quality = 95): Promise<Buffer> {
  return sharp(noisePixels(width, height), { raw: { width, height, channels: 3 } })
    .jpeg({ quality })
    .toBuffer();
}

/** Accepts every image and finds nothing; records what was sent. */
function recordingProvider(): { provider: FaceProvider; sent: IndexFacesRequest[] } {
  const sent: IndexFacesRequest[] = [];
  const empty = () => Promise.resolve();
  const provider: FaceProvider = {
    createCollection: () => Promise.resolve({}),
    deleteCollection: empty,
    indexFaces: (request) => {
      sent.push(request);
      return Promise.resolve({ faces: [], unindexed: [] });
    },
    searchFacesByImage: () => Promise.resolve([]),
    searchFaces: () => Promise.resolve([]),
    deleteFaces: empty,
    listFaces: () => Promise.resolve({ faces: [] }),
  };
  return { provider, sent };
}

describe('worst-case images under the 5 MiB Image.Bytes limit', () => {
  // 3500 px: the full image is not resized, so the noise survives. 6000 × 4000: each 2×2 tile
  // (3244 × 2163 with 15% overlap) is below 3500 px and is cut without resizing.
  let atLongEdge: Buffer;
  let large: Buffer;
  beforeAll(async () => {
    [atLongEdge, large] = await Promise.all([noiseJpeg(3500, 2333), noiseJpeg(6000, 4000)]);
  }, SLOW_MS);

  it('defaults FACE_INDEX_MAX_BYTES to the limit', () => {
    expect(config.index.maxBytes).toBe(REKOGNITION_INLINE_MAX_BYTES);
  });

  const options = {
    ...indexPhotoOptions(config, { collectionId: 'pg-1', fileId: 'file-1' }),
    tiling: 'always' as const,
  };

  it(
    'fits a full image that was 7.6 MB at the configured quality by lowering quality',
    async () => {
      const { provider, sent } = recordingProvider();
      const result = await indexPhoto({ provider }, atLongEdge, options);
      for (const request of sent) {
        expect(request.image.bytes.length).toBeLessThanOrEqual(REKOGNITION_INLINE_MAX_BYTES);
      }
      const full = result.images[0]!;
      expect(full).toMatchObject({ tile: null, width: 3500, height: 2333, downscaled: false });
      // Under the old 15 MiB S3 limit this image went at quality 90; now it gives some up.
      expect(full.quality).toBeLessThan(config.index.jpegQuality);
      expect(full.quality).toBeGreaterThanOrEqual(config.encode.minQuality);
    },
    SLOW_MS,
  );

  it(
    'fits every tile of a 24 MP noise photo',
    async () => {
      const { provider, sent } = recordingProvider();
      const result = await indexPhoto({ provider }, large, options);
      expect(sent).toHaveLength(1 + config.index.tileGrid ** 2);
      for (const request of sent) {
        expect(request.image.bytes.length).toBeLessThanOrEqual(REKOGNITION_INLINE_MAX_BYTES);
      }
      const tiles = result.images.filter((image) => image.tile !== null);
      expect(tiles).toHaveLength(config.index.tileGrid ** 2);
      for (const tile of tiles) {
        expect(tile).toMatchObject({ width: 3244, height: 2163 });
        expect(tile.bytes).toBeLessThanOrEqual(REKOGNITION_INLINE_MAX_BYTES);
        expect(tile.quality).toBeLessThan(config.index.jpegQuality);
      }
    },
    SLOW_MS,
  );

  it(
    'fits a lossless noise PNG too',
    async () => {
      const png = await sharp(noisePixels(4000, 3000), {
        raw: { width: 4000, height: 3000, channels: 3 },
      })
        .png({ compressionLevel: 1 })
        .toBuffer();
      const image = await encodeJpeg(png, {
        longEdge: config.index.longEdge,
        quality: config.index.jpegQuality,
        maxBytes: config.index.maxBytes,
        encode: config.encode,
      });
      expect(image.bytes.length).toBeLessThanOrEqual(REKOGNITION_INLINE_MAX_BYTES);
      expect(image.quality).toBeLessThan(config.index.jpegQuality);
    },
    SLOW_MS,
  );
});

describe('the shrink path', () => {
  it(
    'shrinks once quality is at its floor, and stays under the limit',
    async () => {
      const input = await noiseJpeg(3000, 3000);
      const maxBytes = 1024 * 1024;
      const image = await encodeJpeg(input, {
        longEdge: 3000,
        quality: 90,
        maxBytes,
        encode: config.encode,
      });
      expect(image.bytes.length).toBeLessThanOrEqual(maxBytes);
      expect(image.downscaled).toBe(true);
      expect(image.quality).toBe(config.encode.minQuality);
      expect(Math.max(image.width, image.height)).toBeLessThan(3000);
      expect(Math.max(image.width, image.height)).toBeGreaterThanOrEqual(config.encode.minLongEdge);
    },
    SLOW_MS,
  );

  it(
    'tries FACE_ENCODE_MIN_LONG_EDGE itself before giving up',
    async () => {
      const minLongEdge = 320;
      const input = await noiseJpeg(2000, 2000);
      const encode = { qualityStep: 5, minQuality: 100, shrinkFactor: 0.85, minLongEdge };
      const at = async (edge: number) =>
        (await encodeJpeg(input, { longEdge: edge, quality: 100, maxBytes: 1e9, encode })).bytes
          .length;
      // 2000 × 0.85ⁿ goes …, 392, 333, 283: the step after 333 jumps below 320.
      const [at320, at333] = [await at(320), await at(333)];
      expect(at320).toBeLessThan(at333);
      const options: JpegOptions = {
        longEdge: 2000,
        quality: 100,
        maxBytes: Math.floor((at320 + at333) / 2),
        encode,
      };
      const image = await encodeJpeg(input, options);
      expect([image.width, image.height]).toEqual([minLongEdge, minLongEdge]);
      expect(image.bytes.length).toBeLessThanOrEqual(options.maxBytes);
      // Below the floor it still gives up rather than send something useless.
      await expect(encodeJpeg(input, { ...options, maxBytes: at320 - 1 })).rejects.toThrow(
        /does not fit/,
      );
    },
    SLOW_MS,
  );

  it('fits noise at FACE_ENCODE_MIN_LONG_EDGE within the bound FaceConfig checks', async () => {
    const edge = config.encode.minLongEdge;
    const input = await noiseJpeg(edge, edge, 100);
    const image = await encodeJpeg(input, {
      longEdge: edge,
      quality: 100,
      maxBytes: faceEncodeFloorBytes(edge),
      encode: config.encode,
    });
    expect(image).toMatchObject({ quality: 100, downscaled: false });
    expect(faceEncodeFloorBytes(edge)).toBeLessThanOrEqual(config.index.maxBytes);
  });
});
