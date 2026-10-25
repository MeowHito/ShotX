import { describe, expect, it } from 'vitest';
import {
  availableDriveName,
  driveNameKey,
  driveNameSchema,
  numberedDriveName,
  relativePathSchema,
} from './names';

const utf8 = (s: string) => new TextEncoder().encode(s).length;

describe('driveNameSchema', () => {
  it('normalizes to NFC and trims', () => {
    // "é" as e + combining acute.
    expect(driveNameSchema.parse('  Café 2026  ')).toBe('Café 2026');
    expect(driveNameSchema.parse('งานวิ่ง 2026')).toBe('งานวิ่ง 2026');
  });

  it.each([
    ['empty', ''],
    ['only spaces', '   '],
    ['a slash', 'a/b'],
    ['a backslash', 'a\\b'],
    ['a control character', 'a\u0000b'],
    ['a newline', 'a\nb'],
    ['a bidi override', 'photo‮gpj.exe'],
    ['a lone surrogate', 'a\uD800'],
    ['.', '.'],
    ['..', '..'],
    ['over 255 bytes', 'ก'.repeat(86)],
  ])('rejects %s', (_label, name) => {
    expect(driveNameSchema.safeParse(name).success).toBe(false);
  });

  it('accepts 255 bytes and zero-width spaces (Thai text often has them)', () => {
    expect(driveNameSchema.safeParse('ก'.repeat(85)).success).toBe(true);
    expect(driveNameSchema.safeParse('งาน​วิ่ง').success).toBe(true);
  });
});

describe('driveNameKey', () => {
  it('folds ASCII letters only, like lower(name COLLATE "C")', () => {
    expect(driveNameKey('IMG_0001.JPG')).toBe('img_0001.jpg');
    expect(driveNameKey('ÄbC')).toBe('Äbc');
    expect(driveNameKey('งานวิ่ง')).toBe('งานวิ่ง');
  });
});

describe('availableDriveName', () => {
  const taken = (...names: string[]) => {
    const keys = new Set(names.map(driveNameKey));
    return (key: string) => keys.has(key);
  };

  it('keeps a free name', () => {
    expect(availableDriveName('a.jpg', 'file', taken('b.jpg'))).toBe('a.jpg');
  });

  it('numbers files before the extension and folders at the end, ignoring ASCII case', () => {
    expect(availableDriveName('IMG.JPG', 'file', taken('img.jpg'))).toBe('IMG (2).JPG');
    expect(availableDriveName('a.jpg', 'file', taken('a.jpg', 'A (2).JPG'))).toBe('a (3).jpg');
    expect(availableDriveName('Day 1.5', 'folder', taken('day 1.5'))).toBe('Day 1.5 (2)');
  });

  it('stays within 255 bytes', () => {
    const long = `${'ก'.repeat(83)}.jpg`;
    const name = numberedDriveName(long, 'file', 10);
    expect(utf8(name)).toBeLessThanOrEqual(255);
    expect(name.endsWith(' (10).jpg')).toBe(true);
    expect(driveNameSchema.safeParse(name).success).toBe(true);
  });

  it('gives up eventually', () => {
    expect(() => availableDriveName('a', 'folder', () => true)).toThrow(RangeError);
  });
});

describe('relativePathSchema', () => {
  it('parses to normalized folder names', () => {
    expect(relativePathSchema.parse('Event/ Day 1 /Café')).toEqual(['Event', 'Day 1', 'Café']);
    expect(relativePathSchema.parse('งานวิ่ง')).toEqual(['งานวิ่ง']);
  });

  it.each(['', '/Event', 'Event/', 'a//b', 'a/../b', 'a\\b/c'])('rejects %j', (path) => {
    expect(relativePathSchema.safeParse(path).success).toBe(false);
  });
});
