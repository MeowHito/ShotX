import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { encodeJpeg, orientedSize, prepareSelfie, UnreadableImageError } from './image';

function solid(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#808080' } })
    .jpeg()
    .toBuffer();
}

/** Random pixels: JPEG can't compress them, so file size tracks quality and dimensions. */
function noise(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3);
  for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24;
  return sharp(data, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

/** Stored 400×200, left half red and right half blue, with EXIF orientation 6 (rotate 90° CW). */
async function rotatedPhoto(): Promise<Buffer> {
  const width = 400;
  const height = 200;
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (x < width / 2) data[i] = 255;
      else data[i + 2] = 255;
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
}

const options = { longEdge: 3500, quality: 90, maxBytes: 15 * 1024 * 1024 };

describe('encodeJpeg', () => {
  it('caps the long edge and keeps the aspect ratio', async () => {
    const image = await encodeJpeg(await solid(4000, 3000), options);
    expect([image.width, image.height]).toEqual([3500, 2625]);
  });

  it('never upscales', async () => {
    const image = await encodeJpeg(await solid(800, 600), options);
    expect([image.width, image.height]).toEqual([800, 600]);
  });

  it('applies the EXIF orientation and strips metadata', async () => {
    const photo = await rotatedPhoto();
    expect(await orientedSize(photo)).toEqual({ width: 200, height: 400 });
    const image = await encodeJpeg(photo, options);
    expect([image.width, image.height]).toEqual([200, 400]);
    const metadata = await sharp(image.bytes).metadata();
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
  });

  it('extracts regions in oriented coordinates', async () => {
    // After rotating 90° clockwise, the stored left half (red) is the top half.
    const top = await encodeJpeg(await rotatedPhoto(), options, {
      left: 0,
      top: 0,
      width: 200,
      height: 200,
    });
    const { channels } = await sharp(top.bytes).stats();
    expect(channels[0]!.mean).toBeGreaterThan(200);
    expect(channels[2]!.mean).toBeLessThan(50);
  });

  it('lowers quality, then size, to fit the byte limit', async () => {
    const input = await noise(1600, 1600);
    const maxBytes = 200 * 1024;
    const image = await encodeJpeg(input, { ...options, maxBytes });
    expect(image.bytes.length).toBeLessThanOrEqual(maxBytes);
  });

  it('reports undecodable input', async () => {
    await expect(encodeJpeg(Buffer.from('not an image'), options)).rejects.toBeInstanceOf(
      UnreadableImageError,
    );
  });
});

describe('prepareSelfie', () => {
  it('downscales like the web client', async () => {
    const selfie = await prepareSelfie(await solid(3000, 4000), { longEdge: 1280, jpegQuality: 90 });
    expect([selfie.width, selfie.height]).toEqual([960, 1280]);
  });
});
