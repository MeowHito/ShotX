import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMediaConfig } from '@shotx/shared';
import exifReader from 'exif-reader';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cameraJpeg, ffmpegAvailable, pngBytes, sampleVideo } from '../testing/fixtures';
import { MediaDecodeError } from './errors';
import { parseUtcOffset, takenAtFromExif } from './exif';
import { renderImageDerivatives, renderWebJpeg } from './image';
import { magicBytesMatch, sniffMediaType } from './magic';
import {
  extractPosterFrame,
  previewSize,
  probeVideo,
  transcodePreview,
  type VideoTools,
  videoTakenAt,
} from './video';

const media = loadMediaConfig({});
const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + 4 * compatible.length;
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(ascii(`ftyp${major}`), 4);
  compatible.forEach((brand, i) => bytes.set(ascii(brand), 16 + 4 * i));
  return bytes;
};

describe('magic bytes', () => {
  it('recognises the allowed types', async () => {
    expect(sniffMediaType(await cameraJpeg({ width: 20, height: 10 }))).toBe('image/jpeg');
    expect(sniffMediaType(await pngBytes())).toBe('image/png');
    const webp = await sharp(await pngBytes())
      .webp()
      .toBuffer();
    expect(sniffMediaType(webp)).toBe('image/webp');
    expect(sniffMediaType(ftyp('isom', 'isom', 'avc1'))).toBe('video/iso-bmff');
    expect(sniffMediaType(ftyp('qt  ', 'qt  '))).toBe('video/iso-bmff');
    // iPhone videos list mif1 among compatible brands; the major brand decides.
    expect(sniffMediaType(ftyp('qt  ', 'qt  ', 'mif1'))).toBe('video/iso-bmff');
    expect(sniffMediaType(new Uint8Array([0, 0, 0, 8, ...ascii('moov')]))).toBe('video/iso-bmff');
  });

  it('rejects HEIC, AVIF, RAW, executables and text', () => {
    expect(sniffMediaType(ftyp('heic', 'mif1', 'heic'))).toBeNull();
    expect(sniffMediaType(ftyp('avif', 'mif1'))).toBeNull();
    expect(sniffMediaType(ftyp('crx ', 'crx '))).toBeNull();
    expect(sniffMediaType(ascii('MZ\x90\x00 this is a PE file...'))).toBeNull();
    expect(sniffMediaType(ascii('<?xml version="1.0"?><svg/>'))).toBeNull();
    expect(sniffMediaType(new Uint8Array())).toBeNull();
  });

  it('matches the sniffed type against the declared MIME type', async () => {
    const jpeg = await cameraJpeg({ width: 20, height: 10 });
    expect(magicBytesMatch(jpeg, 'image/jpeg')).toBe(true);
    expect(magicBytesMatch(jpeg, 'image/png')).toBe(false);
    expect(magicBytesMatch(await pngBytes(), 'image/jpeg')).toBe(false);
    expect(magicBytesMatch(ftyp('isom'), 'video/mp4')).toBe(true);
    expect(magicBytesMatch(ftyp('qt  '), 'video/mp4')).toBe(true);
    expect(magicBytesMatch(ftyp('isom'), 'video/quicktime')).toBe(true);
    expect(magicBytesMatch(ftyp('heic'), 'video/quicktime')).toBe(false);
    expect(magicBytesMatch(jpeg, 'video/mp4')).toBe(false);
    expect(magicBytesMatch(jpeg, 'image/heic')).toBe(false);
  });
});

describe('EXIF capture time', () => {
  it('parses offsets', () => {
    expect(parseUtcOffset('+07:00')).toBe(420);
    expect(parseUtcOffset('-03:30')).toBe(-210);
    expect(parseUtcOffset('+15:00')).toBeNull();
    expect(parseUtcOffset('07:00')).toBeNull();
  });

  it('uses OffsetTimeOriginal, else the configured default offset', async () => {
    const exif = (await sharp(await cameraJpeg({ width: 20, height: 10 })).metadata()).exif;
    expect(takenAtFromExif(exif, '+00:00')?.toISOString()).toBe('2026-10-20T01:30:00.000Z');
    const noOffset = await sharp({
      create: { width: 4, height: 4, channels: 3, background: '#000' },
    })
      .withExif({ IFD2: { DateTimeOriginal: '2026:10:20 08:30:00' } })
      .jpeg()
      .toBuffer();
    const exif2 = (await sharp(noOffset).metadata()).exif;
    expect(takenAtFromExif(exif2, '+07:00')?.toISOString()).toBe('2026-10-20T01:30:00.000Z');
  });

  it('returns null for missing, broken or unset dates', async () => {
    expect(takenAtFromExif(undefined, '+07:00')).toBeNull();
    expect(takenAtFromExif(Buffer.from('garbage'), '+07:00')).toBeNull();
    const unset = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#000' } })
      .withExif({ IFD2: { DateTimeOriginal: '1970:01:01 00:00:00' } })
      .jpeg()
      .toBuffer();
    expect(takenAtFromExif((await sharp(unset).metadata()).exif, '+07:00')).toBeNull();
  });
});

