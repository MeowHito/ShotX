import { describe, expect, it } from 'vitest';
import { normalizeWatermark } from './store';
import {
  alphaBounds,
  frameFor,
  jpegExifSegment,
  uprightExif,
  watermarkBox,
  withExifSegment,
} from './watermark';

const settings = { position: 'bottom-right', sizePercent: 20, marginPercent: 3 } as const;

describe('watermarkBox (ADR 0021)', () => {
  it('sizes by the shorter side and keeps the margin from the chosen corner', () => {
    // 6000×4000 landscape, a 2:1 mark: 20% of 4000 = 800 wide, 400 high, 120 px margin.
    expect(
      watermarkBox({ width: 6000, height: 4000 }, { width: 200, height: 100 }, settings),
    ).toEqual({ x: 6000 - 800 - 120, y: 4000 - 400 - 120, width: 800, height: 400 });
    // The same mark on a portrait photo is just as big.
    expect(
      watermarkBox({ width: 4000, height: 6000 }, { width: 200, height: 100 }, settings).width,
    ).toBe(800);
  });

  it('places all nine positions', () => {
    const photo = { width: 1000, height: 1000 };
    const mark = { width: 100, height: 100 };
    const at = (position: (typeof settings)['position'] | 'top-left' | 'center' | 'top' | 'left') =>
      watermarkBox(photo, mark, { position, sizePercent: 10, marginPercent: 5 });
    expect(at('top-left')).toMatchObject({ x: 50, y: 50 });
    expect(at('top')).toMatchObject({ x: 450, y: 50 });
    expect(at('left')).toMatchObject({ x: 50, y: 450 });
    expect(at('center')).toMatchObject({ x: 450, y: 450 });
    expect(at('bottom-right')).toMatchObject({ x: 850, y: 850 });
  });

  it('never makes the mark bigger than the photo', () => {
    // A very wide mark at 60% of a tall photo's short side is scaled down to fit.
    const box = watermarkBox(
      { width: 100, height: 1000 },
      { width: 1000, height: 10 },
      { position: 'center', sizePercent: 60, marginPercent: 0 },
    );
    expect(box.width).toBeLessThanOrEqual(100);
    expect(box.x).toBeGreaterThanOrEqual(0);
  });
});

/** A minimal JPEG: SOI, an EXIF APP1 (big- or little-endian) with Orientation and an IFD1 link, EOI. */
function jpegWithExif(little: boolean, orientation = 6): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => (little ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const u32 = (v: number) =>
    little
      ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24]
      : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
  // IFD0: 2 entries (Orientation, Make), then the next-IFD offset (IFD1 at 100).
  tiff.push(...u16(2));
  tiff.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(orientation), 0, 0);
  tiff.push(...u16(0x010f), ...u16(2), ...u32(4), ...[0x53, 0x6e, 0x61, 0x70]);
  tiff.push(...u32(100));
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const length = payload.length + 2;
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe1,
    length >> 8,
    length & 0xff,
    ...payload,
    0xff,
    0xd9,
  ]);
}

function orientationOf(segment: Uint8Array, little: boolean): number {
  const view = new DataView(segment.buffer, segment.byteOffset);
  return view.getUint16(10 + 8 + 2 + 8, little);
}

function nextIfdOf(segment: Uint8Array, little: boolean): number {
  const view = new DataView(segment.buffer, segment.byteOffset);
  return view.getUint32(10 + 8 + 2 + 2 * 12, little);
}

describe('JPEG EXIF (ADR 0021)', () => {
  for (const little of [true, false]) {
    it(`keeps the EXIF, upright and without the thumbnail link (${little ? 'II' : 'MM'})`, () => {
      const original = jpegWithExif(little);
      const segment = jpegExifSegment(original);
      expect(segment).not.toBeNull();
      expect(orientationOf(segment as Uint8Array, little)).toBe(6);
      expect(nextIfdOf(segment as Uint8Array, little)).toBe(100);

      const upright = uprightExif(segment as Uint8Array);
      expect(orientationOf(upright, little)).toBe(1);
      expect(nextIfdOf(upright, little)).toBe(0);
      // The rest (Make = "Snap") is untouched, and the input wasn't modified.
      expect(new TextDecoder().decode(upright.slice(-8, -4))).toBe('Snap');
      expect(orientationOf(segment as Uint8Array, little)).toBe(6);
    });
  }

  it('inserts the segment after the encoder’s JFIF header', () => {
    const jfif = [0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46];
    const encoded = new Uint8Array([0xff, 0xd8, ...jfif, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
    const segment = jpegExifSegment(jpegWithExif(true)) as Uint8Array;
    const out = withExifSegment(encoded, segment);
    expect([...out.slice(0, 2 + jfif.length)]).toEqual([0xff, 0xd8, ...jfif]);
    expect(jpegExifSegment(out)).toEqual(segment);
    expect([...out.slice(-6)]).toEqual([0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
  });

  it('finds no EXIF in a JPEG without one, or in something else', () => {
    expect(jpegExifSegment(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull();
    expect(jpegExifSegment(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe('logo trim and frames (ADR 0022)', () => {
  /** RGBA pixels, transparent except the listed [x, y]. */
  function pixels(width: number, height: number, opaque: [number, number][]): Uint8ClampedArray {
    const data = new Uint8ClampedArray(width * height * 4);
    for (const [x, y] of opaque) data[(y * width + x) * 4 + 3] = 255;
    return data;
  }

  it('finds the visible part of a logo with a transparent border', () => {
    expect(
      alphaBounds(
        pixels(10, 8, [
          [2, 3],
          [6, 5],
        ]),
        10,
        8,
      ),
    ).toEqual({
      x: 2,
      y: 3,
      width: 5,
      height: 3,
    });
    // Nothing visible: nothing to trim to.
    expect(alphaBounds(pixels(4, 4, []), 4, 4)).toBeNull();
    // Nearly transparent pixels (anti-aliasing haze) don't count.
    const haze = pixels(4, 4, [[1, 1]]);
    haze[3] = 5;
    expect(alphaBounds(haze, 4, 4)).toEqual({ x: 1, y: 1, width: 1, height: 1 });
  });

  it('picks the frame by the photo orientation, none when that one is missing', () => {
    const frames = { landscape: 'L', portrait: 'P' };
    expect(frameFor({ width: 6000, height: 4000 }, frames)).toBe('L');
    expect(frameFor({ width: 4000, height: 6000 }, frames)).toBe('P');
    expect(frameFor({ width: 3000, height: 3000 }, frames)).toBe('L');
    expect(frameFor({ width: 4000, height: 6000 }, { landscape: 'L', portrait: null })).toBeNull();
  });

  it('reads settings saved before frames existed as the logo mode', () => {
    const image = new Blob(['png'], { type: 'image/png' });
    expect(
      normalizeWatermark({
        enabled: true,
        image,
        position: 'top-left',
        sizePercent: 30,
        opacityPercent: 70,
        marginPercent: 2,
      }),
    ).toEqual({
      enabled: true,
      mode: 'logo',
      image,
      frameLandscape: null,
      framePortrait: null,
      position: 'top-left',
      sizePercent: 30,
      opacityPercent: 70,
      marginPercent: 2,
    });
    expect(normalizeWatermark(undefined)).toBeNull();
  });
});
