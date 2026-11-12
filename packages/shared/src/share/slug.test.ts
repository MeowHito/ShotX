import { describe, expect, it } from 'vitest';
import {
  generateShareSlugSuffix,
  isShareSlug,
  normalizeShareSlug,
  parseShareRef,
  SHARE_SLUG_BASE_MAX_LENGTH,
  SHARE_SLUG_FALLBACK,
  SHARE_SLUG_MAX_ATTEMPTS,
  SHARE_SLUG_MAX_LENGTH,
  SHARE_SLUG_SUFFIX_LENGTH,
  shareFaceDeletionPagePath,
  sharePublicPath,
  sharePublicUrl,
  shareRefOf,
  shareRefPath,
  shareSlugCandidate,
  shareSlugSchema,
  shareSlugSourceName,
  slugifyEventName,
  withShareSlugSuffix,
} from './slug';
import { generateShareToken, isShareToken } from './token';

const codePoints = (s: string) => [...s].length;
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';

/** Deterministic "random" bytes: 0, 1, 2, ... (mod 256). */
const counting = () => {
  let next = 0;
  return (length: number) => Uint8Array.from({ length }, () => next++ % 256);
};

describe('slugifyEventName', () => {
  it('lowercases English and turns spaces and punctuation into single dashes', () => {
    expect(slugifyEventName('Bangkok Marathon 2026!')).toBe('bangkok-marathon-2026');
    expect(slugifyEventName('  --Run / Walk & Fun__Day--  ')).toBe('run-walk-fun-day');
    expect(slugifyEventName("Tom's  B-Day (2026)")).toBe('tom-s-b-day-2026');
    expect(slugifyEventName('Café Crème')).toBe('café-crème');
  });

  it('keeps Thai letters with their vowels and tone marks, and Thai digits', () => {
    expect(slugifyEventName('งานวิ่ง กรุงเทพ 2026')).toBe('งานวิ่ง-กรุงเทพ-2026');
    expect(slugifyEventName('รับปริญญา ม.เกษตร ๒๕๖๙')).toBe('รับปริญญา-ม-เกษตร-๒๕๖๙');
    expect(slugifyEventName('ทดสอบ')).toBe('ทดสอบ');
  });

  it('keeps Chinese and drops full-width punctuation', () => {
    expect(slugifyEventName('曼谷马拉松，2026年')).toBe('曼谷马拉松-2026年');
    expect(slugifyEventName('婚礼 · 小王&小李')).toBe('婚礼-小王-小李');
  });

  it('drops emoji, including keycaps, skin tones, ZWJ sequences and variation selectors', () => {
    expect(slugifyEventName('🎉 Party 🎉')).toBe('party');
    expect(slugifyEventName('Run 1️⃣ 👍🏽 👨‍👩‍👧 ❤️ day')).toBe('run-1-day');
    expect(slugifyEventName('งาน🎉วัด')).toBe('งาน-วัด');
  });

  it('falls back to "event" when nothing is left', () => {
    for (const name of ['', '   ', '🎉🎉', '!!!', '---', '่้', '🇹🇭']) {
      expect(slugifyEventName(name), JSON.stringify(name)).toBe(SHARE_SLUG_FALLBACK);
    }
  });

  it('drops combining marks left without a base character', () => {
    // A tone mark right after punctuation has no consonant to sit on.
    expect(slugifyEventName('(่)งาน')).toBe('งาน');
  });

  it('is NFC and lowercase however the name was typed', () => {
    const decomposed = 'Café';
    expect(slugifyEventName(decomposed)).toBe('café');
    expect(slugifyEventName('İSTANBUL')).toBe(slugifyEventName('İSTANBUL'.normalize('NFD')));
    expect(isShareSlug(slugifyEventName('İSTANBUL'))).toBe(true);
  });

  it('cuts long names at SHARE_SLUG_BASE_MAX_LENGTH code points, between graphemes', () => {
    const words = slugifyEventName('word '.repeat(30));
    expect(codePoints(words)).toBeLessThanOrEqual(SHARE_SLUG_BASE_MAX_LENGTH);
    expect(words.endsWith('-')).toBe(false);
    expect(words.split('-').every((w) => w === 'word')).toBe(true);

    // Thai without spaces: each grapheme is a consonant with up to two marks.
    const thai = slugifyEventName('กี่'.repeat(40));
    expect(codePoints(thai)).toBeLessThanOrEqual(SHARE_SLUG_BASE_MAX_LENGTH);
    expect(thai).toBe('กี่'.repeat(20));

    const long = slugifyEventName('a'.repeat(200));
    expect(long).toBe('a'.repeat(SHARE_SLUG_BASE_MAX_LENGTH));
  });

  it('may return a token-shaped base, which then always gets a suffix', () => {
    const base = slugifyEventName('ABCDEFGHIJKLMNOPQRSTUV');
    expect(base).toBe('abcdefghijklmnopqrstuv');
    expect(isShareToken(base)).toBe(true);
    expect(isShareSlug(base)).toBe(false);
    const slug = shareSlugCandidate(base, 0, counting());
    expect(slug).toMatch(/^abcdefghijklmnopqrstuv-[0-9a-z]{6}$/);
    expect(isShareSlug(slug)).toBe(true);
  });

  it('always returns a value that is a slug or a token-shaped base', () => {
    for (const name of [
      'x',
      'Event 1',
      'งาน',
      '中文',
      '🎉',
      'a-b',
      'A'.repeat(22),
      '1'.repeat(80),
    ]) {
      const base = slugifyEventName(name);
      expect(isShareSlug(base) || isShareToken(base), name).toBe(true);
    }
  });
});

