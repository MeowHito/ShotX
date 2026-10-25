import { describe, expect, it } from 'vitest';
import {
  decodeS3EventKey,
  DERIVED_VARIANTS,
  derivedKey,
  derivedKeys,
  derivedPrefix,
  INDEX_IMAGE_FULL,
  indexImageKey,
  indexImagePrefix,
  indexTilePart,
  isSafeKeySegment,
  isSafeOriginalName,
  ORIGINAL_NAME_MAX_BYTES,
  originalKey,
  originalsPrefix,
  parseS3Key,
  S3_PREFIXES,
  sanitizeOriginalName,
  zipKey,
} from './s3-keys';

const photographerId = '0195f3a2-7c1e-7d4a-9b2f-3c4d5e6f7a8b';
const fileId = '0195f3a2-8d2f-7e5b-8c3a-4d5e6f7a8b9c';
const ids = { photographerId, fileId };
const utf8Length = (s: string) => new TextEncoder().encode(s).length;

describe('key builders', () => {
  it('builds originals keys', () => {
    expect(originalKey({ ...ids, originalName: 'IMG_0001.JPG' })).toBe(
      `originals/${photographerId}/${fileId}/IMG_0001.JPG`,
    );
    expect(originalKey({ ...ids, originalName: 'งานวิ่ง 2026.jpg' })).toBe(
      `originals/${photographerId}/${fileId}/งานวิ่ง 2026.jpg`,
    );
  });

  it('builds every derived key', () => {
    expect(derivedKeys(ids)).toEqual({
      thumb: `derived/${photographerId}/${fileId}/thumb.webp`,
      preview: `derived/${photographerId}/${fileId}/preview.webp`,
      web: `derived/${photographerId}/${fileId}/web.jpg`,
      poster: `derived/${photographerId}/${fileId}/poster.jpg`,
      videoPreview: `derived/${photographerId}/${fileId}/preview.mp4`,
    });
    expect(derivedKey(ids, 'web')).toBe(`derived/${photographerId}/${fileId}/web.jpg`);
  });

  it('builds prefixes for a photographer or one file', () => {
    expect(originalsPrefix(photographerId)).toBe(`originals/${photographerId}/`);
    expect(originalsPrefix(photographerId, fileId)).toBe(`originals/${photographerId}/${fileId}/`);
    expect(derivedPrefix(photographerId)).toBe(`derived/${photographerId}/`);
    expect(derivedPrefix(photographerId, fileId)).toBe(`derived/${photographerId}/${fileId}/`);
  });

  it('builds zip keys', () => {
    expect(zipKey('0195f3a2-9e3a-7f6c-9d4b-5e6f7a8b9cad')).toBe(
      'tmp/zips/0195f3a2-9e3a-7f6c-9d4b-5e6f7a8b9cad.zip',
    );
  });

  it('builds temporary index image keys per attempt and part (ADR 0004)', () => {
    expect(indexImageKey({ fileId, attemptId: 'a1', part: INDEX_IMAGE_FULL })).toBe(
      `tmp/index/${fileId}/a1/full.jpg`,
    );
    expect(indexImageKey({ fileId, attemptId: 'a1', part: indexTilePart(0) })).toBe(
      `tmp/index/${fileId}/a1/t0.jpg`,
    );
    expect(indexImageKey({ fileId, attemptId: 'a2', part: indexTilePart(3) })).toBe(
      `tmp/index/${fileId}/a2/t3.jpg`,
    );
    expect(indexImagePrefix(fileId)).toBe(`tmp/index/${fileId}/`);
    expect(indexImagePrefix(fileId, 'a1')).toBe(`tmp/index/${fileId}/a1/`);
  });

  it('gives concurrent attempts for one file different keys', () => {
    const a = indexImageKey({ fileId, attemptId: 'attempt-a', part: 'full' });
    const b = indexImageKey({ fileId, attemptId: 'attempt-b', part: 'full' });
    expect(a).not.toBe(b);
  });

  it('keeps every key under its spec prefix', () => {
    expect(originalKey({ ...ids, originalName: 'a.jpg' }).startsWith(S3_PREFIXES.originals)).toBe(
      true,
    );
    for (const v of DERIVED_VARIANTS) {
      expect(derivedKey(ids, v).startsWith(S3_PREFIXES.derived)).toBe(true);
    }
    expect(zipKey('j').startsWith(S3_PREFIXES.tmpZips)).toBe(true);
    expect(
      indexImageKey({ fileId, attemptId: 'a', part: 'full' }).startsWith(S3_PREFIXES.tmpIndex),
    ).toBe(true);
    expect(S3_PREFIXES.tmpZips.startsWith(S3_PREFIXES.tmp)).toBe(true);
    expect(S3_PREFIXES.tmpIndex.startsWith(S3_PREFIXES.tmp)).toBe(true);
  });
});

