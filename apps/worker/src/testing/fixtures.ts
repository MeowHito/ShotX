import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

/**
 * A camera-like JPEG: stored 3000×2000 (left half red, right half blue) with EXIF Orientation 6
 * (display rotated 90° clockwise, so 2000×3000 with red on top), DateTimeOriginal with an offset,
 * a camera make and GPS coordinates.
 */
export async function cameraJpeg(
  options: { width?: number; height?: number; orientation?: number; withDate?: boolean } = {},
): Promise<Buffer> {
  const width = options.width ?? 3000;
  const height = options.height ?? 2000;
  const half = Math.floor(width / 2);
  const red = await sharp({
    create: { width: half, height, channels: 3, background: '#ff0000' },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, background: '#0000ff' } })
    .composite([{ input: red, left: 0, top: 0 }])
    .withExif({
      IFD0: { Make: 'TestCam', Model: 'X1' },
      IFD2:
        options.withDate === false
          ? {}
          : { DateTimeOriginal: '2026:10:20 08:30:00', OffsetTimeOriginal: '+07:00' },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '13/1 45/1 0/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '100/1 30/1 0/1',
      },
    })
    .withMetadata({ orientation: options.orientation ?? 6 })
    .jpeg({ quality: 90 })
    .toBuffer();
}

export function pngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 4, background: '#00ff0080' } })
    .png()
    .toBuffer();
}

export const ffmpegAvailable =
  spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0;

/**
 * A 2 s 1280×720 H.264 + AAC MP4 with a rotation of 90° (displayed 720×1280), a creation time and
 * a location tag. Needs ffmpeg.
 */
export async function sampleVideo(dir: string): Promise<Buffer> {
  const plain = join(dir, 'plain.mp4');
  const out = join(dir, 'sample.mp4');
  const ffmpeg = (args: string[]) => {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr.toString()}`);
  };
  ffmpeg([
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=1280x720:rate=25:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    '-metadata',
    'creation_time=2026-10-20T01:30:00Z',
    '-metadata',
    'location=+13.7563+100.5018/',
    plain,
  ]);
  // Phones store portrait video as landscape frames plus a display matrix.
  ffmpeg(['-display_rotation:v:0', '-90', '-i', plain, '-c', 'copy', '-map_metadata', '0', out]);
  return readFile(out);
}