describe('shareSlugSourceName', () => {
  it('drops the extension of a file name and keeps folder names whole', () => {
    expect(shareSlugSourceName('file', 'IMG_1234.JPG')).toBe('IMG_1234');
    expect(shareSlugSourceName('file', 'wedding.final.jpeg')).toBe('wedding.final');
    expect(shareSlugSourceName('file', '.jpg')).toBe('.jpg');
    expect(shareSlugSourceName('folder', 'Run 2026.11')).toBe('Run 2026.11');
  });
});

describe('suffixes and candidates', () => {
  it('generates SHARE_SLUG_SUFFIX_LENGTH lowercase base36 characters', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateShareSlugSuffix()).toMatch(
        new RegExp(`^[0-9a-z]{${SHARE_SLUG_SUFFIX_LENGTH}}$`),
      );
    }
    expect(generateShareSlugSuffix(counting())).toBe('012345');
  });

  it('rejects bytes that would bias the alphabet', () => {
    // 252..255 are skipped; 36 maps to '0' again.
    const bytes = [252, 253, 254, 255, 36, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    expect(generateShareSlugSuffix(() => Uint8Array.from(bytes))).toBe('012345');
    // A source that first yields only rejected bytes is read again.
    let calls = 0;
    const lateRandom = (length: number) => {
      calls++;
      return Uint8Array.from({ length }, (_, i) => (calls === 1 ? 255 : i + 10));
    };
    expect(generateShareSlugSuffix(lateRandom)).toBe('abcdef');
    expect(calls).toBe(2);
  });

  it('tries the base first, then suffixed candidates', () => {
    expect(shareSlugCandidate('bangkok-run', 0)).toBe('bangkok-run');
    const next = shareSlugCandidate('bangkok-run', 1, counting());
    expect(next).toBe('bangkok-run-012345');
    expect(codePoints(next)).toBeLessThanOrEqual(SHARE_SLUG_MAX_LENGTH);
    expect(() => shareSlugCandidate('bangkok-run', SHARE_SLUG_MAX_ATTEMPTS)).toThrow(RangeError);
    expect(() => shareSlugCandidate('bangkok-run', -1)).toThrow(RangeError);
  });

  it('keeps the longest base with its suffix within SHARE_SLUG_MAX_LENGTH', () => {
    const base = slugifyEventName('ก'.repeat(100));
    const slug = withShareSlugSuffix(base, 'zz0000');
    expect(codePoints(slug)).toBe(SHARE_SLUG_MAX_LENGTH);
    expect(isShareSlug(slug)).toBe(true);
  });

  it('refuses a malformed suffix or base', () => {
    expect(() => withShareSlugSuffix('event', 'ABCDEF')).toThrow(RangeError);
    expect(() => withShareSlugSuffix('event', 'abc')).toThrow(RangeError);
    expect(() => withShareSlugSuffix('Bad Base', 'abcdef')).toThrow(RangeError);
  });
});