describe('id validation', () => {
  it.each(['', '.', '..', 'a/b', 'a b', 'a.b', '../x', 'x\u0000', 'ü', 'a'.repeat(129), '%2e%2e'])(
    'rejects %j as an id',
    (bad) => {
      expect(isSafeKeySegment(bad)).toBe(false);
      expect(() => originalKey({ photographerId: bad, fileId, originalName: 'a.jpg' })).toThrow(
        RangeError,
      );
      expect(() => originalKey({ photographerId, fileId: bad, originalName: 'a.jpg' })).toThrow(
        RangeError,
      );
      expect(() => derivedKey({ photographerId: bad, fileId }, 'thumb')).toThrow(RangeError);
      expect(() => zipKey(bad)).toThrow(RangeError);
      expect(() => indexImageKey({ fileId: bad, attemptId: 'a', part: 'full' })).toThrow(
        RangeError,
      );
      expect(() => indexImageKey({ fileId, attemptId: bad, part: 'full' })).toThrow(RangeError);
      expect(() => originalsPrefix(bad)).toThrow(RangeError);
    },
  );

  it('accepts uuids and other [A-Za-z0-9_-] ids up to 128 characters', () => {
    for (const id of [photographerId, 'abc_DEF-123', 'a'.repeat(128)]) {
      expect(isSafeKeySegment(id)).toBe(true);
    }
  });

  it('rejects unknown derived variants and bad index parts', () => {
    // @ts-expect-error: not a variant
    expect(() => derivedKey(ids, 'original')).toThrow(/Unknown derived variant/);
    // @ts-expect-error: not a part
    expect(() => indexImageKey({ fileId, attemptId: 'a', part: 'tile1' })).toThrow(RangeError);
    expect(() => indexImageKey({ fileId, attemptId: 'a', part: 't01' })).toThrow(RangeError);
    expect(() => indexImageKey({ fileId, attemptId: 'a', part: 't-1' })).toThrow(RangeError);
    for (const bad of [-1, 1.5, 1000, Number.NaN]) {
      expect(() => indexTilePart(bad)).toThrow(RangeError);
    }
    expect(indexTilePart(999)).toBe('t999');
  });
});

describe('original names', () => {
  it.each([
    ['IMG_0001.JPG', 'IMG_0001.JPG'],
    ['งานวิ่ง 2026.jpg', 'งานวิ่ง 2026.jpg'],
    ['../../etc/passwd', '_._etc_passwd'],
    ['..\\..\\windows\\win.ini', '_._windows_win.ini'],
    ['a/b/c.jpg', 'a_b_c.jpg'],
    ['photo..jpg', 'photo.jpg'],
    ['...hidden.png', 'hidden.png'],
    ['name.jpg.', 'name.jpg'],
    ['  spaced   out \t name .jpg  ', 'spaced out name .jpg'],
    ['a\u0000b\u0007c\u007f.jpg', 'abc.jpg'],
    ['photo‮gpj.exe', 'photogpj.exe'],
    ['zero​width﻿.jpg', 'zerowidth.jpg'],
    ['line break.jpg', 'linebreak.jpg'],
    ['lone\uD800surrogate.jpg', 'lonesurrogate.jpg'],
    ['emoji 😀.jpg', 'emoji 😀.jpg'],
    ['q?a#b%c.jpg', 'q_a_b_c.jpg'],
    ['{x}^[y]~`z`"<>|.jpg', '_x___y___z_____.jpg'],
    ['é.jpg', 'é.jpg'],
    ['e‍́.jpg', 'é.jpg'],
    ['`.jpg', '_.jpg'],
    ['', 'file'],
    ['   ', 'file'],
    ['.', 'file'],
    ['..', 'file'],
    ['‮', 'file'],
  ])('sanitizes %j to %j', (raw, expected) => {
    const name = sanitizeOriginalName(raw);
    expect(name).toBe(expected);
    expect(isSafeOriginalName(name)).toBe(true);
    expect(name).not.toMatch(/[/\\]|\.\.|\p{Cc}/u);
  });

  it('truncates long names to 255 UTF-8 bytes and keeps the extension', () => {
    const ascii = sanitizeOriginalName(`${'a'.repeat(300)}.jpeg`);
    expect(utf8Length(ascii)).toBe(ORIGINAL_NAME_MAX_BYTES);
    expect(ascii.endsWith('a.jpeg')).toBe(true);

    // Thai is 3 bytes per code point; truncation must not split one.
    const thai = sanitizeOriginalName(`${'ก'.repeat(200)}.jpg`);
    expect(utf8Length(thai)).toBeLessThanOrEqual(ORIGINAL_NAME_MAX_BYTES);
    expect(thai).toBe(`${'ก'.repeat(83)}.jpg`);

    // Surrogate pairs are never split.
    const emoji = sanitizeOriginalName(`${'😀'.repeat(100)}.png`);
    expect(utf8Length(emoji)).toBeLessThanOrEqual(ORIGINAL_NAME_MAX_BYTES);
    expect(emoji).toBe(`${'😀'.repeat(62)}.png`);
    expect(isSafeOriginalName(emoji)).toBe(true);

    // No extension: plain truncation.
    expect(sanitizeOriginalName('b'.repeat(400))).toBe('b'.repeat(255));
  });

  it('is idempotent on arbitrary input', () => {
    // Deterministic pseudo-random strings drawn from tricky code points.
    const pool = [
      'a',
      'Z',
      '0',
      '.',
      '/',
      '\\',
      ' ',
      '\t',
      '\u0000',
      '\u007f',
      ' ',
      '́',
      '‍',
      '‮',
      ' ',
      '\ud800',
      '\udc00',
      '😀',
      'ก',
      '่',
      '`',
      '?',
      '#',
      '%',
      '~',
      '<',
      '̸',
      'e',
      '　',
    ];
    let seed = 42;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31);
    for (let i = 0; i < 2000; i++) {
      const length = next() % 40;
      let raw = '';
      for (let j = 0; j < length; j++) raw += pool[next() % pool.length];
      const once = sanitizeOriginalName(raw);
      expect(sanitizeOriginalName(once)).toBe(once);
      expect(isSafeOriginalName(once)).toBe(true);
      expect(() => originalKey({ ...ids, originalName: once })).not.toThrow();
    }
  });

  it('refuses unsanitized names in originalKey', () => {
    for (const bad of ['', '.', '..', 'a/b.jpg', '../a.jpg', 'a\u0000.jpg', 'a..b.jpg', 'é']) {
      expect(isSafeOriginalName(bad)).toBe(false);
      expect(() => originalKey({ ...ids, originalName: bad })).toThrow(/sanitizeOriginalName/);
    }
  });
});