describe('image derivatives', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'worker-image-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('applies EXIF orientation, fits each long edge and strips all metadata including GPS', async () => {
    const path = join(dir, 'camera.jpg');
    const original = await cameraJpeg();
    // The fixture really carries GPS and orientation.
    const before = await sharp(original).metadata();
    expect(before.orientation).toBe(6);
    expect(exifReader(before.exif!).GPSInfo?.GPSLatitude).toEqual([13, 45, 0]);
    await writeFile(path, original);

    const out = await renderImageDerivatives(path, media, '+07:00');
    expect([out.width, out.height]).toEqual([2000, 3000]);
    expect(out.takenAt?.toISOString()).toBe('2026-10-20T01:30:00.000Z');

    const expected = {
      thumb: { format: 'webp', width: 267, height: 400 },
      preview: { format: 'webp', width: 1365, height: 2048 },
      web: { format: 'jpeg', width: 1707, height: 2560 },
    } as const;
    for (const variant of ['thumb', 'preview', 'web'] as const) {
      const buffer = out[variant];
      const meta = await sharp(buffer).metadata();
      expect({ format: meta.format, width: meta.width, height: meta.height }).toEqual(
        expected[variant],
      );
      expect(meta.exif).toBeUndefined();
      expect(meta.xmp).toBeUndefined();
      expect(meta.iptc).toBeUndefined();
      expect(meta.icc).toBeUndefined();
      expect(meta.orientation).toBeUndefined();
      expect(buffer.includes(Buffer.from('TestCam'))).toBe(false);
      // Red was the left half of the stored image; rotated 90° clockwise it is on top.
      const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => [
        ...data.subarray(
          (y * info.width + x) * info.channels,
          (y * info.width + x) * info.channels + 3,
        ),
      ];
      const [r1, , b1] = pixel(Math.floor(info.width / 2), Math.floor(info.height / 4));
      const [r2, , b2] = pixel(Math.floor(info.width / 2), Math.floor((info.height * 3) / 4));
      expect(r1).toBeGreaterThan(200);
      expect(b1).toBeLessThan(60);
      expect(b2).toBeGreaterThan(200);
      expect(r2).toBeLessThan(60);
    }
  });

  it('never enlarges small images and uses web quality from config', async () => {
    const path = join(dir, 'small.png');
    await writeFile(path, await pngBytes());
    const out = await renderImageDerivatives(path, media, '+07:00');
    expect([out.width, out.height, out.takenAt]).toEqual([64, 48, null]);
    const web = await sharp(out.web).metadata();
    expect([web.format, web.width, web.height, web.hasAlpha]).toEqual(['jpeg', 64, 48, false]);
    expect((await sharp(out.thumb).metadata()).width).toBe(64);
  });

  it('keeps web.jpg under MEDIA_WEB_MAX_BYTES: lower quality first, then a smaller long edge (ADR 0028)', async () => {
    // Noise barely compresses, so a 2000 x 1500 JPEG is far over a 150 kB cap at any quality.
    const noise = Buffer.alloc(2000 * 1500 * 3);
    for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
    const path = join(dir, 'noise.jpg');
    await writeFile(
      path,
      await sharp(noise, { raw: { width: 2000, height: 1500, channels: 3 } })
        .jpeg({ quality: 95 })
        .toBuffer(),
    );
    const uncapped = await renderImageDerivatives(
      path,
      { ...media, web: { ...media.web, maxBytes: 0 } },
      '+07:00',
    );
    const maxBytes = 150_000;
    expect(uncapped.web.length).toBeGreaterThan(maxBytes);
    const capped = await renderImageDerivatives(
      path,
      { ...media, web: { ...media.web, maxBytes } },
      '+07:00',
    );
    expect(capped.web.length).toBeLessThanOrEqual(maxBytes);
    const meta = await sharp(capped.web).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBeLessThan(2000);
    expect(meta.width / meta.height).toBeCloseTo(2000 / 1500, 1);
    // The same rendering for web.rerender.
    expect((await renderWebJpeg(path, { ...media, web: { ...media.web, maxBytes } })).length).toBe(
      capped.web.length,
    );
  });

  it('throws MediaDecodeError for bytes that are not an image', async () => {
    const path = join(dir, 'broken.jpg');
    await writeFile(
      path,
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]),
    );
    await expect(renderImageDerivatives(path, media, '+07:00')).rejects.toBeInstanceOf(
      MediaDecodeError,
    );
  });
});