describe('isShareSlug and shareSlugSchema', () => {
  it('accepts canonical slugs only', () => {
    for (const slug of ['event', 'bangkok-run-2026', 'งานวิ่ง-กรุงเทพ', '曼谷-2026', 'a']) {
      expect(isShareSlug(slug), slug).toBe(true);
      expect(shareSlugSchema.safeParse(slug).success).toBe(true);
    }
    for (const bad of [
      '',
      'Bangkok',
      '-run',
      'run-',
      'run--day',
      'run day',
      'run/day',
      'run.day',
      'run%20day',
      '🎉',
      'Café',
      'a'.repeat(SHARE_SLUG_MAX_LENGTH + 1),
      TOKEN.toLowerCase(),
    ]) {
      expect(isShareSlug(bad), bad).toBe(false);
    }
  });
});

describe('parseShareRef', () => {
  it('reads token-shaped refs as tokens, case-sensitive', () => {
    expect(parseShareRef(TOKEN)).toEqual({ kind: 'token', token: TOKEN });
    const token = generateShareToken();
    expect(parseShareRef(token)).toEqual({ kind: 'token', token });
  });

  it('reads everything else as a slug, case-insensitively and in NFC', () => {
    expect(parseShareRef('bangkok-run')).toEqual({ kind: 'slug', slug: 'bangkok-run' });
    expect(parseShareRef('Bangkok-Run')).toEqual({ kind: 'slug', slug: 'bangkok-run' });
    expect(parseShareRef('Café-day')).toEqual({ kind: 'slug', slug: 'café-day' });
    expect(parseShareRef('งานวิ่ง-2026')).toEqual({ kind: 'slug', slug: 'งานวิ่ง-2026' });
  });

  it('decodes a ref that is still percent-encoded', () => {
    const encoded = encodeURIComponent('งานวิ่ง-2026');
    expect(parseShareRef(encoded)).toEqual({ kind: 'slug', slug: 'งานวิ่ง-2026' });
    expect(parseShareRef('%E0%B8')).toBeNull();
    expect(parseShareRef('%zz')).toBeNull();
  });

  it('answers null (NOT_FOUND) for anything that is neither', () => {
    for (const bad of ['', 'has space', 'a/b', '../etc', '-x', 'x'.repeat(500), '🎉', 'run--x']) {
      expect(parseShareRef(bad), bad).toBeNull();
    }
    expect(normalizeShareSlug('x'.repeat(5000))).toBeNull();
  });

  it('never reads one value as both a token and a slug', () => {
    for (const name of ['A'.repeat(22), 'abcdefghijklmnopqrstuv', 'Event']) {
      const slug = shareSlugCandidate(slugifyEventName(name), 0, counting());
      expect(parseShareRef(slug)?.kind, name).toBe('slug');
    }
  });
});

describe('paths and URLs', () => {
  it('links by slug when there is one, by token otherwise', () => {
    expect(shareRefOf({ slug: 'bangkok-run', token: TOKEN })).toBe('bangkok-run');
    expect(shareRefOf({ slug: null, token: TOKEN })).toBe(TOKEN);
    expect(sharePublicPath({ slug: null, token: TOKEN })).toBe(`/s/${TOKEN}`);
    expect(sharePublicPath({ slug: 'งาน-2026', token: TOKEN })).toBe(
      `/s/${encodeURIComponent('งาน-2026')}`,
    );
    expect(sharePublicUrl('https://snap.example.com/', { slug: 'bangkok-run', token: TOKEN })).toBe(
      'https://snap.example.com/s/bangkok-run',
    );
  });

  it('round-trips an encoded path through parseShareRef', () => {
    const slug = 'รับปริญญา-2026';
    const ref = sharePublicPath({ slug, token: TOKEN }).slice('/s/'.length);
    expect(parseShareRef(ref)).toEqual({ kind: 'slug', slug });
  });

  it('builds the unlinked delete-my-face path and refuses non-refs', () => {
    expect(shareFaceDeletionPagePath('bangkok-run')).toBe('/s/bangkok-run/delete-my-face');
    expect(shareFaceDeletionPagePath(TOKEN)).toBe(`/s/${TOKEN}/delete-my-face`);
    expect(() => shareRefPath('../x')).toThrow(RangeError);
    expect(() => shareRefPath('Bangkok')).toThrow(RangeError);
  });
});