describe('parseS3Key', () => {
  it('round-trips every key kind', () => {
    const original = originalKey({ ...ids, originalName: 'งานวิ่ง 2026.jpg' });
    expect(parseS3Key(original)).toEqual({
      kind: 'original',
      photographerId,
      fileId,
      originalName: 'งานวิ่ง 2026.jpg',
    });
    for (const variant of DERIVED_VARIANTS) {
      expect(parseS3Key(derivedKey(ids, variant))).toEqual({
        kind: 'derived',
        photographerId,
        fileId,
        variant,
      });
    }
    expect(parseS3Key(indexImageKey({ fileId, attemptId: 'a1', part: 't2' }))).toEqual({
      kind: 'index',
      fileId,
      attemptId: 'a1',
      part: 't2',
    });
    expect(parseS3Key(indexImageKey({ fileId, attemptId: 'a1', part: 'full' }))).toMatchObject({
      part: 'full',
    });
    expect(parseS3Key(zipKey('job-1'))).toEqual({ kind: 'zip', jobId: 'job-1' });
  });

  it.each([
    '',
    'originals/',
    `originals/${photographerId}/${fileId}`,
    `originals/${photographerId}/${fileId}/`,
    `originals/${photographerId}/${fileId}/a/b.jpg`,
    `originals/${photographerId}/${fileId}/..`,
    `originals/../${fileId}/a.jpg`,
    `originals/${photographerId}/${fileId}/a\u0000.jpg`,
    `derived/${photographerId}/${fileId}/original.jpg`,
    `derived/${photographerId}/${fileId}/thumb.webp/x`,
    `tmp/index/${fileId}.jpg`,
    `tmp/index/${fileId}/a1/tile.jpg`,
    `tmp/index/${fileId}/a1/full.png`,
    'tmp/zips/job.tar',
    'tmp/zips/../x.zip',
    `other/${photographerId}/${fileId}/a.jpg`,
  ])('returns null for %j', (key) => {
    expect(parseS3Key(key)).toBeNull();
  });
});

describe('decodeS3EventKey', () => {
  it('decodes form-style URL encoding as S3 events use it', () => {
    expect(decodeS3EventKey('originals/p/f/IMG+0001+%281%29.jpg')).toBe(
      'originals/p/f/IMG 0001 (1).jpg',
    );
    expect(decodeS3EventKey('originals/p/f/a%2Bb.jpg')).toBe('originals/p/f/a+b.jpg');
    expect(
      decodeS3EventKey(
        'originals/p/f/%E0%B8%87%E0%B8%B2%E0%B8%99%E0%B8%A7%E0%B8%B4%E0%B9%88%E0%B8%87+2026.jpg',
      ),
    ).toBe('originals/p/f/งานวิ่ง 2026.jpg');
  });

  it('rejects malformed encoding', () => {
    expect(() => decodeS3EventKey('originals/p/f/%E0%B8.jpg')).toThrow(RangeError);
    expect(() => decodeS3EventKey('originals/p/f/%zz.jpg')).toThrow(RangeError);
  });
});