describe('video helpers', () => {
  it('sizes 720p previews on the short edge, even, never upscaled', () => {
    expect(previewSize(1920, 1080, 720)).toEqual({ width: 1280, height: 720 });
    expect(previewSize(1080, 1920, 720)).toEqual({ width: 720, height: 1280 });
    expect(previewSize(640, 360, 720)).toEqual({ width: 640, height: 360 });
    expect(previewSize(1001, 563, 720)).toEqual({ width: 1002, height: 564 });
  });

  it('reads capture time from QuickTime and MP4 tags', () => {
    expect(
      videoTakenAt({
        'com.apple.quicktime.creationdate': '2026-10-20T08:30:00+0700',
      })?.toISOString(),
    ).toBe('2026-10-20T01:30:00.000Z');
    expect(videoTakenAt({ creation_time: '2026-10-20T01:30:00.000000Z' })?.toISOString()).toBe(
      '2026-10-20T01:30:00.000Z',
    );
    expect(videoTakenAt({ creation_time: '1970-01-01T00:00:00Z' })).toBeNull();
    expect(videoTakenAt(undefined)).toBeNull();
  });
});

const tools: VideoTools = {
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  x264Preset: 'ultrafast',
  audioBitrateKbps: 96,
};

describe.skipIf(!ffmpegAvailable)('video derivatives (ffmpeg)', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'worker-video-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes rotation, writes a poster and a 720p H.264 +faststart preview without metadata', async () => {
    const path = join(dir, 'in.mp4');
    await writeFile(path, await sampleVideo(dir));
    const probe = await probeVideo(path, tools);
    expect([probe.width, probe.height, probe.hasAudio]).toEqual([720, 1280, true]);
    expect(probe.takenAt?.toISOString()).toBe('2026-10-20T01:30:00.000Z');

    const frame = await extractPosterFrame(path, probe, dir, tools);
    const frameMeta = await sharp(frame).metadata();
    expect([frameMeta.width, frameMeta.height]).toEqual([720, 1280]);

    const preview = await transcodePreview(path, probe, dir, media, tools);
    const out = await probeVideo(preview, tools);
    expect([out.width, out.height]).toEqual([720, 1280]);
    expect(out.takenAt).toBeNull();
    const { execFileSync } = await import('node:child_process');
    const info = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        preview,
      ]).toString(),
    ) as {
      streams: Array<{ codec_name: string; pix_fmt?: string }>;
      format: { tags?: Record<string, string> };
    };
    expect(info.streams.map((s) => s.codec_name)).toEqual(['h264', 'aac']);
    expect(info.streams[0]?.pix_fmt).toBe('yuv420p');
    expect(Object.keys(info.format.tags ?? {}).filter((t) => /location|creation/i.test(t))).toEqual(
      [],
    );
    // +faststart: the moov atom comes before mdat.
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(preview);
    expect(bytes.indexOf('moov')).toBeLessThan(bytes.indexOf('mdat'));
  });

  it('fails files without a video stream as undecodable', async () => {
    const path = join(dir, 'fake.mp4');
    await writeFile(path, Buffer.concat([ftyp('isom', 'isom'), Buffer.alloc(200)]));
    await expect(probeVideo(path, tools)).rejects.toBeInstanceOf(MediaDecodeError);
  });
});

if (!ffmpegAvailable) {
  describe('video derivatives (ffmpeg)', () => {
    it.skip('skipped: ffmpeg/ffprobe not found on PATH (install ffmpeg to run the video tests)', () =>
      undefined);
  });
}
